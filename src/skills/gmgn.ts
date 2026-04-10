import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
} from '../types.ts';

export class GmgnSkill implements Skill {
  manifest: SkillManifest = {
    name: 'gmgn',
    version: '1.0.0',
    description: 'GMGN.ai integration for token data, security analysis, holder intelligence, rug detection, and OHLCV candles on Solana',
    tools: [
      {
        name: 'get_token_pairs',
        description: 'Get token info including price, volume, liquidity, market cap, holder count, and security data from GMGN',
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
        description: 'Search GMGN for tokens by name, symbol, or address',
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
        name: 'gmgn_security',
        description: 'Get comprehensive security + launchpad info: honeypot, taxes, mint/freeze authority, burn ratio, lock status, pump progress',
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
        name: 'gmgn_holder_stats',
        description: 'Get holder type breakdown: smart money, bundlers, snipers, bots, insiders, dev, fresh wallets',
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
        name: 'gmgn_rug_check',
        description: 'Check rug history: rug ratio, creator rugged tokens count, social links, community votes',
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
        name: 'get_price_history',
        description: 'Get OHLCV market cap candles for a token (1s/1m/5m/15m/1h resolution)',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            resolution: { type: 'string', description: 'Candle resolution: 1s, 1m, 5m, 15m, 1h (default: 1m)' },
            limit: { type: 'number', description: 'Number of candles (default: 200, max: 500)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'check_liquidity',
        description: 'Check token liquidity depth, holder concentration, and trading safety',
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
        name: 'gmgn_slippage',
        description: 'Get recommended slippage for a token based on volatility and tax analysis',
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

  private readonly API = 'https://gmgn.ai';
  private readonly HEADERS: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Referer': 'https://gmgn.ai/',
    'Origin': 'https://gmgn.ai',
    'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24", "Google Chrome";v="137"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };

  private lastRequestTime = 0;

  private gmgnStats = {
    totalRequests: 0,
    cacheHits: 0,
    successCount: 0,
    failCount: 0,
    avgLatencyMs: 0,
    _latencySum: 0,
    _latencyCount: 0,
    lastError: '' as string,
    lastErrorTs: 0,
  };

  getGmgnApiStats() { return { ...this.gmgnStats, _latencySum: undefined, _latencyCount: undefined }; }

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'get_token_pairs': return this.getTokenInfo(params.mint);
      case 'search_tokens': return this.searchTokens(params.query);
      case 'gmgn_security': return this.getSecurity(params.mint);
      case 'gmgn_holder_stats': return this.getHolderStats(params.mint);
      case 'gmgn_rug_check': return this.getRugCheck(params.mint);
      case 'get_price_history': return this.getPriceHistory(params.mint, params.resolution, params.limit);
      case 'check_liquidity': return this.checkLiquidity(params.mint);
      case 'gmgn_slippage': return this.getSlippage(params.mint);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.cache.clear();
  }

private async getTokenInfo(mint: string): Promise<any> {
    const data = await this.fetchCached(
      this.withParams(`${this.API}/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`),
      30_000,
    );
    if (!data || data.code !== 0 || !data.data?.token) return { error: 'No data found', mint };

    const t = data.data.token;

    return [{
      pairAddress: t.pool_address || t.address || mint,
      dex: t.launchpad || 'raydium',
      baseToken: { address: t.address || mint, name: t.name || '', symbol: t.symbol || '' },
      quoteToken: { symbol: 'SOL' },
      price: String(t.price ?? 0),
      priceNative: t.price_in_sol ?? null,
      volume: {
        m5: t.volume_5m ?? 0,
        h1: t.volume_1h ?? 0,
        h6: t.volume_6h ?? 0,
        h24: t.volume_24h ?? 0,
      },
      priceChange: {
        m5: t.price_change_percent?.m5 ?? 0,
        h1: t.price_change_percent?.h1 ?? 0,
        h6: t.price_change_percent?.h6 ?? 0,
        h24: t.price_change_percent?.h24 ?? 0,
      },
      txns: {
        m5: { buys: t.buys_5m ?? 0, sells: t.sells_5m ?? 0 },
        h1: { buys: t.buys_1h ?? 0, sells: t.sells_1h ?? 0 },
        h24: { buys: t.buys_24h ?? 0, sells: t.sells_24h ?? 0 },
      },
      liquidity: {
        usd: t.liquidity ?? 0,
        base: 0,
        quote: 0,
      },
      fdv: t.fdv ?? t.market_cap ?? 0,
      marketCap: t.market_cap ?? 0,
      createdAt: t.open_timestamp ? t.open_timestamp * 1000 : t.creation_timestamp ? t.creation_timestamp * 1000 : null,
      holderCount: t.holder_count ?? 0,

      top10HolderRate: t.top_10_holder_rate ?? null,
      sniperCount: t.sniper_count ?? null,
      bundleRate: t.bundle_rate ?? null,
      isHoneypot: t.is_honeypot ?? null,
      buyTax: t.buy_tax ?? null,
      sellTax: t.sell_tax ?? null,
      launchpad: t.launchpad ?? null,
      logo: t.logo ?? '',
      socials: [],
      websites: [],
    }];
  }

private async searchTokens(query: string): Promise<any> {
    const url = this.withParams(`${this.API}/defi/quotation/v1/tokens/search?q=${encodeURIComponent(query)}&chain=sol`);
    const data = await this.fetchCached(url, 30_000);
    if (!data || data.code !== 0) return [];

    const tokens = data.data?.tokens || data.data?.pairs || [];
    return tokens.slice(0, 20).map((t: any) => ({
      mint: t.address || t.base_address || '',
      name: t.name || '',
      symbol: t.symbol || '',
      price: t.price ? String(t.price) : '0',
      volume24h: t.volume_24h ?? t.volume ?? 0,
      mcap: t.market_cap ?? 0,
      liquidity: t.liquidity ?? 0,
      holderCount: t.holder_count ?? 0,
      logo: t.logo ?? '',
      launchpad: t.launchpad ?? null,
    }));
  }

private async getSecurity(mint: string): Promise<any> {
    const url = this.withParams(`${this.API}/api/v1/mutil_window_token_security_launchpad/sol/${encodeURIComponent(mint)}`);
    const data = await this.fetchCached(url, 60_000);
    if (!data || data.code !== 0 || !data.data) return { error: 'No security data', mint };

    const s = data.data.security || data.data;
    const lp = data.data.launchpad || {};
    return {
      mint,

      top10HolderRate: s.top_10_holder_rate ?? null,
      renouncedMint: s.renounced_mint ?? null,
      renouncedFreeze: s.renounced_freeze_account ?? null,
      burnRatio: s.burn_ratio ?? null,
      isHoneypot: s.is_honeypot ?? null,
      buyTax: s.buy_tax ?? null,
      sellTax: s.sell_tax ?? null,
      lockInfo: s.lock_info ?? null,
      ownerBalance: s.owner_balance ?? null,
      creatorBalance: s.creator_balance ?? null,

      launchpad: lp.launchpad ?? s.launchpad ?? null,
      pumpStatus: lp.pump_status ?? null,
      bondingProgress: lp.bonding_curve_progress ?? null,
      platform: lp.platform ?? null,
    };
  }

private async getHolderStats(mint: string): Promise<any> {
    const url = this.withParams(`${this.API}/vas/api/v1/token_holder_stat/sol/${encodeURIComponent(mint)}`);
    const data = await this.fetchCached(url, 60_000);
    if (!data || data.code !== 0 || !data.data) return { error: 'No holder stats', mint };

    const d = data.data;
    return {
      mint,
      holderCount: d.holder_count ?? null,

      smartDegen: d.smart_degen ?? 0,
      bundler: d.bundler ?? 0,
      sniper: d.sniper ?? 0,
      dexBot: d.dex_bot ?? 0,
      insider: d.insider ?? 0,
      dev: d.dev ?? 0,

      smartWallets: d.smart_wallets ?? 0,
      freshWallets: d.fresh_wallets ?? 0,
      sniperWallets: d.sniper_wallets ?? 0,
      whaleWallets: d.whale_wallets ?? 0,
      bundlerWallets: d.bundler_wallets ?? 0,
      topWallets: d.top_wallets ?? 0,

      top10HolderRate: d.top_10_holder_rate ?? null,
      devTeamHoldRate: d.dev_team_hold_rate ?? null,
      creatorHoldRate: d.creator_hold_rate ?? null,
      top70SniperHoldRate: d.top70_sniper_hold_rate ?? null,
      freshWalletRate: d.fresh_wallet_rate ?? null,
      creatorCreatedCount: d.creator_created_count ?? null,
    };
  }

private async getRugCheck(mint: string): Promise<any> {
    const url = this.withParams(`${this.API}/api/v1/mutil_window_token_link_rug_vote/sol/${encodeURIComponent(mint)}`);
    const data = await this.fetchCached(url, 60_000);
    if (!data || data.code !== 0 || !data.data) return { error: 'No rug data', mint };

    const d = data.data;
    return {
      mint,

      rugRatio: d.rug_ratio ?? null,
      ruggedTokens: d.rugged_tokens ?? 0,
      totalCreatedTokens: d.total_created_tokens ?? 0,

      twitter: d.twitter ?? null,
      telegram: d.telegram ?? null,
      website: d.website ?? null,
      discord: d.discord ?? null,

      upvotes: d.upvote ?? 0,
      downvotes: d.downvote ?? 0,

      links: d.links ?? [],
    };
  }

private async getPriceHistory(mint: string, resolution?: string, limit?: number): Promise<any> {
    const res = resolution || '1m';
    const lim = Math.min(limit || 200, 500);
    const url = this.withParams(`${this.API}/api/v1/token_mcap_candles/sol/${encodeURIComponent(mint)}?pool_type=tpool&resolution=${res}&limit=${lim}`);
    const data = await this.fetchCached(url, 15_000);
    if (!data || data.code !== 0 || !data.data) return { error: 'No candle data', mint };

    const candles = data.data.candles || data.data || [];
    return {
      mint,
      resolution: res,
      candles: Array.isArray(candles) ? candles.map((c: any) => ({
        timestamp: c.timestamp ?? c.t ?? 0,
        open: c.open ?? c.o ?? 0,
        high: c.high ?? c.h ?? 0,
        low: c.low ?? c.l ?? 0,
        close: c.close ?? c.c ?? 0,
        volume: c.volume ?? c.v ?? 0,
        marketCap: c.market_cap ?? c.mc ?? 0,
      })) : [],
    };
  }

private async checkLiquidity(mint: string): Promise<any> {
    const pairs = await this.getTokenInfo(mint);
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return { mint, totalLiquidity: 0, pairs: 0, status: 'no_liquidity' };
    }

    const info = pairs[0];
    const totalLiquidity = info.liquidity?.usd || 0;

    let status: string;
    if (totalLiquidity === 0) status = 'no_liquidity';
    else if (totalLiquidity < 5_000) status = 'very_low';
    else if (totalLiquidity < 50_000) status = 'low';
    else if (totalLiquidity < 500_000) status = 'moderate';
    else status = 'high';

    return {
      mint,
      totalLiquidity,
      pairCount: 1,
      mainDex: info.dex || info.launchpad,
      mainPairAddress: info.pairAddress,
      status,
      holderCount: info.holderCount || 0,
      top10HolderRate: info.top10HolderRate,
      isHoneypot: info.isHoneypot,
      buyTax: info.buyTax,
      sellTax: info.sellTax,
      buyToSellRatio24h: info.txns?.h24
        ? ((info.txns.h24.buys || 0) / Math.max(info.txns.h24.sells || 1, 1)).toFixed(2)
        : null,
    };
  }

private async getSlippage(mint: string): Promise<any> {
    const url = this.withParams(`${this.API}/api/v1/recommend_slippage/sol/${encodeURIComponent(mint)}`);
    const data = await this.fetchCached(url, 30_000);
    if (!data || data.code !== 0 || !data.data) return { error: 'No slippage data', mint };

    const d = data.data;
    return {
      mint,
      recommendSlippage: d.recommend_slippage ?? null,
      hasTax: d.has_tax ?? false,
      volatility: d.volatility ?? null,
    };
  }

private withParams(url: string): string {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const appVer = `${datePart}-12279-c315e4d`;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep +
      `device_id=17d36dea-7b0f-41a5-b075-55e05ac80fed` +
      `&fp_did=658c1cb4de30106c298c464bd5273547` +
      `&client_id=gmgn_web_${appVer}` +
      `&from_app=gmgn` +
      `&app_ver=${appVer}` +
      `&tz_name=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Stockholm')}` +
      `&tz_offset=${-new Date().getTimezoneOffset() * 60}` +
      `&app_lang=en-US` +
      `&os=web` +
      `&worker=0`;
  }

private async fetchCached(url: string, ttlMs: number): Promise<any> {
    const endpoint = url.split('?')[0].replace(/https:\/\/[^/]+\//, '');
    this.gmgnStats.totalRequests++;

    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) {
      this.gmgnStats.cacheHits++;
      return cached.data;
    }


    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < 500) {
      await new Promise(r => setTimeout(r, 500 - elapsed));
    }
    this.lastRequestTime = Date.now();

    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: this.HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      const ms = Date.now() - t0;
      this.gmgnStats._latencySum += ms; this.gmgnStats._latencyCount++;
      this.gmgnStats.avgLatencyMs = Math.round(this.gmgnStats._latencySum / this.gmgnStats._latencyCount);

      if (!res.ok) {
        this.gmgnStats.failCount++;
        this.gmgnStats.lastError = `${res.status} ${endpoint}`;
        this.gmgnStats.lastErrorTs = Date.now();
        this.logger?.warn?.(`[GMGN] ✗ ${endpoint} ${res.status} ${ms}ms`);
        return null;
      }

      this.gmgnStats.successCount++;
      this.logger?.debug?.(`[GMGN] ✓ ${endpoint} ${res.status} ${ms}ms`);

      const data = await res.json();
      this.cache.set(url, { data, expires: Date.now() + ttlMs });
      return data;
    } catch (err: any) {
      const ms = Date.now() - t0;
      this.gmgnStats.failCount++;
      this.gmgnStats.lastError = `${err.message} ${endpoint}`;
      this.gmgnStats.lastErrorTs = Date.now();
      this.logger?.warn?.(`[GMGN] ✗ ${endpoint} ERR ${ms}ms: ${err.message}`);
      return null;
    }
  }
}
