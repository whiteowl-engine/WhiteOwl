import * as crypto from 'crypto';
import { LoggerInterface, EventBusInterface, NewsItem, NewsCategory, NewsSentiment } from '../types.ts';
import { NewsStore } from '../memory/news-store.ts';

const FRESHNESS_CUTOFF_MS = 4 * 60 * 60 * 1000;

export interface NewsProcessorOpts {
  store: NewsStore;
  eventBus: EventBusInterface;
  logger: LoggerInterface;
  portfolioMints?: () => string[];
}

export class NewsProcessor {
  private store: NewsStore;
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private portfolioMints: () => string[];
  private seenIds = new Set<string>();
  private seenHashes = new Set<string>();

  constructor(opts: NewsProcessorOpts) {
    this.store = opts.store;
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.portfolioMints = opts.portfolioMints || (() => []);
  }

  private contentHash(title: string): string {
    const norm = title
      .toLowerCase()
      .replace(/^(?:breaking|just in|urgent|alert|exclusive|update|new)[:\s!\u2013\u2014\-]*/u, '')
      .replace(/[\u2600-\u27BF\u{1F300}-\u{1F9FF}\u{2702}-\u{27B0}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
  }

  processBatch(items: NewsItem[], sourceName: string): NewsItem[] {
    const now = Date.now();
    const processed: NewsItem[] = [];
    let dupeCount = 0;

    if (this.seenIds.size > 10_000) {
      this.seenIds = new Set([...this.seenIds].slice(-5000));
    }
    if (this.seenHashes.size > 10_000) {
      this.seenHashes = new Set([...this.seenHashes].slice(-5000));
    }

    for (const item of items) {

      if (this.seenIds.has(item.id)) continue;
      if (this.store.hasItem(item.id)) {
        this.seenIds.add(item.id);
        continue;
      }

      if (now - item.published_at > FRESHNESS_CUTOFF_MS) continue;

      const cHash = this.contentHash(item.title);
      if (this.seenHashes.has(cHash) || this.store.hasContentHash(cHash)) {
        this.seenIds.add(item.id);
        this.seenHashes.add(cHash);
        dupeCount++;
        continue;
      }

      item.priority = this.calculatePriority(item);

      const isNew = this.store.store(item, cHash);
      if (!isNew) {
        this.seenIds.add(item.id);
        continue;
      }

      this.seenIds.add(item.id);
      this.seenHashes.add(cHash);
      processed.push(item);

      this.eventBus.emit('news:headline', { item, timestamp: now });
    }

    if (processed.length > 0) {
      this.eventBus.emit('news:batch', {
        items: processed,
        source: sourceName,
        count: processed.length,
        timestamp: now,
      });

      const sentiment = this.store.getSentimentSummary();
      this.eventBus.emit('news:sentiment_update', sentiment);
    }

    if (processed.length > 0 || dupeCount > 0) {
      const parts = [`[News] ${sourceName}: +${processed.length}`];
      if (dupeCount > 0) parts.push(`${dupeCount} dupes skipped`);
      this.logger.info(parts.join(', '));
    }

    return processed;
  }

private calculatePriority(item: NewsItem): number {
    const voteScore = item.votes
      ? (item.votes.bullish + item.votes.important - item.votes.bearish) * 0.3
      : 0;

    const relevance = item.relevance_score * 0.5;


    const ageMs = Date.now() - item.published_at;
    const recency = Math.max(0, 1 - ageMs / FRESHNESS_CUTOFF_MS) * 20;


    const portfolioTokens = this.portfolioMints();
    const hasPortfolioMatch = item.mentioned_tokens.some(t =>
      portfolioTokens.some(pt => pt.toLowerCase() === t.toLowerCase())
    );
    const portfolioBoost = hasPortfolioMatch ? 30 : 0;

    return Math.round(voteScore + relevance + recency + portfolioBoost);
  }

buildEnrichmentPrompt(items: NewsItem[]): string {
    const lines = items.map((item, i) =>
      `${i + 1}. [${item.source}] ${item.title}${item.summary ? ' — ' + item.summary.slice(0, 100) : ''}`
    );

    return `Analyze these crypto news headlines. For each, provide:
- sentiment: bullish / bearish / neutral
- category: solana / defi / macro / regulation / memes / hack / general
- relevance_score: 0-100 (how important for a Solana memecoin trader)
- mentioned_tokens: array of token symbols mentioned (e.g. ["SOL", "JUP", "BONK"])
- summary_ru: one-line English summary (15-25 words)

Headlines:
${lines.join('\n')}

Respond as a JSON array (same order). Example:
[{"sentiment":"bullish","category":"solana","relevance_score":85,"mentioned_tokens":["SOL"],"summary_ru":"Solana hit new ATH amid rising TVL"}]`;
  }

applyEnrichment(items: NewsItem[], results: any[]): void {
    for (let i = 0; i < items.length && i < results.length; i++) {
      const r = results[i];
      if (!r) continue;

      const data: Parameters<NewsStore['updateEnrichment']>[1] = {};
      if (r.sentiment && ['bullish', 'bearish', 'neutral'].includes(r.sentiment)) {
        data.sentiment = r.sentiment as NewsSentiment;
      }
      if (typeof r.relevance_score === 'number') {
        data.relevance_score = Math.min(100, Math.max(0, r.relevance_score));
      }
      if (r.category) data.category = r.category as NewsCategory;
      if (Array.isArray(r.mentioned_tokens)) data.mentioned_tokens = r.mentioned_tokens;
      if (typeof r.summary_ru === 'string') data.summary_ru = r.summary_ru;


      const enrichedItem = { ...items[i], ...data };
      data.priority = this.calculatePriority(enrichedItem as NewsItem);

      this.store.updateEnrichment(items[i].id, data);
    }

    this.logger.debug(`[News] Enriched ${Math.min(items.length, results.length)} items via LLM`);
  }

purge(): number {
    const removed = this.store.purgeOld();
    if (removed > 0) this.logger.info(`[News] Purged ${removed} old headlines`);
    return removed;
  }
}
