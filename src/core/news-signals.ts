import { LoggerInterface, EventBusInterface, NewsItem } from '../types.ts';

const SIGNAL_DECAY_MS = 5 * 60 * 1000;

interface ActiveNewsSignal {
  newsId: string;
  mint: string;
  sentiment: string;
  headline: string;
  source: string;
  emittedAt: number;
}

export class NewsSignals {
  private logger: LoggerInterface;
  private eventBus: EventBusInterface;
  private getActiveMints: () => string[];
  private activeSignals: ActiveNewsSignal[] = [];

  constructor(opts: {
    logger: LoggerInterface;
    eventBus: EventBusInterface;
    getActiveMints: () => string[];
  }) {
    this.logger = opts.logger;
    this.eventBus = opts.eventBus;
    this.getActiveMints = opts.getActiveMints;

    this.eventBus.on('news:headline', (data) => {
      this.evaluate(data.item);
    });

    setInterval(() => this.cleanup(), 60_000);
  }

  private evaluate(item: NewsItem): void {
    if (item.relevance_score < 70) return;

    const activeMints = this.getActiveMints();
    if (activeMints.length === 0) return;

    const matchedTokens = item.mentioned_tokens.filter(t =>
      activeMints.some(m => m.toLowerCase() === t.toLowerCase())
    );

    if (matchedTokens.length === 0) return;

    for (const token of matchedTokens) {
      const signalId = `${item.id}_${token}`;


      if (this.activeSignals.some(s => s.newsId === item.id && s.mint === token)) continue;

      const signal: ActiveNewsSignal = {
        newsId: item.id,
        mint: token,
        sentiment: item.sentiment,
        headline: item.title,
        source: item.source,
        emittedAt: Date.now(),
      };

      this.activeSignals.push(signal);


      if (item.sentiment === 'bullish' && item.relevance_score >= 80) {
        this.eventBus.emit('signal:buy', {
          mint: token,
          score: item.relevance_score,
          reason: `[NEWS] ${item.title.slice(0, 80)} (${item.source})`,
          agentId: 'news-signals',
        });
        this.logger.info(`[News Signal] BULLISH for ${token}: ${item.title.slice(0, 60)}`);
      } else if (item.sentiment === 'bearish' && item.relevance_score >= 80) {
        this.eventBus.emit('signal:sell', {
          mint: token,
          reason: `[NEWS BEARISH] ${item.title.slice(0, 80)} (${item.source})`,
          urgency: item.relevance_score >= 90 ? 'high' : 'medium',
          agentId: 'news-signals',
        });
        this.logger.info(`[News Signal] BEARISH for ${token}: ${item.title.slice(0, 60)}`);
      }
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - SIGNAL_DECAY_MS;
    this.activeSignals = this.activeSignals.filter(s => s.emittedAt > cutoff);
  }

  getActiveSignals(): ActiveNewsSignal[] {
    this.cleanup();
    return [...this.activeSignals];
  }
}
