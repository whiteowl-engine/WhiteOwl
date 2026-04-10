
import { Skill, SkillManifest, SkillContext, LoggerInterface } from '../types.ts';

const API_BASE = 'https://api10.axiom.trade';
const API_WO   = 'https://api.axiom.trade/wo';

const HEADERS: Record<string, string> = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'origin': 'https://axiom.trade',
  'referer': 'https://axiom.trade/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

const globalCache = new Map<string, { data: any; expires: number }>();
let globalLastReq = 0;
let axiomCookies: string | null = null;
let browserRef: any = null;
let loggerRef: LoggerInterface | null = null;

const axiomStats = {
  totalRequests: 0,
  cacheHits: 0,
  successCount: 0,
  failCount: 0,
  resolveFails: 0,
  resolveOk: 0,
  lastError: '' as string,
  lastErrorTs: 0,
  strategy1Hits: 0,
  strategy2Hits: 0,
  strategy3Hits: 0,
  avgLatencyMs: 0,
  _latencySum: 0,
  _latencyCount: 0,
};
export function getAxiomApiStats() {
  const hasBrowser = !!browserRef;
  const status = browserRef?.getStatus?.() || {};
  const hasHeaders = browserRef?.hasAxiomAuthHeaders?.();
  const hasCookies = browserRef?.hasAxiomCookies?.();
  const cookieNames: string[] = (browserRef as any)?.axiomCookies?.map((c: any) => c.name) || [];
  const hasAccessToken = cookieNames.includes('auth-access-token');
  return {
    ...axiomStats, _latencySum: undefined, _latencyCount: undefined,
    cacheSize: globalCache.size,
    authStatus: !hasBrowser ? 'no-browser' :
      hasHeaders && hasAccessToken ? 'headers-ok' :
      hasHeaders ? 'headers-no-access' :
      hasCookies && hasAccessToken ? 'cookies-ok' :
      hasCookies ? 'cookies-only' : 'no-auth',
    cdpConnected: !!status.mainBrowserConnected,
    cookieNames,
  };
}

export function setAxiomBrowser(browser: any): void {
  browserRef = browser;
}

export function setAxiomLogger(logger: LoggerInterface): void {
  loggerRef = logger;
}

async function refreshCookies(): Promise<void> {
  if (!browserRef) return;
  try {
    const cookies = await browserRef.extractAxiomCookies();
    if (cookies) axiomCookies = cookies;
  } catch {}
}

async function axiomFetch(url: string, ttlMs = 15_000): Promise<any> {
  const endpoint = url.split('?')[0].replace(/https:\/\/[^\/]+\//, '');
  axiomStats.totalRequests++;

  const cached = globalCache.get(url);
  if (cached && cached.expires > Date.now()) {
    axiomStats.cacheHits++;
    return cached.data;
  }

  const now = Date.now();
  const elapsed = now - globalLastReq;
  if (elapsed < 200) await new Promise(r => setTimeout(r, 200 - elapsed));
  globalLastReq = Date.now();

  const t0 = Date.now();

  if (browserRef?.getStatus()?.mainBrowserConnected) {
    try {
      const data = await browserRef.axiomApiFetch(url);
      if (data && !data.error) {
        const ms = Date.now() - t0;
        axiomStats.strategy1Hits++;
        axiomStats.successCount++;
        axiomStats._latencySum += ms; axiomStats._latencyCount++;
        axiomStats.avgLatencyMs = Math.round(axiomStats._latencySum / axiomStats._latencyCount);
        loggerRef?.debug(`[Axiom] ✓ CDP ${endpoint} ${ms}ms`);
        globalCache.set(url, { data, expires: Date.now() + ttlMs });
        return data;
      }
    } catch {}
  }


  if (browserRef?.hasAxiomAuthHeaders?.() || browserRef?.hasAxiomCookies()) {
    try {
      const data = await browserRef.axiomDirectFetch(url);
      if (data && !data.error) {
        const ms = Date.now() - t0;
        axiomStats.strategy2Hits++;
        axiomStats.successCount++;
        axiomStats._latencySum += ms; axiomStats._latencyCount++;
        axiomStats.avgLatencyMs = Math.round(axiomStats._latencySum / axiomStats._latencyCount);
        loggerRef?.debug(`[Axiom] ✓ Direct ${endpoint} ${ms}ms`);
        globalCache.set(url, { data, expires: Date.now() + ttlMs });
        return data;
      }
    } catch {}
  }


  if (!axiomCookies && browserRef) await refreshCookies();
  if (axiomCookies) {
    try {
      const hdrs = { ...HEADERS, cookie: axiomCookies };
      const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        if (!data?.error) {
          const ms = Date.now() - t0;
          axiomStats.strategy3Hits++;
          axiomStats.successCount++;
          axiomStats._latencySum += ms; axiomStats._latencyCount++;
          axiomStats.avgLatencyMs = Math.round(axiomStats._latencySum / axiomStats._latencyCount);
          loggerRef?.debug(`[Axiom] ✓ Legacy ${endpoint} ${ms}ms`);
          globalCache.set(url, { data, expires: Date.now() + ttlMs });
          return data;
        }
      }
      await refreshCookies();
    } catch {}
  }


  const ms = Date.now() - t0;
  axiomStats.failCount++;
  axiomStats.lastError = endpoint;
  axiomStats.lastErrorTs = Date.now();
  loggerRef?.warn(`[Axiom] ✗ FAIL ${endpoint} ${ms}ms (all strategies exhausted)`);


  if (globalCache.size > 500) {
    const cutoff = Date.now();
    for (const [k, v] of globalCache) {
      if (v.expires < cutoff) globalCache.delete(k);
    }
  }

  return null;
}


export async function axiomResolvePair(mint: string): Promise<string | null> {
  if (!browserRef?.getStatus()?.axiomConnected) {
    axiomStats.resolveFails++;
    axiomStats.lastError = 'resolve: no axiom connection';
    axiomStats.lastErrorTs = Date.now();
    loggerRef?.warn(`[Axiom] ✗ resolve ${mint.slice(0,8)}… — no axiom connection`);
    return null;
  }
  try {
    const pair = await browserRef.resolveAxiomPair(mint);
    if (!pair) {
      axiomStats.resolveFails++;
      axiomStats.lastError = 'resolve: pair not found';
      axiomStats.lastErrorTs = Date.now();
      loggerRef?.warn(`[Axiom] ✗ resolve ${mint.slice(0,8)}… — returned null`);
    } else {
      axiomStats.resolveOk++;
      loggerRef?.debug(`[Axiom] ✓ resolve ${mint.slice(0,8)}… → ${pair.slice(0,8)}…`);
    }
    return pair;
  } catch (err: any) {
    axiomStats.resolveFails++;
    axiomStats.lastError = `resolve: ${err.message}`;
    axiomStats.lastErrorTs = Date.now();
    loggerRef?.warn(`[Axiom] ✗ resolve ${mint.slice(0,8)}… ERR: ${err.message}`);
    return null;
  }
}

export async function axiomTokenInfo(pairAddress: string): Promise<{
  numHolders: number;
  top10HoldersPercent: number;
  devHoldsPercent: number;
  insidersHoldPercent: number;
  bundlersHoldPercent: number;
  snipersHoldPercent: number;
  dexPaid: boolean;
  dexPaidTime: string | null;
  numBotUsers: number;
} | null> {
  try {
    return await axiomFetch(`${API_BASE}/token-info?pairAddress=${pairAddress}&v=${Date.now()}`, 15_000);
  } catch { return null; }
}

export async function axiomPairInfo(pairAddress: string): Promise<{
  tokenTicker: string;
  tokenAddress: string;
  pairAddress: string;
  deployerAddress: string;
  protocol: string;
  lpBurned: number;
  createdAt: string;
  tokenImage: string;
  dexPaid: boolean;
  protocolDetails: any;
  signature: string;
} | null> {
  try {
    return await axiomFetch(`${API_BASE}/pair-info?pairAddress=${pairAddress}&v=${Date.now()}`, 30_000);
  } catch { return null; }
}

export async function axiomTokenAnalysis(pairAddress: string, devAddress: string, ticker: string): Promise<{
  creatorRiskLevel: string;
  creatorRugCount: number;
  creatorTokenCount: number;
  topMarketCapCoins: any[];
  topOgCoins: any[];
  reusedImageOgTokens: any[];
} | null> {
  try {
    return await axiomFetch(
      `${API_BASE}/token-analysis?devAddress=${devAddress}&tokenTicker=${encodeURIComponent(ticker)}&pairAddress=${pairAddress}&v=${Date.now()}`,
      60_000,
    );
  } catch { return null; }
}

export async function axiomHolderData(pairAddress: string): Promise<any[] | null> {
  try {
    return await axiomFetch(`${API_BASE}/holder-data-v5?pairAddress=${pairAddress}&v=${Date.now()}`, 15_000);
  } catch { return null; }
}

export async function axiomPairStats(pairAddress: string): Promise<any[] | null> {
  try {
    return await axiomFetch(`${API_BASE}/pair-stats?pairAddress=${pairAddress}&v=${Date.now()}`, 10_000);
  } catch { return null; }
}

export async function axiomKolTxns(pairAddress: string): Promise<any[] | null> {
  try {
    return await axiomFetch(`${API_BASE}/kol-transactions-v2?pairAddress=${pairAddress}&v=${Date.now()}`, 15_000);
  } catch { return null; }
}

export async function axiomSniperTxns(pairAddress: string): Promise<any[] | null> {
  try {
    return await axiomFetch(`${API_BASE}/sniper-transactions?pairAddress=${pairAddress}&v=${Date.now()}`, 15_000);
  } catch { return null; }
}

export async function axiomDevTokens(devAddress: string): Promise<{ tokens: any[] } | null> {
  try {
    return await axiomFetch(`${API_BASE}/dev-tokens-v3?devAddress=${devAddress}&v=${Date.now()}`, 60_000);
  } catch { return null; }
}

export async function axiomTopTraders(pairAddress: string, onlyTracked = false): Promise<any[] | null> {
  try {
    return await axiomFetch(
      `${API_BASE}/top-traders-v5?pairAddress=${pairAddress}&onlyTrackedWallets=${onlyTracked}&v=${Date.now()}`,
      15_000,
    );
  } catch { return null; }
}

export async function axiomSocialBubbles(tokenAddress: string): Promise<any[] | null> {
  try {
    return await axiomFetch(`${API_BASE}/social-bubbles?tokenAddress=${tokenAddress}&v=${Date.now()}`, 30_000);
  } catch { return null; }
}

export async function axiomTokenLocks(tokenAddress: string): Promise<any[] | null> {
  try {
    return await axiomFetch(`${API_WO}/token-locks-v2?tokenAddress=${tokenAddress}&v=${Date.now()}`, 30_000);
  } catch { return null; }
}

export async function axiomBatchMetadata(pairAddresses: string[]): Promise<any[] | null> {
  try {
    return await axiomFetch(
      `${API_BASE}/batch-pair-metadata?pairAddresses=${pairAddresses.join(',')}&v=${Date.now()}`,
      15_000,
    );
  } catch { return null; }
}

export async function axiomLighthouse(): Promise<any | null> {
  try {
    return await axiomFetch(`${API_BASE}/lighthouse?v=${Date.now()}`, 30_000);
  } catch { return null; }
}

export async function axiomBatchTokenDataTracked(mint: string): Promise<{
  tokenInfo: any; pairInfo: any; tokenAnalysis: any;
  kolTxns: any[]; sniperTxns: any[]; holderData: any[];
  pairAddress: string;
} | null> {

  const pairAddress = await axiomResolvePair(mint);
  if (!pairAddress) return null;


  axiomStats.totalRequests++;
  const t0 = Date.now();
  try {
    const data = await browserRef.axiomBatchTokenData(pairAddress);
    const ms = Date.now() - t0;
    if (data) {
      axiomStats.successCount++;
      axiomStats.strategy1Hits++;
      axiomStats._latencySum += ms; axiomStats._latencyCount++;
      axiomStats.avgLatencyMs = Math.round(axiomStats._latencySum / axiomStats._latencyCount);
      loggerRef?.debug(`[Axiom] ✓ batch ${mint.slice(0, 8)}… ${ms}ms`);
      return { ...data, pairAddress };
    } else {
      axiomStats.failCount++;
      axiomStats.lastError = `batch: null for ${mint.slice(0, 8)}`;
      axiomStats.lastErrorTs = Date.now();
    }
    return null;
  } catch (err: any) {
    axiomStats.failCount++;
    axiomStats.lastError = `batch: ${err.message}`;
    axiomStats.lastErrorTs = Date.now();
    loggerRef?.warn(`[Axiom] ✗ batch ${mint.slice(0, 8)}… ERR: ${err.message}`);
    return null;
  }
}


export class AxiomApiSkill implements Skill {
  manifest: SkillManifest = {
    name: 'axiom-api',
    version: '1.0.0',
    description:
      'Direct REST API integration with axiom.trade — public endpoints, no auth needed. ' +
      'Provides token info (holders, insiders, bundlers, snipers, top10%), dev analysis (rug history, risk), ' +
      'KOL/sniper transactions, top traders PnL, holder breakdown, pair stats, and market overview.',
    tools: [
      {
        name: 'axiom_resolve_pair',
        description:
          'Resolve token mint address → Axiom pair address. REQUIRED before generating axiom.trade links. ' +
          'axiom.trade URLs use pair address, NOT mint. Returns { pairAddress, axiomUrl }.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address (contract address)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_token_info',
        description:
          'Get token stats from Axiom: numHolders, top10HoldersPercent, devHoldsPercent, ' +
          'insidersHoldPercent, bundlersHoldPercent, snipersHoldPercent, dexPaid status, numBotUsers. ' +
          'Fastest source for holder composition. Uses pair address (not mint).',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address (from pump.fun or DEX)' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_pair_info',
        description:
          'Get pair metadata: tokenTicker, tokenAddress, deployerAddress, protocol (Pump V1 / Raydium / etc.), ' +
          'lpBurned%, createdAt timestamp, dexPaid, protocolDetails (bondingCurve, cashback, etc.).',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_dev_analysis',
        description:
          'Analyze token developer: risk level (Low/Medium/High/N-A), rug count from past tokens, ' +
          'total token count, top market cap coins by this dev, reused image detection (scam indicator). ' +
          'Critical for rug-pull prevention.',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address' },
            devAddress: { type: 'string', description: 'Developer/deployer wallet address' },
            ticker: { type: 'string', description: 'Token ticker symbol' },
          },
          required: ['pairAddress', 'devAddress', 'ticker'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_holders',
        description:
          'Get full holder breakdown for a token. Each holder entry includes: address, amount, ' +
          'pct of supply, buy/sell counts, PnL data. Rich data for whale/insider detection.',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_pair_stats',
        description:
          'Get per-minute candle data: buyCount, sellCount, buyVolumeSol, sellVolumeSol, priceSol per minute. ' +
          'Use for quick chart analysis and volume trend detection.',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_kol_transactions',
        description:
          'Get KOL (Key Opinion Leader) transactions for a token — which influencers bought or sold. ' +
          'Empty array means no KOLs traded this token on Axiom.',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_sniper_transactions',
        description:
          'Get sniper bot transactions — wallets that sniped the token at launch. ' +
          'Includes entry price, amounts, PnL, and whether they sold.',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_dev_tokens',
        description:
          'Get all tokens launched by a developer. Returns ticker, name, image, protocol, ' +
          'supply, highest mcap, created date. Critical for detecting serial ruggers.',
        parameters: {
          type: 'object',
          properties: {
            devAddress: { type: 'string', description: 'Developer wallet address' },
          },
          required: ['devAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_top_traders',
        description:
          'Get top traders PnL leaderboard for a token. Shows which wallets made the most profit. ' +
          'Option to filter to only your tracked wallets.',
        parameters: {
          type: 'object',
          properties: {
            pairAddress: { type: 'string', description: 'Pair address' },
            onlyTracked: { type: 'boolean', description: 'Only show tracked wallets (default: false)' },
          },
          required: ['pairAddress'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_lighthouse',
        description:
          'Get global market overview from Axiom: total transactions, traders, volume, ' +
          'buy/sell ratio, tokens created, migrations — per timeframe (5m, 1h, 6h, 24h) and protocol.',
        parameters: {
          type: 'object',
          properties: {},
        },
        riskLevel: 'read' as const,
      },
    ],
  };

  private logger!: LoggerInterface;

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    setAxiomLogger(ctx.logger);
    if (ctx.browser) setAxiomBrowser(ctx.browser);
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'axiom_resolve_pair': {
        const pair = await axiomResolvePair(params.mint);
        if (!pair) return { error: 'Failed to resolve pair address. Use pump.fun link instead.' };
        return { pairAddress: pair, axiomUrl: `https://axiom.trade/meme/${pair}` };
      }

      case 'axiom_token_info':
        return (await axiomTokenInfo(params.pairAddress)) ?? { error: 'Failed to fetch token info' };

      case 'axiom_pair_info':
        return (await axiomPairInfo(params.pairAddress)) ?? { error: 'Failed to fetch pair info' };

      case 'axiom_dev_analysis':
        return (await axiomTokenAnalysis(params.pairAddress, params.devAddress, params.ticker)) ?? { error: 'Failed to fetch dev analysis' };

      case 'axiom_holders':
        return (await axiomHolderData(params.pairAddress)) ?? { error: 'Failed to fetch holders' };

      case 'axiom_pair_stats':
        return (await axiomPairStats(params.pairAddress)) ?? { error: 'Failed to fetch pair stats' };

      case 'axiom_kol_transactions':
        return (await axiomKolTxns(params.pairAddress)) ?? { error: 'Failed to fetch KOL transactions' };

      case 'axiom_sniper_transactions':
        return (await axiomSniperTxns(params.pairAddress)) ?? { error: 'Failed to fetch sniper transactions' };

      case 'axiom_dev_tokens':
        return (await axiomDevTokens(params.devAddress)) ?? { error: 'Failed to fetch dev tokens' };

      case 'axiom_top_traders':
        return (await axiomTopTraders(params.pairAddress, params.onlyTracked)) ?? { error: 'Failed to fetch top traders' };

      case 'axiom_lighthouse':
        return (await axiomLighthouse()) ?? { error: 'Failed to fetch lighthouse data' };

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}
}
