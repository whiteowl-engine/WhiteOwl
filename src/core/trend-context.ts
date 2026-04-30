
import { EventBusInterface, LoggerInterface, LLMMessage, LLMResponse, NewsItem } from '../types.ts';
import { NewsStore } from '../memory/news-store.ts';

export interface TrendEvent {
  event: string;
  keywords: string[];
  predictedNames: string[];
  weight: number;
}

export interface CatalystSignal {
  entity: string;
  action: string;
  headline: string;
  weight: number;
  relatedNarratives: string[];
  timestamp: number;
}

export interface TrendSnapshot {

  events: TrendEvent[];

  hotNarratives: string[];

  hotTokens: string[];

  sentiment: { bullish: number; bearish: number; neutral: number; trend: string };

  summary: string;

  xTrackerMints: string[];

  catalysts: CatalystSignal[];

  updatedAt: number;

  llmPowered: boolean;
}

type LLMFunction = (messages: LLMMessage[]) => Promise<LLMResponse>;

const REFRESH_INTERVAL_MS = 90_000;
const NEWS_LOOKBACK_MS = 30 * 60_000;
const API_PORT = process.env.API_PORT || '3377';

export class TrendContext {
  private newsStore: NewsStore | null = null;
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private llmFn: LLMFunction | null = null;
  private cached: TrendSnapshot | null = null;
  private lastRefresh = 0;
  private refreshing = false;
  private xMints: Array<{ mint: string; ts: number }> = [];
  private readonly MAX_X_MINTS = 50;

  constructor(opts: { eventBus: EventBusInterface; logger: LoggerInterface }) {
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.bindEvents();
  }

  setNewsStore(store: NewsStore): void {
    this.newsStore = store;
  }

  setLLMFunction(fn: LLMFunction): void {
    this.llmFn = fn;
    this.logger.info('[TrendContext] LLM wired — AI-powered trend detection active');
  }

  private bindEvents(): void {
    try {
      this.eventBus.on('gmgn:tweet' as any, (data: any) => {
        if (data?.mint) {
          this.xMints.push({ mint: data.mint, ts: Date.now() });
          if (this.xMints.length > this.MAX_X_MINTS) this.xMints.shift();
        }
      });
    } catch {}
  }

  getSnapshot(): TrendSnapshot {
    const now = Date.now();
    if (!this.cached || now - this.lastRefresh >= REFRESH_INTERVAL_MS) {
      if (!this.refreshing) {
        this.refreshing = true;
        this.refreshAsync().catch(err => {
          this.logger.debug(`[TrendContext] Refresh error: ${err.message}`);
        }).finally(() => { this.refreshing = false; });
      }
    }
    return this.cached || this.emptySnapshot();
  }

  isXTrackerMint(mint: string): boolean {
    return this.getSnapshot().xTrackerMints.includes(mint);
  }

  getActiveNarratives(): Array<{ keywords: string[]; title: string }> {
    return this.getSnapshot().events.map(e => ({ keywords: e.keywords, title: e.event }));
  }

scoreNarrativeMatch(name: string, description?: string): number {
    const snapshot = this.getSnapshot();
    if (snapshot.events.length === 0) return 0;

    const text = ((name || '') + ' ' + (description || '')).toLowerCase();
    const upperName = (name || '').toUpperCase();
    let score = 0;

    for (const event of snapshot.events) {

      for (const pn of event.predictedNames) {
        const pnUpper = pn.toUpperCase();
        if (upperName === pnUpper || upperName.includes(pnUpper) || pnUpper.includes(upperName)) {
          score += Math.ceil(event.weight * 2.5);
        } else if (text.includes(pn.toLowerCase())) {
          score += Math.ceil(event.weight * 1.5);
        }
      }


      for (const kw of event.keywords) {
        if (text.includes(kw.toLowerCase())) {
          score += Math.ceil(event.weight * 0.8);
          break;
        }
      }
    }


    if (snapshot.hotTokens.some(t => upperName.includes(t) || t.includes(upperName))) {
      score += 10;
    }


    if (snapshot.sentiment.trend === 'bullish') score += 5;
    if (snapshot.sentiment.trend === 'bearish') score -= 5;

    return Math.min(score, 50);
  }

  buildPromptSection(): string {
    const s = this.getSnapshot();
    const parts: string[] = ['[TREND CONTEXT]'];

    if (s.events.length > 0) {
      parts.push('🧠 AI-detected events:');
      for (const e of s.events) {
        parts.push(`  - ${e.event} (w${e.weight}) → pump.fun: ${e.predictedNames.join(', ')}`);
      }
    }
    if (s.hotNarratives.length > 0) parts.push(`Keywords: ${s.hotNarratives.join(', ')}`);
    if (s.hotTokens.length > 0) parts.push(`Predicted tokens: ${s.hotTokens.join(', ')}`);
    parts.push(`Sentiment: ${s.sentiment.trend} (${s.sentiment.bullish}🟢 ${s.sentiment.bearish}🔴)`);
    if (s.xTrackerMints.length > 0) parts.push(`X callouts: ${s.xTrackerMints.length} tokens`);
    if (s.llmPowered) parts.push('[AI-powered]');
    return parts.join('\n');
  }


  private emptySnapshot(): TrendSnapshot {
    return {
      events: [],
      hotNarratives: [],
      hotTokens: [],
      sentiment: { bullish: 0, bearish: 0, neutral: 0, trend: 'neutral' },
      summary: 'Initializing trend analysis...',
      xTrackerMints: [],
      catalysts: [],
      updatedAt: Date.now(),
      llmPowered: false,
    };
  }

  private async refreshAsync(): Promise<void> {
    const now = Date.now();


    const headlines = this.getHeadlines();
    const xData = await this.fetchXTrackerData();


    const xCutoff = now - 10 * 60_000;
    const recentXMints = this.xMints.filter(m => m.ts > xCutoff).map(m => m.mint);

    let events: TrendEvent[] = [];
    let sentimentStr = 'neutral';
    let summaryStr = '';
    let llmPowered = false;

    if (this.llmFn && (headlines.length > 0 || xData.length > 0)) {
      try {
        const result = await this.callLLM(headlines, xData);
        events = result.events;
        sentimentStr = result.sentiment;
        summaryStr = result.summary;
        llmPowered = true;
        this.logger.info(`[TrendContext] LLM: ${events.length} events, sentiment=${sentimentStr}`);
      } catch (err: any) {
        this.logger.debug(`[TrendContext] LLM failed: ${err.message}`);
      }
    }


    const sentiment = this.computeSentiment(headlines, sentimentStr);


    const hotNarratives = [...new Set(events.flatMap(e => e.keywords))].slice(0, 15);
    const hotTokens = [...new Set(events.flatMap(e => e.predictedNames))].slice(0, 15);


    const catalysts: CatalystSignal[] = events
      .filter(e => e.weight >= 6)
      .slice(0, 5)
      .map(e => ({
        entity: e.event.slice(0, 40),
        action: 'detected',
        headline: e.event,
        weight: Math.ceil(e.weight / 3),
        relatedNarratives: e.keywords,
        timestamp: now,
      }));

    if (!summaryStr && events.length > 0) {
      summaryStr = events.map(e => `${e.event} (w:${e.weight})`).join(' | ');
    }
    if (!summaryStr && headlines.length > 0) {
      summaryStr = headlines.slice(0, 3).map(h => h.title.slice(0, 60)).join(' | ');
    }

    this.cached = {
      events,
      hotNarratives,
      hotTokens,
      sentiment,
      summary: (summaryStr || 'No data').slice(0, 600),
      xTrackerMints: recentXMints,
      catalysts,
      updatedAt: now,
      llmPowered,
    };
    this.lastRefresh = now;
  }

  private getHeadlines(): NewsItem[] {
    if (!this.newsStore) return [];
    try {
      return this.newsStore.getTopByPriority(25, NEWS_LOOKBACK_MS);
    } catch { return []; }
  }

  private async fetchXTrackerData(): Promise<Array<{ analysis: string; relatedAnalysis: string; tokens: string[] }>> {
    try {
      const res = await fetch(`http://localhost:${API_PORT}/api/twitter/feed?limit=200`);
      if (!res.ok) return [];
      const json = await res.json() as any;
      const items = Array.isArray(json.items) ? json.items : [];
      const results: Array<{ analysis: string; relatedAnalysis: string; tokens: string[] }> = [];
      for (const msg of items) {
        const dataArr = Array.isArray(msg.data) ? msg.data : [];
        for (const item of dataArr) {
          if (item.et !== 'twitter_watched' || !item.ed) continue;
          const ot = item.ed.ot || {};
          const st = item.ed.st || {};
          if (!ot.ak && !st.ak) continue;
          results.push({
            analysis: ot.ak || '',
            relatedAnalysis: st.ak || '',
            tokens: (ot.kw || []).filter((k: any) => typeof k === 'string'),
          });
        }
      }
      return results;
    } catch { return []; }
  }

  private async callLLM(
    headlines: NewsItem[],
    xData: Array<{ analysis: string; relatedAnalysis: string; tokens: string[] }>,
  ): Promise<{ events: TrendEvent[]; sentiment: string; summary: string }> {
    let dataSection = '';
    const now = Date.now();

    if (headlines.length > 0) {
      dataSection += '## News feed (last 30 min):\n';
      for (const h of headlines) {
        const age = Math.round((now - h.published_at) / 60_000);
        dataSection += `- [${h.sentiment || 'neutral'}] "${h.title}" (${age}m ago)\n`;
      }
      dataSection += '\n';
    }

    if (xData.length > 0) {
      dataSection += '## X Tracker (KOL activity on Twitter):\n';
      for (const x of xData.slice(0, 20)) {
        let line = `- Topic: ${x.analysis}`;
        if (x.relatedAnalysis) line += ` | Related: ${x.relatedAnalysis}`;
        dataSection += line + '\n';
      }
      dataSection += '\n';
    }

    if (!dataSection) {
      return { events: [], sentiment: 'neutral', summary: '' };
    }

    const systemPrompt = `You are a memecoin trend analyst for pump.fun on Solana. Analyze raw news + Twitter data and determine what SPECIFIC events are happening RIGHT NOW that would drive people to create tokens on pump.fun.

IMPORTANT: Be SPECIFIC. Don't say "AI trending" — say "Elon changed avatar to a frog" → predict "ELONFROG", "MUSKFROG".

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "events": [
    {
      "event": "Brief specific event description",
      "keywords": ["keyword1", "keyword2"],
      "predicted_names": ["TOKENNAME1", "TOKENNAME2"],
      "weight": 1-10
    }
  ],
  "sentiment": "bullish" | "bearish" | "neutral" | "mixed",
  "summary": "One line: what's driving pump.fun right now"
}

Rules:
- Only include events that would ACTUALLY drive pump.fun token creation
- predicted_names: realistic pump.fun names (ALL CAPS, short, memeable)
- weight 8-10: major (president tweet, viral meme, big hack)
- weight 5-7: moderate (KOL callout, sector move)
- weight 1-4: minor/noise
- If nothing significant: empty events array
- Max 5 events, max 5 predicted_names per event
- keywords: specific words that would appear in token names/descriptions`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Analyze and tell me what's trending on pump.fun RIGHT NOW:\n\n${dataSection}` },
    ];

    const resp = await this.llmFn!(messages);
    return this.parseLLMResponse(resp.content);
  }

  private parseLLMResponse(content: string): { events: TrendEvent[]; sentiment: string; summary: string } {
    try {
      let jsonStr = content.trim();

      const codeBlock = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlock) jsonStr = codeBlock[1];

      if (!jsonStr.startsWith('{')) {
        const brace = jsonStr.match(/\{[\s\S]*\}/);
        if (brace) jsonStr = brace[0];
      }

      const parsed = JSON.parse(jsonStr);
      const events: TrendEvent[] = (parsed.events || [])
        .slice(0, 5)
        .map((e: any) => ({
          event: String(e.event || '').slice(0, 200),
          keywords: (Array.isArray(e.keywords) ? e.keywords : []).map(String).slice(0, 10),
          predictedNames: (Array.isArray(e.predicted_names) ? e.predicted_names : []).map(String).slice(0, 10),
          weight: Math.min(10, Math.max(1, Number(e.weight) || 5)),
        }));

      return {
        events,
        sentiment: String(parsed.sentiment || 'neutral'),
        summary: String(parsed.summary || '').slice(0, 300),
      };
    } catch (err: any) {
      this.logger.debug(`[TrendContext] LLM parse failed: ${err.message}`);
      return { events: [], sentiment: 'neutral', summary: '' };
    }
  }

  private computeSentiment(
    headlines: NewsItem[],
    llmSentiment: string,
  ): { bullish: number; bearish: number; neutral: number; trend: string } {
    let b = 0, bear = 0, n = 0;
    for (const h of headlines) {
      const s = (h.sentiment || '').toLowerCase();
      if (s === 'bullish' || s === 'positive') b++;
      else if (s === 'bearish' || s === 'negative') bear++;
      else n++;
    }

    const trend = (llmSentiment && llmSentiment !== 'neutral')
      ? llmSentiment
      : (b > bear * 1.5 ? 'bullish' : bear > b * 1.5 ? 'bearish' : b + bear > 0 ? 'mixed' : 'neutral');

    return { bullish: b, bearish: bear, neutral: n, trend };
  }
}
