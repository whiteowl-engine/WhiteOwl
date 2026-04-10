import {
  LLMProvider,
  LLMMessage,
  LLMTool,
  LLMResponse,
  LLMStreamChunk,
  LoggerInterface,
} from '../types.ts';

export interface PrivacyConfig {
  enabled: boolean;
  maskWallets: boolean;
  maskTokenMints: boolean;
  maskAmounts: boolean;
  maskRpcUrls: boolean;
  stripPrivateKeys: boolean;
  auditLog: boolean;
  allowedAddresses?: string[];
}

const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  enabled: true,
  maskWallets: true,
  maskTokenMints: true,
  maskAmounts: false,
  maskRpcUrls: true,
  stripPrivateKeys: true,
  auditLog: false,
  allowedAddresses: [
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    'PumpFunAMMVyBmGAKgG3ksqyzVPBaQ5MqMk5MtKoFPu',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  ],
};

const SOLANA_ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

const PRIVATE_KEY_RE = /\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/g;
const JSON_KEY_RE = /\[(\s*\d{1,3}\s*,\s*){30,}\s*\d{1,3}\s*\]/g;

const RPC_URL_RE = /https?:\/\/[^\s"']+(?:rpc|solana|helius|quicknode|alchemy|triton|mainnet)[^\s"']*/gi;

const SOL_AMOUNT_RE = /(\d+\.\d{3,})\s*(SOL)/gi;

export class PrivacyGuard implements LLMProvider {
  private inner: LLMProvider;
  private config: PrivacyConfig;
  private logger?: LoggerInterface;

  private walletMap = new Map<string, string>();
  private walletReverseMap = new Map<string, string>();
  private walletCounter = 0;

  private mintMap = new Map<string, string>();
  private mintReverseMap = new Map<string, string>();
  private mintCounter = 0;

  private allowedSet: Set<string>;

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


    if (this.config.stripPrivateKeys) {
      result = result.replace(PRIVATE_KEY_RE, (match) => {

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


    if (this.config.maskRpcUrls) {
      result = result.replace(RPC_URL_RE, () => {
        this.stats.rpcUrlsMasked++;
        return '[RPC_URL]';
      });
    }


    if (this.config.maskWallets || this.config.maskTokenMints) {
      result = result.replace(SOLANA_ADDR_RE, (addr) => {
        if (this.allowedSet.has(addr)) return addr;
        return this.getOrCreatePlaceholder(addr);
      });
    }


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


    for (const [placeholder, real] of this.walletReverseMap) {
      result = result.split(placeholder).join(real);
    }


    for (const [placeholder, real] of this.mintReverseMap) {
      result = result.split(placeholder).join(real);
    }

    return result;
  }


  private getOrCreatePlaceholder(address: string): string {

    const existingWallet = this.walletMap.get(address);
    if (existingWallet) return existingWallet;

    const existingMint = this.mintMap.get(address);
    if (existingMint) return existingMint;


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

registerWallet(address: string, label?: string): string {
    const existing = this.walletMap.get(address);
    if (existing) return existing;

    const placeholder = label || `WALLET_${String(++this.walletCounter).padStart(3, '0')}`;
    this.walletMap.set(address, placeholder);
    this.walletReverseMap.set(placeholder, address);
    return placeholder;
  }

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

resolveplaceholder(placeholder: string): string | undefined {
    return this.walletReverseMap.get(placeholder) || this.mintReverseMap.get(placeholder);
  }

resetMappings(): void {
    this.walletMap.clear();
    this.walletReverseMap.clear();
    this.mintMap.clear();
    this.mintReverseMap.clear();
    this.walletCounter = 0;
    this.mintCounter = 0;
  }

getInnerProvider(): LLMProvider {
    return this.inner;
  }
}
