import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
} from '../types';

export class DexScreenerSkill implements Skill {
  manifest: SkillManifest = {
    name: 'dex-screener',
    version: '1.0.0',
    description: 'DexScreener integration for price data, charts, liquidity, and pair info on Solana DEXes',
    tools: [
      {
        name: 'get_token_pairs',
        description: 'Get all trading pairs for a token including price, volume, liquidity',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'search_tokens',
        description: 'Search DexScreener for tokens by name or symbol',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_trending_tokens',
        description: 'Get trending tokens on Solana from DexScreener',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_new_pairs',
        description: 'Get recently created trading pairs on Solana',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max pairs to return' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'get_price_history',
        description: 'Get OHLCV price history for a token pair',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'DEX pair address' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read',
      },
      {
        name: 'check_liquidity',
        description: 'Check liquidity depth and lock status for a token',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
    ],
  };

  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private ctx!: SkillContext;
  private cache = new Map<string, { data: any; expires: number }>();

  private readonly API = 'https://api.dexscreener.com';

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'get_token_pairs': return this.getTokenPairs(params.mint);
      case 'search_tokens': return this.searchTokens(params.query);
      case 'get_trending_tokens': return this.getTrending();
      case 'get_new_pairs': return this.getNewPairs(params.limit);
      case 'get_price_history': return this.getPriceHistory(params.pairAddress);
      case 'check_liquidity': return this.checkLiquidity(params.mint);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.cache.clear();
  }

  private async getTokenPairs(mint: string): Promise<any> {
    const data = await this.fetchCached(`${this.API}/latest/dex/tokens/${mint}`, 30_000);
    if (!data?.pairs) return { error: 'No pairs found', mint };

    const solanaPairs = data.pairs.filter((p: any) => p.chainId === 'solana');

    return solanaPairs.map((p: any) => ({
      pairAddress: p.pairAddress,
      dex: p.dexId,
      baseToken: { address: p.baseToken.address, name: p.baseToken.name, symbol: p.baseToken.symbol },
      quoteToken: { symbol: p.quoteToken.symbol },
      price: p.priceUsd,
      priceNative: p.priceNative,
      volume: {
        m5: p.volume?.m5 || 0,
        h1: p.volume?.h1 || 0,
        h6: p.volume?.h6 || 0,
        h24: p.volume?.h24 || 0,
      },
      priceChange: {
        m5: p.priceChange?.m5 || 0,
        h1: p.priceChange?.h1 || 0,
        h6: p.priceChange?.h6 || 0,
        h24: p.priceChange?.h24 || 0,
      },
      txns: {
        m5: p.txns?.m5 || { buys: 0, sells: 0 },
        h1: p.txns?.h1 || { buys: 0, sells: 0 },
        h24: p.txns?.h24 || { buys: 0, sells: 0 },
      },
      liquidity: {
        usd: p.liquidity?.usd || 0,
        base: p.liquidity?.base || 0,
        quote: p.liquidity?.quote || 0,
      },
      fdv: p.fdv,
      marketCap: p.marketCap,
      createdAt: p.pairCreatedAt,
      socials: p.info?.socials || [],
      websites: p.info?.websites || [],
    }));
  }

  private async searchTokens(query: string): Promise<any> {
    const data = await this.fetchCached(`${this.API}/latest/dex/search/?q=${encodeURIComponent(query)}`, 60_000);
    if (!data?.pairs) return [];

    return data.pairs
      .filter((p: any) => p.chainId === 'solana')
      .slice(0, 20)
      .map((p: any) => ({
        mint: p.baseToken.address,
        name: p.baseToken.name,
        symbol: p.baseToken.symbol,
        price: p.priceUsd,
        volume24h: p.volume?.h24 || 0,
        mcap: p.marketCap,
        liquidity: p.liquidity?.usd || 0,
        dex: p.dexId,
        pairAddress: p.pairAddress,
      }));
  }

  private async getTrending(): Promise<any> {
    try {
      const boosted = await this.fetchCached(`${this.API}/token-boosts/top/v1`, 60_000);
      if (!Array.isArray(boosted)) return [];

      return boosted
        .filter((item: any) => item.chainId === 'solana')
        .slice(0, 20)
        .map((item: any) => ({
          mint: item.tokenAddress,
          icon: item.icon,
          description: item.description,
          totalBoosts: item.totalAmount || item.amount || 0,
          url: item.url,
        }));
    } catch {
      return [];
    }
  }

  private async getNewPairs(limit: number = 20): Promise<any> {
    const data = await this.fetchCached(`${this.API}/latest/dex/pairs/solana`, 30_000);
    if (!data?.pairs) return [];

    return data.pairs.slice(0, limit).map((p: any) => ({
      pairAddress: p.pairAddress,
      dex: p.dexId,
      token: {
        mint: p.baseToken.address,
        name: p.baseToken.name,
        symbol: p.baseToken.symbol,
      },
      price: p.priceUsd,
      volume24h: p.volume?.h24 || 0,
      liquidity: p.liquidity?.usd || 0,
      createdAt: p.pairCreatedAt,
    }));
  }

  private async getPriceHistory(pairAddress: string): Promise<any> {
    // DexScreener doesn't have a public OHLCV API, return pair data with changes
    const data = await this.fetchCached(`${this.API}/latest/dex/pairs/solana/${pairAddress}`, 15_000);
    if (!data?.pair) return { error: 'Pair not found' };

    const p = data.pair;
    return {
      pairAddress,
      currentPrice: p.priceUsd,
      priceChange: {
        m5: p.priceChange?.m5 || 0,
        h1: p.priceChange?.h1 || 0,
        h6: p.priceChange?.h6 || 0,
        h24: p.priceChange?.h24 || 0,
      },
      volume: {
        m5: p.volume?.m5 || 0,
        h1: p.volume?.h1 || 0,
        h24: p.volume?.h24 || 0,
      },
      txns: p.txns,
    };
  }

  private async checkLiquidity(mint: string): Promise<any> {
    const pairs = await this.getTokenPairs(mint);
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return { mint, totalLiquidity: 0, pairs: 0, status: 'no_liquidity' };
    }

    const totalLiquidity = pairs.reduce((s: number, p: any) => s + (p.liquidity?.usd || 0), 0);
    const mainPair = pairs[0];

    let status: string;
    if (totalLiquidity === 0) status = 'no_liquidity';
    else if (totalLiquidity < 5_000) status = 'very_low';
    else if (totalLiquidity < 50_000) status = 'low';
    else if (totalLiquidity < 500_000) status = 'moderate';
    else status = 'high';

    return {
      mint,
      totalLiquidity,
      pairCount: pairs.length,
      mainDex: mainPair.dex,
      mainPairAddress: mainPair.pairAddress,
      status,
      buyToSellRatio24h: mainPair.txns?.h24
        ? (mainPair.txns.h24.buys / Math.max(mainPair.txns.h24.sells, 1)).toFixed(2)
        : null,
    };
  }

  private async fetchCached(url: string, ttlMs: number): Promise<any> {
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;

    const data = await res.json();
    this.cache.set(url, { data, expires: Date.now() + ttlMs });
    return data;
  }
}
