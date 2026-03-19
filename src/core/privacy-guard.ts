import {
  LLMProvider,
  LLMMessage,
  LLMTool,
  LLMResponse,
  LLMStreamChunk,
  LoggerInterface,
} from '../types';

// =====================================================
// PrivacyGuard — Sanitizes all data sent to LLM providers
// =====================================================
//
// Problem: AI providers (OpenAI, Anthropic, Google, etc.) store
// requests in logs, use them for training, and may share data.
// We send wallet addresses, token mints, SOL amounts, and trading
// strategies — all sensitive financial data.
//
// Solution: PrivacyGuard wraps any LLMProvider and:
// 1. Replaces real wallet addresses with placeholders (WALLET_001, WALLET_002)
// 2. Replaces token mint addresses with TOKEN_MINT_001, TOKEN_MINT_002
// 3. Optionally masks exact SOL amounts (1.234 SOL → ~1.2 SOL)
// 4. Strips private keys if they accidentally appear
// 5. Replaces RPC endpoints with [RPC_URL]
// 6. Restores real addresses in LLM responses so the system continues to work
// 7. Maintains a per-session mapping table for consistent replacement
//
// AI sees the same structure but fake identifiers → it can still reason
// about "WALLET_001 bought TOKEN_MINT_003" without knowing real addresses.

export interface PrivacyConfig {
  enabled: boolean;
  maskWallets: boolean;        // Replace wallet addresses with WALLET_XXX
  maskTokenMints: boolean;     // Replace token mints with TOKEN_MINT_XXX
  maskAmounts: boolean;        // Round amounts (1.2345 SOL → ~1.2 SOL)
  maskRpcUrls: boolean;        // Replace RPC URLs with [RPC_URL]
  stripPrivateKeys: boolean;   // Remove anything that looks like a private key
  auditLog: boolean;           // Log what was sanitized (without showing real data)
  allowedAddresses?: string[]; // Addresses that should NOT be masked (e.g. program IDs)
}

const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  enabled: true,
  maskWallets: true,
  maskTokenMints: true,
  maskAmounts: false,          // off by default — AI needs amounts for trading decisions
  maskRpcUrls: true,
  stripPrivateKeys: true,
  auditLog: false,
  allowedAddresses: [
    '11111111111111111111111111111111',          // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',  // ATA Program
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // Jupiter
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM (legacy)
    'PumpFunAMMVyBmGAKgG3ksqyzVPBaQ5MqMk5MtKoFPu',   // Pump.fun AMM (graduated tokens)
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',   // Pump.fun Bonding Curve Program
  ],
};

// Solana address pattern: base58, 32-44 chars, no 0/O/I/l
const SOLANA_ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// Private key patterns (base58 secret key ~88 chars, or JSON array [n,n,...])
const PRIVATE_KEY_RE = /\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/g;
const JSON_KEY_RE = /\[(\s*\d{1,3}\s*,\s*){30,}\s*\d{1,3}\s*\]/g;

// RPC URL pattern
const RPC_URL_RE = /https?:\/\/[^\s"']+(?:rpc|solana|helius|quicknode|alchemy|triton|mainnet)[^\s"']*/gi;

// SOL amount pattern: number followed by SOL
const SOL_AMOUNT_RE = /(\d+\.\d{3,})\s*(SOL)/gi;

export class PrivacyGuard implements LLMProvider {
  private inner: LLMProvider;
  private config: PrivacyConfig;
  private logger?: LoggerInterface;

  // Bidirectional mapping: real ↔ placeholder
  private walletMap = new Map<string, string>();     // real → placeholder
  private walletReverseMap = new Map<string, string>(); // placeholder → real
  private walletCounter = 0;

  private mintMap = new Map<string, string>();
  private mintReverseMap = new Map<string, string>();
  private mintCounter = 0;

  private allowedSet: Set<string>;

  // Stats
  private stats = {
    messagesProcessed: 0,
    addressesMasked: 0,
    amountsMasked: 0,
    privateKeysStripped: 0,
    rpcUrlsMasked: 0,
  };

  constructor(inner: LLMProvider, config?: Partial<PrivacyConfig>, logger?: LoggerInterface) {
    this.inner = inner;
    this.config = { ...DEFAULT_PRIVACY_CONFIG, ...config };
    this.logger = logger;
    this.allowedSet = new Set(this.config.allowedAddresses || []);
  }

  // =====================================================
  // LLMProvider interface — wraps inner provider
  // =====================================================

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    if (!this.config.enabled) {
      return this.inner.chat(messages, tools, options);
    }

    const sanitized = messages.map(m => this.sanitizeMessage(m));
    this.stats.messagesProcessed += messages.length;

    if (this.config.auditLog && this.logger) {
      this.logger.debug(`PrivacyGuard: sanitized ${messages.length} messages, ` +
        `${this.walletMap.size} wallets masked, ${this.mintMap.size} mints masked`);
    }

    const response = await this.inner.chat(sanitized, tools, options);
    return this.restoreResponse(response);
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    if (!this.config.enabled) {
      if (!this.inner.stream) throw new Error('Inner provider does not support streaming');
      yield* this.inner.stream(messages, tools, options);
      return;
    }

    if (!this.inner.stream) throw new Error('Inner provider does not support streaming');

    const sanitized = messages.map(m => this.sanitizeMessage(m));
    this.stats.messagesProcessed += messages.length;

    for await (const chunk of this.inner.stream(sanitized, tools, options)) {
      yield this.restoreChunk(chunk);
    }
  }

  // =====================================================
  // Sanitization — outgoing to LLM
  // =====================================================

  private sanitizeMessage(msg: LLMMessage): LLMMessage {
    return {
      ...msg,
      content: this.sanitizeText(msg.content),
      toolCalls: msg.toolCalls?.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: this.sanitizeText(tc.function.arguments),
        },
      })),
    };
  }

  sanitizeText(text: string): string {
    if (!text) return text;
    let result = text;

    // 1. Strip private keys first (highest priority)
    if (this.config.stripPrivateKeys) {
      result = result.replace(PRIVATE_KEY_RE, (match) => {
        // Only strip if it's longer than a normal address (>44 chars = likely a secret key)
        if (match.length > 50) {
          this.stats.privateKeysStripped++;
          return '[PRIVATE_KEY_REMOVED]';
        }
        return match;
      });
      result = result.replace(JSON_KEY_RE, () => {
        this.stats.privateKeysStripped++;
        return '[PRIVATE_KEY_REMOVED]';
      });
    }

    // 2. Mask RPC URLs
    if (this.config.maskRpcUrls) {
      result = result.replace(RPC_URL_RE, () => {
        this.stats.rpcUrlsMasked++;
        return '[RPC_URL]';
      });
    }

    // 3. Mask Solana addresses (wallets + mints)
    if (this.config.maskWallets || this.config.maskTokenMints) {
      result = result.replace(SOLANA_ADDR_RE, (addr) => {
        if (this.allowedSet.has(addr)) return addr;
        return this.getOrCreatePlaceholder(addr);
      });
    }

    // 4. Mask SOL amounts
    if (this.config.maskAmounts) {
      result = result.replace(SOL_AMOUNT_RE, (_match, amount, unit) => {
        const num = parseFloat(amount);
        const rounded = num >= 10 ? `~${Math.round(num)}` :
                        num >= 1 ? `~${num.toFixed(1)}` :
                        `~${num.toFixed(2)}`;
        this.stats.amountsMasked++;
        return `${rounded} ${unit}`;
      });
    }

    return result;
  }

  // =====================================================
  // Restoration — incoming from LLM
  // =====================================================

  private restoreResponse(response: LLMResponse): LLMResponse {
    return {
      ...response,
      content: this.restoreText(response.content),
      toolCalls: response.toolCalls?.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: this.restoreText(tc.function.arguments),
        },
      })),
    };
  }

  private restoreChunk(chunk: LLMStreamChunk): LLMStreamChunk {
    return {
      ...chunk,
      content: chunk.content ? this.restoreText(chunk.content) : chunk.content,
      toolCalls: chunk.toolCalls?.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: this.restoreText(tc.function.arguments),
        },
      })),
    };
  }

  restoreText(text: string): string {
    if (!text) return text;
    let result = text;

    // Restore wallet placeholders → real addresses
    for (const [placeholder, real] of this.walletReverseMap) {
      result = result.split(placeholder).join(real);
    }

    // Restore mint placeholders → real addresses
    for (const [placeholder, real] of this.mintReverseMap) {
      result = result.split(placeholder).join(real);
    }

    return result;
  }

  // =====================================================
  // Address mapping
  // =====================================================

  private getOrCreatePlaceholder(address: string): string {
    // Check if already mapped
    const existingWallet = this.walletMap.get(address);
    if (existingWallet) return existingWallet;

    const existingMint = this.mintMap.get(address);
    if (existingMint) return existingMint;

    // Heuristic: first address seen in a token context is likely a mint
    // All others are wallets. This is imperfect but good enough.
    // The AI only needs consistent identifiers, not perfect categorization.
    const isMint = this.config.maskTokenMints && this.mintCounter < this.walletCounter;

    if (isMint) {
      const placeholder = `TOKEN_MINT_${String(++this.mintCounter).padStart(3, '0')}`;
      this.mintMap.set(address, placeholder);
      this.mintReverseMap.set(placeholder, address);
      this.stats.addressesMasked++;
      return placeholder;
    } else {
      const placeholder = `WALLET_${String(++this.walletCounter).padStart(3, '0')}`;
      this.walletMap.set(address, placeholder);
      this.walletReverseMap.set(placeholder, address);
      this.stats.addressesMasked++;
      return placeholder;
    }
  }

  /**
   * Register an address as a known wallet (e.g., our own wallet).
   * Ensures it always maps to a WALLET_XXX placeholder.
   */
  registerWallet(address: string, label?: string): string {
    const existing = this.walletMap.get(address);
    if (existing) return existing;

    const placeholder = label || `WALLET_${String(++this.walletCounter).padStart(3, '0')}`;
    this.walletMap.set(address, placeholder);
    this.walletReverseMap.set(placeholder, address);
    return placeholder;
  }

  /**
   * Register an address as a known token mint.
   */
  registerMint(address: string, symbol?: string): string {
    const existing = this.mintMap.get(address);
    if (existing) return existing;

    const placeholder = symbol
      ? `MINT_${symbol.toUpperCase()}`
      : `TOKEN_MINT_${String(++this.mintCounter).padStart(3, '0')}`;
    this.mintMap.set(address, placeholder);
    this.mintReverseMap.set(placeholder, address);
    return placeholder;
  }

  // =====================================================
  // Public API
  // =====================================================

  getStats(): typeof this.stats & {
    walletsTracked: number;
    mintsTracked: number;
  } {
    return {
      ...this.stats,
      walletsTracked: this.walletMap.size,
      mintsTracked: this.mintMap.size,
    };
  }

  getConfig(): PrivacyConfig {
    return { ...this.config };
  }

  updateConfig(update: Partial<PrivacyConfig>): void {
    Object.assign(this.config, update);
    if (update.allowedAddresses) {
      this.allowedSet = new Set(update.allowedAddresses);
    }
  }

  /**
   * Get the real address for a placeholder (for debugging).
   */
  resolveplaceholder(placeholder: string): string | undefined {
    return this.walletReverseMap.get(placeholder) || this.mintReverseMap.get(placeholder);
  }

  /**
   * Clear all mappings (e.g., at session start).
   */
  resetMappings(): void {
    this.walletMap.clear();
    this.walletReverseMap.clear();
    this.mintMap.clear();
    this.mintReverseMap.clear();
    this.walletCounter = 0;
    this.mintCounter = 0;
  }

  /**
   * Get the inner (unwrapped) provider.
   */
  getInnerProvider(): LLMProvider {
    return this.inner;
  }
}
