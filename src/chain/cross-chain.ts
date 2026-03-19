/**
 * Cross-Chain Adapter — Phase 7
 *
 * Abstract chain interface for multi-chain memecoin trading.
 * Supports: Solana (native), Base/Ethereum L2, Abstract/Monad.
 *
 * Each chain adapter implements ChainAdapter interface,
 * allowing the pipeline and skills to work chain-agnostic.
 */

import { LoggerInterface, EventBusInterface } from '../types';

// ----- Chain Adapter Interface -----

export type ChainId = 'solana' | 'base' | 'ethereum' | 'abstract' | 'monad';

export interface TokenOnChain {
  chain: ChainId;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  price: number;
  mcap: number;
  volume24h: number;
  liquidity: number;
  pairAddress?: string;
}

export interface SwapParams {
  chain: ChainId;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps: number;
  maxPriorityFee?: string;
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountOut?: string;
  price?: number;
  error?: string;
}

export interface ChainAdapter {
  chain: ChainId;
  name: string;

  /** Initialize adapter (connect RPC, etc.) */
  initialize(config: Record<string, any>): Promise<void>;

  /** Get wallet address for this chain */
  getAddress(): string;

  /** Get native token balance */
  getBalance(): Promise<number>;

  /** Get token info */
  getToken(address: string): Promise<TokenOnChain | null>;

  /** Execute a swap */
  swap(params: SwapParams): Promise<SwapResult>;

  /** Get trending tokens on this chain */
  getTrending(limit?: number): Promise<TokenOnChain[]>;

  /** Subscribe to new token events */
  subscribeNewTokens(callback: (token: TokenOnChain) => void): void;

  /** Unsubscribe from token events */
  unsubscribe(): void;

  /** Shutdown adapter */
  shutdown(): Promise<void>;
}

// ----- Base/Ethereum L2 Adapter -----

export class EVMAdapter implements ChainAdapter {
  chain: ChainId;
  name: string;
  private rpcUrl: string = '';
  private logger: LoggerInterface;
  private address: string = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tokenCallback: ((token: TokenOnChain) => void) | null = null;

  constructor(chain: ChainId, name: string, logger: LoggerInterface) {
    this.chain = chain;
    this.name = name;
    this.logger = logger;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    this.rpcUrl = config.rpcUrl || '';
    this.address = config.address || '';
    this.logger.info(`${this.name} adapter initialized (RPC: ${this.rpcUrl.slice(0, 30)}...)`);
  }

  getAddress(): string {
    return this.address;
  }

  async getBalance(): Promise<number> {
    if (!this.rpcUrl) return 0;
    try {
      const response = await this.jsonRpc('eth_getBalance', [this.address, 'latest']);
      return parseInt(response.result, 16) / 1e18;
    } catch {
      return 0;
    }
  }

  async getToken(address: string): Promise<TokenOnChain | null> {
    // Use DexScreener API for token data (chain-agnostic)
    try {
      const chainParam = this.chain === 'base' ? 'base' : this.chain === 'ethereum' ? 'ethereum' : this.chain;
      const res = await this.httpGet(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
      const data = JSON.parse(res);
      if (!data.pairs || data.pairs.length === 0) return null;

      const pair = data.pairs.find((p: any) => p.chainId === chainParam) || data.pairs[0];
      return {
        chain: this.chain,
        address,
        name: pair.baseToken?.name || 'Unknown',
        symbol: pair.baseToken?.symbol || '???',
        decimals: 18,
        price: parseFloat(pair.priceUsd || '0'),
        mcap: pair.fdv || 0,
        volume24h: pair.volume?.h24 || 0,
        liquidity: pair.liquidity?.usd || 0,
        pairAddress: pair.pairAddress,
      };
    } catch {
      return null;
    }
  }

  async swap(params: SwapParams): Promise<SwapResult> {
    // For EVM chains, integrate with DEX aggregators:
    // Base → BaseSwap, Uniswap v3
    // Ethereum → Uniswap, 1inch
    // This is a framework — actual swap execution requires wallet signing
    this.logger.info(`${this.name} swap: ${params.tokenIn} → ${params.tokenOut} (${params.amountIn})`);

    return {
      success: false,
      error: `${this.name} swap execution requires wallet integration. Framework ready.`,
    };
  }

  async getTrending(limit: number = 20): Promise<TokenOnChain[]> {
    try {
      const chainParam = this.chain === 'base' ? 'base' : this.chain === 'ethereum' ? 'ethereum' : this.chain;
      const res = await this.httpGet(`https://api.dexscreener.com/latest/dex/search?q=trending&chain=${chainParam}`);
      const data = JSON.parse(res);
      if (!data.pairs) return [];

      return data.pairs.slice(0, limit).map((p: any) => ({
        chain: this.chain,
        address: p.baseToken?.address || '',
        name: p.baseToken?.name || 'Unknown',
        symbol: p.baseToken?.symbol || '???',
        decimals: 18,
        price: parseFloat(p.priceUsd || '0'),
        mcap: p.fdv || 0,
        volume24h: p.volume?.h24 || 0,
        liquidity: p.liquidity?.usd || 0,
        pairAddress: p.pairAddress,
      }));
    } catch {
      return [];
    }
  }

  subscribeNewTokens(callback: (token: TokenOnChain) => void): void {
    this.tokenCallback = callback;
    // Poll DexScreener for new pairs on this chain
    this.pollTimer = setInterval(async () => {
      try {
        const trending = await this.getTrending(5);
        for (const token of trending) {
          if (this.tokenCallback) this.tokenCallback(token);
        }
      } catch {}
    }, 30_000);
  }

  unsubscribe(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.tokenCallback = null;
  }

  async shutdown(): Promise<void> {
    this.unsubscribe();
  }

  // ----- Helpers -----

  private jsonRpc(method: string, params: any[]): Promise<any> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    return this.httpPost(this.rpcUrl, body);
  }

  private httpGet(url: string): Promise<string> {
    const mod = url.startsWith('https') ? require('https') : require('http');
    return new Promise((resolve, reject) => {
      mod.get(url, { timeout: 10000 }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  private httpPost(url: string, body: string): Promise<any> {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const parsed = new URL(url);
    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ----- Cross-Chain Manager -----

export class CrossChainManager {
  private adapters = new Map<ChainId, ChainAdapter>();
  private logger: LoggerInterface;
  private eventBus: EventBusInterface;

  constructor(logger: LoggerInterface, eventBus: EventBusInterface) {
    this.logger = logger;
    this.eventBus = eventBus;
  }

  /**
   * Register a chain adapter.
   */
  registerAdapter(adapter: ChainAdapter): void {
    this.adapters.set(adapter.chain, adapter);
    this.logger.info(`Cross-chain: registered ${adapter.name} (${adapter.chain})`);
  }

  /**
   * Initialize with default EVM adapters.
   */
  addEVMChains(config: {
    base?: { rpcUrl: string; address: string };
    ethereum?: { rpcUrl: string; address: string };
    abstract?: { rpcUrl: string; address: string };
    monad?: { rpcUrl: string; address: string };
  }): void {
    if (config.base) {
      const adapter = new EVMAdapter('base', 'Base L2', this.logger);
      adapter.initialize(config.base);
      this.registerAdapter(adapter);
    }
    if (config.ethereum) {
      const adapter = new EVMAdapter('ethereum', 'Ethereum', this.logger);
      adapter.initialize(config.ethereum);
      this.registerAdapter(adapter);
    }
    if (config.abstract) {
      const adapter = new EVMAdapter('abstract', 'Abstract', this.logger);
      adapter.initialize(config.abstract);
      this.registerAdapter(adapter);
    }
    if (config.monad) {
      const adapter = new EVMAdapter('monad', 'Monad', this.logger);
      adapter.initialize(config.monad);
      this.registerAdapter(adapter);
    }
  }

  /**
   * Get adapter for a specific chain.
   */
  getAdapter(chain: ChainId): ChainAdapter | undefined {
    return this.adapters.get(chain);
  }

  /**
   * Get all registered chains.
   */
  getChains(): ChainId[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Cross-chain narrative monitoring:
   * Watch trending tokens across all chains for narrative overlap.
   */
  async scanCrossChainNarratives(): Promise<Array<{
    narrative: string;
    chains: ChainId[];
    tokens: TokenOnChain[];
  }>> {
    const allTrending = new Map<ChainId, TokenOnChain[]>();

    // Fetch trending from all chains in parallel
    const promises = Array.from(this.adapters.entries()).map(async ([chain, adapter]) => {
      try {
        const trending = await adapter.getTrending(20);
        allTrending.set(chain, trending);
      } catch {}
    });
    await Promise.all(promises);

    // Find common keywords/narratives across chains
    const wordMap = new Map<string, { chains: Set<ChainId>; tokens: TokenOnChain[] }>();

    for (const [chain, tokens] of allTrending) {
      for (const token of tokens) {
        const words = (token.name + ' ' + token.symbol).toLowerCase().split(/\s+/);
        for (const word of words) {
          if (word.length < 3) continue;
          if (!wordMap.has(word)) {
            wordMap.set(word, { chains: new Set(), tokens: [] });
          }
          const entry = wordMap.get(word)!;
          entry.chains.add(chain);
          entry.tokens.push(token);
        }
      }
    }

    // Narratives that appear on 2+ chains
    const crossChainNarratives: Array<{ narrative: string; chains: ChainId[]; tokens: TokenOnChain[] }> = [];
    for (const [word, data] of wordMap) {
      if (data.chains.size >= 2) {
        crossChainNarratives.push({
          narrative: word,
          chains: Array.from(data.chains),
          tokens: data.tokens,
        });
      }
    }

    return crossChainNarratives.sort((a, b) => b.chains.length - a.chains.length);
  }

  /**
   * Start monitoring all chains for new tokens.
   */
  startMonitoring(): void {
    for (const [chain, adapter] of this.adapters) {
      adapter.subscribeNewTokens((token) => {
        this.logger.debug(`[${chain}] New token: ${token.symbol} (${token.name})`);
        // Emit as standard token:new event with chain metadata
        this.eventBus.emit('token:new', {
          mint: `${chain}:${token.address}`,
          name: token.name,
          symbol: token.symbol,
          dev: '',
          timestamp: Date.now(),
        });
      });
    }
    this.logger.info(`Cross-chain monitoring started on ${this.adapters.size} chains`);
  }

  /**
   * Stop monitoring all chains.
   */
  stopMonitoring(): void {
    for (const [, adapter] of this.adapters) {
      adapter.unsubscribe();
    }
  }

  /**
   * Shutdown all adapters.
   */
  async shutdown(): Promise<void> {
    for (const [, adapter] of this.adapters) {
      await adapter.shutdown();
    }
    this.adapters.clear();
  }
}
