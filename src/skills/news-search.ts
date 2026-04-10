import { Skill, SkillManifest, SkillContext, NewsItem } from '../types.ts';
import { NewsStore } from '../memory/news-store.ts';

export class NewsSearchSkill implements Skill {
  manifest: SkillManifest = {
    name: 'news-search',
    version: '1.0.0',
    description: 'Search and browse crypto news headlines from aggregated sources',
    tools: [
      {
        name: 'news_get_latest',
        description: 'Get the latest crypto news headlines, optionally filtered by category. Categories: solana, defi, macro, regulation, memes, hack, general, all',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category (solana/defi/macro/regulation/memes/hack/general/all)', default: 'all' },
            limit: { type: 'number', description: 'Max headlines to return', default: 10 },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'news_search',
        description: 'Search news headlines by keyword or token name',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (keyword, token name, topic)' },
            limit: { type: 'number', description: 'Max results', default: 10 },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'news_sentiment',
        description: 'Get the current aggregate news sentiment (bullish/bearish/neutral breakdown and trend)',
        parameters: {
          type: 'object',
          properties: {},
        },
        riskLevel: 'read',
      },
    ],
  };

  private store: NewsStore | null = null;

  async initialize(ctx: SkillContext): Promise<void> {
    try {
      this.store = new NewsStore((ctx.memory as any).db || (ctx.memory as any).getDb?.());
    } catch {
      ctx.logger.warn('[NewsSearch] Could not initialize NewsStore');
    }
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    if (!this.store) return { error: 'News store not available' };

    switch (tool) {
      case 'news_get_latest': {
        const category = params.category || 'all';
        const limit = Math.min(params.limit || 10, 30);
        const items = this.store.getItems({ limit, category });
        return {
          count: items.length,
          headlines: items.map(i => this.formatItem(i)),
        };
      }

      case 'news_search': {
        const query = params.query as string;
        if (!query) return { error: 'query is required' };
        const limit = Math.min(params.limit || 10, 30);
        const items = this.store.search(query, limit);
        return {
          query,
          count: items.length,
          results: items.map(i => this.formatItem(i)),
        };
      }

      case 'news_sentiment': {
        const sentiment = this.store.getSentimentSummary();
        return {
          ...sentiment,
          total: sentiment.bullish + sentiment.bearish + sentiment.neutral,
          description: `Market news sentiment is ${sentiment.trend}. ${sentiment.bullish} bullish, ${sentiment.bearish} bearish, ${sentiment.neutral} neutral articles in the last hour.`,
        };
      }

      default:
        return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {}

  private formatItem(item: NewsItem): Record<string, any> {
    const ageMin = Math.round((Date.now() - item.published_at) / 60_000);
    return {
      title: item.title,
      source: item.source,
      age: `${ageMin}m ago`,
      sentiment: item.sentiment,
      category: item.category,
      relevance: item.relevance_score,
      tokens: item.mentioned_tokens,
      summary_ru: item.summary_ru,
      url: item.url,
    };
  }

private getDb(): any {
    return (this.store as any)?.db;
  }
}
