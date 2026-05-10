import {
  Skill,
  SkillManifest,
  SkillContext,
  LoggerInterface,
} from '../types.ts';

/**
 * Prediction Pulse Skill
 *
 * Pulls live odds from Polymarket (public Gamma API, no auth required) and
 * surfaces them as narrative alpha signals for crypto/memecoin traders.
 *
 * Niche use case: prediction markets move BEFORE the corresponding memecoin
 * narrative pumps. Example: Trump 2028 odds jump 8% in a day → $TRUMP /
 * Trump-themed coins rally hours later. Same for AI ban / election / crypto-ETF
 * markets vs. their corresponding token narratives.
 */

const POLYMARKET_GAMMA = 'https://gamma-api.polymarket.com';
const UA = 'WhiteOwl-PredictionPulse/1.0';

interface PMMarketRaw {
  id?: string;
  question?: string;
  slug?: string;
  conditionId?: string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  volume?: string | number;
  volume24hr?: string | number;
  liquidity?: string | number;
  outcomes?: string;
  outcomePrices?: string;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  oneDayPriceChange?: number;
  oneHourPriceChange?: number;
  category?: string;
  // event grouping
  events?: Array<{ title?: string; slug?: string; ticker?: string }>;
}

interface SnapshotEntry {
  id: string;
  question: string;
  slug?: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  volume24h: number;
  endDate?: string;
  capturedAt: number;
}

/** Keyword buckets used to map prediction markets onto crypto narratives. */
const NARRATIVE_BUCKETS: Record<string, { keywords: RegExp; tokens: string[] }> = {
  trump: {
    keywords: /\btrump\b/i,
    tokens: ['TRUMP', 'MAGA', 'BODEN', 'TREMP'],
  },
  election2028: {
    keywords: /\b(2028|presidential|democratic nominee|republican nominee)\b/i,
    tokens: ['TRUMP', 'MAGA', 'KAMA'],
  },
  ai: {
    keywords: /\b(openai|gpt|gemini|anthropic|sam altman|agi|ai\b)/i,
    tokens: ['FET', 'TAO', 'RNDR', 'WLD', 'GOAT', 'TURBO'],
  },
  btc: {
    keywords: /\bbitcoin|btc\b|sats\b/i,
    tokens: ['BTC', 'PUPS', 'ORDI', 'WBTC'],
  },
  eth: {
    keywords: /\b(ethereum|eth )/i,
    tokens: ['ETH', 'MOG', 'SPX'],
  },
  solana: {
    keywords: /\bsolana|\bsol\b/i,
    tokens: ['SOL', 'BONK', 'WIF', 'JUP'],
  },
  cryptoEtf: {
    keywords: /\b(etf|approval|sec )/i,
    tokens: ['XRP', 'SOL', 'DOGE', 'LTC'],
  },
  doge: {
    keywords: /\bdoge|elon\b|musk\b/i,
    tokens: ['DOGE', 'SHIB', 'KISHU', 'X', 'GROK'],
  },
  fed: {
    keywords: /\b(fed|fomc|rate cut|powell|cpi|inflation)\b/i,
    tokens: ['BTC', 'ETH', 'SOL'],
  },
  war: {
    keywords: /\b(ceasefire|invasion|war|nuclear|missile|iran|russia|ukraine|israel)\b/i,
    tokens: ['BTC', 'PAXG', 'XAU'],
  },
};

function parseFloatSafe(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function parseJsonArray(v: any): any[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pctChange(curr: number, prev: number): number {
  if (!prev) return 0;
  return ((curr - prev) / prev) * 100;
}

export class PredictionPulseSkill implements Skill {
  manifest: SkillManifest = {
    name: 'prediction-pulse',
    version: '1.0.0',
    description:
      'Live Polymarket odds as crypto-narrative alpha. Detects prediction-market moves that historically precede memecoin pumps (elections, ETF, AI, Fed, geopolitics).',
    tools: [
      {
        name: 'pp_top_markets',
        description:
          'Top active Polymarket markets by 24h volume. Useful for spotting where retail attention is flowing.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max markets to return', default: 10 },
            minVolume24h: { type: 'number', description: 'Minimum 24h volume USD', default: 5000 },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'pp_search_markets',
        description: 'Search Polymarket markets by keyword (e.g. "Trump", "Fed", "Bitcoin 200k").',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keyword' },
            limit: { type: 'number', default: 10 },
            activeOnly: { type: 'boolean', default: true },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'pp_market_odds',
        description:
          'Detailed odds for a specific market (by slug or id) including YES/NO price, 1h/24h delta, liquidity.',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            id: { type: 'string' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'pp_narrative_pulse',
        description:
          'Cross-reference top-moving Polymarket markets with crypto narrative buckets (Trump, AI, ETF, Fed, geopolitics) and emit alpha signals with suggested tokens to watch.',
        parameters: {
          type: 'object',
          properties: {
            minMoveBps: {
              type: 'number',
              description: 'Minimum 24h price move in basis points to count as a signal',
              default: 300,
            },
            limit: { type: 'number', default: 8 },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'pp_event_calendar',
        description:
          'Upcoming high-impact prediction-market events sorted by resolution date — useful for planning narrative trades around catalysts.',
        parameters: {
          type: 'object',
          properties: {
            daysAhead: { type: 'number', default: 30 },
            limit: { type: 'number', default: 12 },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'pp_snapshot',
        description:
          'Capture an in-memory snapshot of the current top markets. Subsequent calls compute deltas vs the snapshot — useful for ad-hoc tracking sessions.',
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Optional snapshot label', default: 'default' },
            limit: { type: 'number', default: 30 },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'pp_snapshot_diff',
        description: 'Diff the current odds against a previously captured snapshot.',
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', default: 'default' },
            minMovePct: { type: 'number', default: 3 },
          },
        },
        riskLevel: 'read',
      },
    ],
  };

  private logger: LoggerInterface | null = null;
  private snapshots: Map<string, SnapshotEntry[]> = new Map();
  private cache: { ts: number; data: PMMarketRaw[] } | null = null;
  private readonly CACHE_TTL_MS = 30_000;

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('[PredictionPulse] initialized — Polymarket Gamma API ready');
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    try {
      switch (tool) {
        case 'pp_top_markets':
          return await this.topMarkets(params);
        case 'pp_search_markets':
          return await this.searchMarkets(params);
        case 'pp_market_odds':
          return await this.marketOdds(params);
        case 'pp_narrative_pulse':
          return await this.narrativePulse(params);
        case 'pp_event_calendar':
          return await this.eventCalendar(params);
        case 'pp_snapshot':
          return await this.snapshot(params);
        case 'pp_snapshot_diff':
          return await this.snapshotDiff(params);
        default:
          return { error: `Unknown tool: ${tool}` };
      }
    } catch (err: any) {
      this.logger?.warn?.(`[PredictionPulse] ${tool} failed: ${err?.message}`);
      return { error: err?.message || String(err) };
    }
  }

  async shutdown(): Promise<void> {
    this.snapshots.clear();
    this.cache = null;
  }

  // ---------- Polymarket fetchers ----------

  private async fetchMarkets(query: Record<string, string | number | boolean> = {}): Promise<PMMarketRaw[]> {
    const params = new URLSearchParams();
    params.set('closed', 'false');
    params.set('active', 'true');
    params.set('order', 'volume24hr');
    params.set('ascending', 'false');
    params.set('limit', '100');
    for (const [k, v] of Object.entries(query)) {
      params.set(k, String(v));
    }
    const url = `${POLYMARKET_GAMMA}/markets?${params.toString()}`;
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : (data?.data ?? []);
  }

  private async getCachedMarkets(): Promise<PMMarketRaw[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.ts < this.CACHE_TTL_MS) return this.cache.data;
    const data = await this.fetchMarkets();
    this.cache = { ts: now, data };
    return data;
  }

  // ---------- Tools ----------

  private async topMarkets(params: Record<string, any>) {
    const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);
    const minVol = Number(params.minVolume24h) || 0;
    const markets = await this.getCachedMarkets();
    const rows = markets
      .map((m) => this.formatMarket(m))
      .filter((m) => m.volume24h >= minVol)
      .slice(0, limit);
    return {
      source: 'polymarket',
      count: rows.length,
      markets: rows,
    };
  }

  private async searchMarkets(params: Record<string, any>) {
    const query = String(params.query || '').trim();
    if (!query) return { error: 'query is required' };
    const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 30);
    const markets = await this.fetchMarkets({ q: query, limit: 50 });
    const filtered = markets
      .filter((m) => (params.activeOnly === false ? true : m.active !== false && m.closed !== true))
      .map((m) => this.formatMarket(m))
      .slice(0, limit);
    return { query, count: filtered.length, markets: filtered };
  }

  private async marketOdds(params: Record<string, any>) {
    const slug = params.slug ? String(params.slug) : '';
    const id = params.id ? String(params.id) : '';
    if (!slug && !id) return { error: 'slug or id is required' };
    const qp = new URLSearchParams();
    if (slug) qp.set('slug', slug);
    if (id) qp.set('id', id);
    qp.set('limit', '1');
    const url = `${POLYMARKET_GAMMA}/markets?${qp.toString()}`;
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
    const arr = await res.json();
    const list: PMMarketRaw[] = Array.isArray(arr) ? arr : arr?.data ?? [];
    if (!list.length) return { error: 'market not found' };
    return { market: this.formatMarket(list[0]) };
  }

  private async narrativePulse(params: Record<string, any>) {
    const minMoveBps = Number(params.minMoveBps) || 300;
    const limit = Math.min(Math.max(Number(params.limit) || 8, 1), 25);
    const markets = await this.getCachedMarkets();

    const signals: Array<{
      narrative: string;
      question: string;
      slug?: string;
      yesPrice: number;
      moveBps24h: number;
      moveBps1h: number;
      volume24h: number;
      tokensToWatch: string[];
      direction: 'bullish' | 'bearish' | 'neutral';
      url: string;
    }> = [];

    for (const raw of markets) {
      const m = this.formatMarket(raw);
      const move24Bps = Math.round((m.change24h || 0) * 10_000);
      if (Math.abs(move24Bps) < minMoveBps) continue;
      const question = m.question || '';
      const narrative = this.matchNarrative(question);
      if (!narrative) continue;
      signals.push({
        narrative: narrative.key,
        question,
        slug: m.slug,
        yesPrice: m.yesPrice,
        moveBps24h: move24Bps,
        moveBps1h: Math.round((m.change1h || 0) * 10_000),
        volume24h: m.volume24h,
        tokensToWatch: narrative.tokens,
        direction: move24Bps > 0 ? 'bullish' : 'bearish',
        url: m.slug ? `https://polymarket.com/market/${m.slug}` : `https://polymarket.com`,
      });
    }

    signals.sort((a, b) => Math.abs(b.moveBps24h) - Math.abs(a.moveBps24h));
    return {
      generatedAt: new Date().toISOString(),
      count: signals.length,
      signals: signals.slice(0, limit),
    };
  }

  private async eventCalendar(params: Record<string, any>) {
    const daysAhead = Number(params.daysAhead) || 30;
    const limit = Math.min(Math.max(Number(params.limit) || 12, 1), 50);
    const markets = await this.getCachedMarkets();
    const now = Date.now();
    const cutoff = now + daysAhead * 24 * 60 * 60 * 1000;
    const events = markets
      .map((m) => this.formatMarket(m))
      .filter((m) => {
        if (!m.endDate) return false;
        const t = Date.parse(m.endDate);
        return Number.isFinite(t) && t >= now && t <= cutoff;
      })
      .sort((a, b) => Date.parse(a.endDate!) - Date.parse(b.endDate!))
      .slice(0, limit);
    return { daysAhead, count: events.length, events };
  }

  private async snapshot(params: Record<string, any>) {
    const label = String(params.label || 'default');
    const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 100);
    const markets = await this.fetchMarkets({ limit });
    const now = Date.now();
    const entries: SnapshotEntry[] = markets.map((m) => {
      const f = this.formatMarket(m);
      return {
        id: f.id,
        question: f.question,
        slug: f.slug,
        yesPrice: f.yesPrice,
        noPrice: f.noPrice,
        volume: f.volume,
        volume24h: f.volume24h,
        endDate: f.endDate,
        capturedAt: now,
      };
    });
    this.snapshots.set(label, entries);
    return { label, captured: entries.length, capturedAt: new Date(now).toISOString() };
  }

  private async snapshotDiff(params: Record<string, any>) {
    const label = String(params.label || 'default');
    const minMovePct = Number(params.minMovePct) || 3;
    const prev = this.snapshots.get(label);
    if (!prev) return { error: `no snapshot for label "${label}" — call pp_snapshot first` };
    const markets = await this.getCachedMarkets();
    const currMap = new Map<string, ReturnType<typeof this.formatMarket>>();
    for (const m of markets) {
      const f = this.formatMarket(m);
      currMap.set(f.id, f);
    }
    const diffs: any[] = [];
    for (const p of prev) {
      const c = currMap.get(p.id);
      if (!c) continue;
      const movePct = pctChange(c.yesPrice, p.yesPrice);
      if (Math.abs(movePct) < minMovePct) continue;
      diffs.push({
        question: p.question,
        slug: p.slug,
        from: p.yesPrice,
        to: c.yesPrice,
        movePct: Number(movePct.toFixed(2)),
        volume24hNow: c.volume24h,
        ageMinutes: Math.round((Date.now() - p.capturedAt) / 60_000),
      });
    }
    diffs.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
    return { label, count: diffs.length, diffs };
  }

  // ---------- helpers ----------

  private formatMarket(raw: PMMarketRaw) {
    const outcomes = parseJsonArray(raw.outcomes);
    const prices = parseJsonArray(raw.outcomePrices).map(parseFloatSafe);
    let yesPrice = 0;
    let noPrice = 0;
    if (outcomes.length && prices.length) {
      const yesIdx = outcomes.findIndex((o: any) => String(o).toLowerCase() === 'yes');
      if (yesIdx >= 0) {
        yesPrice = prices[yesIdx] ?? 0;
        noPrice = prices[1 - yesIdx] ?? (1 - yesPrice);
      } else {
        yesPrice = prices[0] ?? 0;
        noPrice = prices[1] ?? (1 - yesPrice);
      }
    } else if (typeof raw.lastTradePrice === 'number') {
      yesPrice = raw.lastTradePrice;
      noPrice = 1 - raw.lastTradePrice;
    }
    return {
      id: String(raw.id ?? raw.conditionId ?? raw.slug ?? ''),
      question: raw.question ?? '',
      slug: raw.slug,
      yesPrice: Number(yesPrice.toFixed(4)),
      noPrice: Number(noPrice.toFixed(4)),
      volume: parseFloatSafe(raw.volume),
      volume24h: parseFloatSafe(raw.volume24hr),
      liquidity: parseFloatSafe(raw.liquidity),
      change1h: typeof raw.oneHourPriceChange === 'number' ? raw.oneHourPriceChange : 0,
      change24h: typeof raw.oneDayPriceChange === 'number' ? raw.oneDayPriceChange : 0,
      endDate: raw.endDate,
      category: raw.category ?? raw.events?.[0]?.title,
      url: raw.slug ? `https://polymarket.com/market/${raw.slug}` : undefined,
    };
  }

  private matchNarrative(question: string): { key: string; tokens: string[] } | null {
    for (const [key, def] of Object.entries(NARRATIVE_BUCKETS)) {
      if (def.keywords.test(question)) return { key, tokens: def.tokens };
    }
    return null;
  }
}
