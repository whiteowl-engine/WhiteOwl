import * as fs from 'fs';
import * as path from 'path';
import { LoggerInterface, EventBusInterface, NewsSourceStatus } from '../types.ts';
import { NewsStore } from '../memory/news-store.ts';
import { NewsProcessor } from './news-processor.ts';
import { fetchCryptoPanic, fetchRSSFeed, fetchMacroData, fetchGDELT, fetchHackerNews, fetchTelegramChannel, rssGate, MacroSnapshot } from '../api/news-provider.ts';

interface NewsSourcesConfig {
  cryptopanic: {
    enabled: boolean;
    apiKey: string;
    pollIntervalMs: number;
    filter?: string;
    currencies?: string;
    priorityWeight: number;
  };
  rss: Array<{
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    pollIntervalMs: number;
    priorityWeight: number;
    defaultCategory?: string;
  }>;
  macro: {
    enabled: boolean;
    pollIntervalMs: number;
    coingeckoGlobal: boolean;
  };
  gdelt?: Array<{
    id: string;
    name: string;
    query: string;
    maxRecords?: number;
    timespan?: string;
    enabled: boolean;
    pollIntervalMs: number;
    priorityWeight: number;
    defaultCategory?: string;
  }>;
  hackernews?: {
    id: string;
    name: string;
    endpoint: string;
    maxItems?: number;
    enabled: boolean;
    pollIntervalMs: number;
    priorityWeight: number;
    defaultCategory?: string;
  };
  telegram?: Array<{
    id: string;
    name: string;
    channel: string;
    enabled: boolean;
    pollIntervalMs: number;
    priorityWeight: number;
    defaultCategory?: string;
  }>;
}

export class NewsScheduler {
  private logger: LoggerInterface;
  private eventBus: EventBusInterface;
  private processor: NewsProcessor;
  private config: NewsSourcesConfig;
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = false;
  private sources = new Map<string, NewsSourceStatus>();
  private latestMacro: MacroSnapshot | null = null;

  constructor(opts: {
    logger: LoggerInterface;
    eventBus: EventBusInterface;
    store: NewsStore;
    processor: NewsProcessor;
    configPath?: string;
    portfolioMints?: () => string[];
  }) {
    this.logger = opts.logger;
    this.eventBus = opts.eventBus;
    this.processor = opts.processor;

    const cfgPath = opts.configPath || path.resolve(process.cwd(), 'data', 'news-sources.json');
    this.config = this.loadConfig(cfgPath);
  }

  private loadConfig(cfgPath: string): NewsSourcesConfig {
    try {
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        return JSON.parse(raw) as NewsSourcesConfig;
      }
    } catch (err: any) {
      this.logger.warn(`[News] Failed to load config: ${err.message}`);
    }

    return {
      cryptopanic: { enabled: true, apiKey: '', pollIntervalMs: 60_000, filter: 'hot', currencies: 'SOL,BTC,ETH', priorityWeight: 1.0 },
      rss: [],
      macro: { enabled: true, pollIntervalMs: 900_000, coingeckoGlobal: true },
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info('[News] Scheduler starting...');


    if (this.config.cryptopanic.enabled) {
      this.initSource('cryptopanic', 'CryptoPanic', 'cryptopanic');
      this.pollCryptoPanic();
      this.timers.push(setInterval(() => this.pollCryptoPanic(), this.config.cryptopanic.pollIntervalMs));
    }


    this.config.rss.forEach((feed, idx) => {
      if (!feed.enabled) return;
      this.initSource(feed.id, feed.name, 'rss');

      setTimeout(() => {
        this.pollRSS(feed);
        this.timers.push(setInterval(() => this.pollRSS(feed), feed.pollIntervalMs));
      }, idx * 3_000);
    });


    if (this.config.macro.enabled) {
      this.initSource('macro', 'CoinGecko Global', 'macro');
      this.pollMacro();
      this.timers.push(setInterval(() => this.pollMacro(), this.config.macro.pollIntervalMs));
    }


    if (this.config.gdelt) {
      this.config.gdelt.forEach((gf, idx) => {
        if (!gf.enabled) return;
        this.initSource(gf.id, gf.name, 'gdelt');

        setTimeout(() => {
          this.pollGDELT(gf);
          this.timers.push(setInterval(() => this.pollGDELT(gf), gf.pollIntervalMs));
        }, (this.config.rss.filter(f => f.enabled).length * 2_000) + (idx * 5_000));
      });
    }


    if (this.config.hackernews?.enabled) {
      const hn = this.config.hackernews;
      this.initSource(hn.id, hn.name, 'hackernews');
      setTimeout(() => {
        this.pollHackerNews(hn);
        this.timers.push(setInterval(() => this.pollHackerNews(hn), hn.pollIntervalMs));
      }, 10_000);
    }


    if (this.config.telegram) {
      this.config.telegram.forEach((tg, idx) => {
        if (!tg.enabled) return;
        this.initSource(tg.id, tg.name, 'telegram');

        setTimeout(() => {
          this.pollTelegram(tg);
          this.timers.push(setInterval(() => this.pollTelegram(tg), tg.pollIntervalMs));
        }, 15_000 + idx * 3_000);
      });
    }


    this.timers.push(setInterval(() => this.processor.purge(), 30 * 60_000));

    const totalSources = (this.config.cryptopanic.enabled ? 1 : 0)
      + this.config.rss.filter(f => f.enabled).length
      + (this.config.macro.enabled ? 1 : 0)
      + (this.config.gdelt || []).filter(g => g.enabled).length
      + (this.config.hackernews?.enabled ? 1 : 0)
      + (this.config.telegram || []).filter(t => t.enabled).length;
    this.logger.info(`[News] Scheduler started: ${totalSources} sources active`);
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.logger.info('[News] Scheduler stopped');
  }

  getSourceStatuses(): NewsSourceStatus[] {
    return Array.from(this.sources.values());
  }

  getLatestMacro(): MacroSnapshot | null {
    return this.latestMacro;
  }

  private initSource(id: string, name: string, type: NewsSourceStatus['type']): void {
    this.sources.set(id, {
      id, name, type, enabled: true,
      last_fetch: 0, error_count: 0, items_fetched: 0,
    });
  }

  private updateSourceSuccess(id: string, count: number): void {
    const s = this.sources.get(id);
    if (s) {
      s.last_fetch = Date.now();
      s.error_count = 0;
      s.last_error = undefined;
      s.items_fetched += count;
    }
  }

  private updateSourceError(id: string, error: string): void {
    const s = this.sources.get(id);
    if (s) {
      s.error_count++;
      s.last_error = error;
    }
  }

  private async pollCryptoPanic(): Promise<void> {
    try {
      const items = await fetchCryptoPanic({
        apiKey: this.config.cryptopanic.apiKey,
        filter: this.config.cryptopanic.filter,
        currencies: this.config.cryptopanic.currencies,
      }, this.logger);

      const processed = this.processor.processBatch(items, 'CryptoPanic');
      this.updateSourceSuccess('cryptopanic', processed.length);
    } catch (err: any) {
      this.updateSourceError('cryptopanic', err.message);
      this.logger.error(`[News] CryptoPanic poll error: ${err.message}`);
    }
  }

  private async pollRSS(feed: { id: string; name: string; url: string; priorityWeight: number; defaultCategory?: string }): Promise<void> {
    try {
      const items = await rssGate(() => fetchRSSFeed({
        id: feed.id,
        name: feed.name,
        url: feed.url,
        priorityWeight: feed.priorityWeight,
        defaultCategory: feed.defaultCategory,
      }, this.logger));

      const processed = this.processor.processBatch(items, feed.name);
      this.updateSourceSuccess(feed.id, processed.length);
    } catch (err: any) {
      this.updateSourceError(feed.id, err.message);
      this.logger.error(`[News] RSS ${feed.name} poll error: ${err.message}`);
    }
  }

  private async pollMacro(): Promise<void> {
    try {
      const { snapshot, newsItem } = await fetchMacroData(this.logger);
      if (snapshot) this.latestMacro = snapshot;

      if (newsItem) {
        const processed = this.processor.processBatch([newsItem], 'CoinGecko');
        this.updateSourceSuccess('macro', processed.length);
      } else {
        this.updateSourceSuccess('macro', 0);
      }
    } catch (err: any) {
      this.updateSourceError('macro', err.message);
      this.logger.error(`[News] Macro poll error: ${err.message}`);
    }
  }

  private async pollGDELT(gf: { id: string; name: string; query: string; maxRecords?: number; timespan?: string; priorityWeight: number; defaultCategory?: string }): Promise<void> {
    try {
      const items = await fetchGDELT({
        id: gf.id,
        name: gf.name,
        query: gf.query,
        maxRecords: gf.maxRecords,
        timespan: gf.timespan,
        priorityWeight: gf.priorityWeight,
        defaultCategory: gf.defaultCategory,
      }, this.logger);

      const processed = this.processor.processBatch(items, gf.name);
      this.updateSourceSuccess(gf.id, processed.length);
    } catch (err: any) {
      this.updateSourceError(gf.id, err.message);
      this.logger.error(`[News] GDELT ${gf.name} poll error: ${err.message}`);
    }
  }

  private async pollHackerNews(hn: { id: string; name: string; endpoint: string; maxItems?: number; priorityWeight: number; defaultCategory?: string }): Promise<void> {
    try {
      const items = await fetchHackerNews({
        id: hn.id,
        name: hn.name,
        endpoint: hn.endpoint,
        maxItems: hn.maxItems,
        priorityWeight: hn.priorityWeight,
        defaultCategory: hn.defaultCategory,
      }, this.logger);

      const processed = this.processor.processBatch(items, hn.name);
      this.updateSourceSuccess(hn.id, processed.length);
    } catch (err: any) {
      this.updateSourceError(hn.id, err.message);
      this.logger.error(`[News] HN poll error: ${err.message}`);
    }
  }

  private async pollTelegram(tg: { id: string; name: string; channel: string; pollIntervalMs: number; priorityWeight: number; defaultCategory?: string }): Promise<void> {
    try {
      const items = await fetchTelegramChannel({
        id: tg.id,
        name: tg.name,
        channel: tg.channel,
        enabled: true,
        pollIntervalMs: tg.pollIntervalMs,
        priorityWeight: tg.priorityWeight,
        defaultCategory: tg.defaultCategory,
      }, this.logger);

      const processed = this.processor.processBatch(items, `TG @${tg.channel}`);
      this.updateSourceSuccess(tg.id, processed.length);
    } catch (err: any) {
      this.updateSourceError(tg.id, err.message);
      this.logger.error(`[News] Telegram ${tg.channel} poll error: ${err.message}`);
    }
  }
}
