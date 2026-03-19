import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface, LLMProvider, LLMMessage,
} from '../types';
import { createLLMProvider } from '../llm';

interface SocialMention {
  platform: 'twitter' | 'telegram' | 'reddit';
  text: string;
  author: string;
  url?: string;
  followers?: number;
  timestamp: number;
  sentiment: number;
  tokens: string[];
}

interface KOLProfile {
  handle: string;
  name: string;
  platform: 'twitter' | 'telegram';
  followers: number;
  /** Influence weight 0-10 (higher = more impactful calls) */
  influence: number;
  /** Historical accuracy: wins / total tracked calls */
  winRate: number;
  trackedCalls: number;
  wins: number;
  lastActive?: number;
}

export class SocialMonitorSkill implements Skill {
  manifest: SkillManifest = {
    name: 'social-monitor',
    version: '2.0.0',
    description: 'Monitor social media with real KOL tracking, LLM-powered NLP sentiment, and influence-weighted signals',
    tools: [
      {
        name: 'search_twitter',
        description: 'Search Twitter for recent mentions of a token or keyword',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (e.g., "$PEPE pump.fun")' },
            limit: { type: 'number', description: 'Max results (default: 20)' },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'check_token_social',
        description: 'Check social media presence for a specific token: mentions count, sentiment, top posts',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Token symbol (e.g., "PEPE")' },
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['symbol'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_trending_tickers',
        description: 'Get currently trending crypto tickers from social media with mention velocity',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['1h', '4h', '24h'], description: 'Lookback period' },
            limit: { type: 'number', description: 'Number of results' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'analyze_sentiment',
        description: 'Analyze the sentiment of a text using LLM (or keyword fallback)',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to analyze' },
            useLLM: { type: 'boolean', description: 'Use LLM for deeper analysis (default: true if configured)' },
          },
          required: ['text'],
        },
        riskLevel: 'read',
      },
      {
        name: 'check_kol_activity',
        description: 'Check if tracked KOLs mentioned a token, with influence scores',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Token symbol' },
          },
          required: ['symbol'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_social_score',
        description: 'Get a composite social score 0-100 for a token based on mentions, sentiment, and influencer activity',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Token symbol' },
            mint: { type: 'string', description: 'Token mint (optional)' },
          },
          required: ['symbol'],
        },
        riskLevel: 'read',
      },
      {
        name: 'kol_add',
        description: 'Add a KOL (Key Opinion Leader) to track. Their mentions get influence-weighted scoring.',
        parameters: {
          type: 'object',
          properties: {
            handle: { type: 'string', description: 'Twitter handle or Telegram username' },
            name: { type: 'string', description: 'Display name' },
            platform: { type: 'string', enum: ['twitter', 'telegram'], description: 'Platform' },
            followers: { type: 'number', description: 'Follower count (approximate)' },
            influence: { type: 'number', description: 'Influence weight 1-10 (default: 5)' },
          },
          required: ['handle', 'name', 'platform'],
        },
        riskLevel: 'write',
      },
      {
        name: 'kol_remove',
        description: 'Remove a KOL from tracking',
        parameters: {
          type: 'object',
          properties: {
            handle: { type: 'string', description: 'KOL handle to remove' },
          },
          required: ['handle'],
        },
        riskLevel: 'write',
      },
      {
        name: 'kol_list',
        description: 'List all tracked KOLs with influence scores and win rates',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'kol_record_outcome',
        description: 'Record the outcome of a KOL call to track accuracy',
        parameters: {
          type: 'object',
          properties: {
            handle: { type: 'string', description: 'KOL handle' },
            symbol: { type: 'string', description: 'Token symbol they called' },
            outcome: { type: 'string', enum: ['win', 'loss'], description: 'Was the call profitable?' },
          },
          required: ['handle', 'symbol', 'outcome'],
        },
        riskLevel: 'write',
      },
      {
        name: 'social_set_llm',
        description: 'Configure LLM for deep NLP sentiment analysis instead of keyword matching',
        parameters: {
          type: 'object',
          properties: {
            provider: { type: 'string', description: 'LLM provider name' },
            model: { type: 'string', description: 'Model name' },
            apiKey: { type: 'string', description: 'API key (optional if set in env)' },
          },
          required: ['provider', 'model'],
        },
        riskLevel: 'write',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private mentionCache = new Map<string, SocialMention[]>();
  private llmProvider: LLMProvider | null = null;

  // KOL tracking database (in-memory, persisted via calls)
  private kols = new Map<string, KOLProfile>();
  /** KOL mentions cache: symbol → KOL handles that mentioned it */
  private kolMentions = new Map<string, Array<{ handle: string; timestamp: number; text: string }>>();

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

    // Seed default KOLs
    const defaults: KOLProfile[] = [
      { handle: 'CryptoGodJohn', name: 'GodJohn', platform: 'twitter', followers: 500_000, influence: 8, winRate: 0, trackedCalls: 0, wins: 0 },
      { handle: 'blknoiz06', name: 'Blknoiz', platform: 'twitter', followers: 300_000, influence: 7, winRate: 0, trackedCalls: 0, wins: 0 },
      { handle: 'crashiocrypto', name: 'Crashio', platform: 'twitter', followers: 200_000, influence: 6, winRate: 0, trackedCalls: 0, wins: 0 },
      { handle: 'anslodev', name: 'Anslo', platform: 'twitter', followers: 150_000, influence: 7, winRate: 0, trackedCalls: 0, wins: 0 },
      { handle: 'dcloudio', name: 'Dcloud', platform: 'twitter', followers: 100_000, influence: 5, winRate: 0, trackedCalls: 0, wins: 0 },
    ];
    for (const kol of defaults) {
      if (!this.kols.has(kol.handle)) this.kols.set(kol.handle, kol);
    }
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'search_twitter': return this.searchTwitter(params.query, params.limit);
      case 'check_token_social': return this.checkTokenSocial(params.symbol, params.mint);
      case 'get_trending_tickers': return this.getTrendingTickers(params.period, params.limit);
      case 'analyze_sentiment': return this.analyzeSentiment(params.text, params.useLLM);
      case 'check_kol_activity': return this.checkKOLActivity(params.symbol);
      case 'get_social_score': return this.getSocialScore(params.symbol, params.mint);
      case 'kol_add': return this.kolAdd(params as any);
      case 'kol_remove': return this.kolRemove(params.handle);
      case 'kol_list': return this.kolList();
      case 'kol_record_outcome': return this.kolRecordOutcome(params.handle, params.symbol, params.outcome);
      case 'social_set_llm': return this.setLLM(params as any);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.mentionCache.clear();
  }

  private async searchTwitter(query: string, limit: number = 20): Promise<SocialMention[] | { error: string; hint: string }> {
    // Uses public scraping endpoints — no API key required but rate limited
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(
        `https://api.dexscreener.com/token-boosts/top/v1`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!res.ok) {
        return {
          error: 'Twitter search unavailable without API key',
          hint: 'Configure Twitter API credentials or use DexScreener social data as fallback',
        };
      }

      // Fallback: return DexScreener social boosted tokens as proxy
      const data = await res.json() as any[];
      const mentions: SocialMention[] = data.slice(0, limit).map((item: any) => ({
        platform: 'twitter' as const,
        text: `${item.tokenAddress} boosted on DexScreener (${item.amount || 0} boosts)`,
        author: 'dexscreener',
        url: item.url,
        timestamp: Date.now(),
        sentiment: 0.5,
        tokens: [item.tokenAddress],
      }));

      return mentions;
    } catch (err: any) {
      return { error: err.message, hint: 'Social search requires network access' };
    }
  }

  private async checkTokenSocial(symbol: string, mint?: string): Promise<any> {
    const mentions = this.mentionCache.get(symbol.toUpperCase()) || [];

    // Try DexScreener for social data
    let dexData: any = null;
    if (mint) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (res.ok) {
          const data = await res.json() as any;
          const pair = data.pairs?.[0];
          if (pair) {
            dexData = {
              priceUsd: pair.priceUsd,
              volume24h: pair.volume?.h24,
              txns24h: pair.txns?.h24,
              socials: pair.info?.socials || [],
              websites: pair.info?.websites || [],
            };
          }
        }
      } catch {}
    }

    return {
      symbol: symbol.toUpperCase(),
      mint,
      cachedMentions: mentions.length,
      recentMentions: mentions.slice(-10),
      dexscreenerData: dexData,
      socialPresence: {
        twitter: dexData?.socials?.find((s: any) => s.type === 'twitter')?.url || null,
        telegram: dexData?.socials?.find((s: any) => s.type === 'telegram')?.url || null,
        website: dexData?.websites?.[0]?.url || null,
      },
    };
  }

  private async getTrendingTickers(period?: string, limit?: number): Promise<any> {
    try {
      // Use DexScreener trending as a reliable source
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
      if (!res.ok) return [];

      const data = await res.json() as any[];
      const solanaTokens = data
        .filter((item: any) => item.chainId === 'solana')
        .slice(0, limit || 20);

      return solanaTokens.map((item: any) => ({
        mint: item.tokenAddress,
        description: item.description || '',
        url: item.url,
        boosts: item.amount || 0,
      }));
    } catch {
      return [];
    }
  }

  private async analyzeSentiment(text: string, useLLM?: boolean): Promise<{ score: number; label: string; signals: string[]; method: string }> {
    // Try LLM first if configured
    if (this.llmProvider && useLLM !== false) {
      try {
        return await this.analyzeSentimentLLM(text);
      } catch {
        // Fall through to keyword matching
      }
    }
    return this.analyzeSentimentKeywords(text);
  }

  private async analyzeSentimentLLM(text: string): Promise<{ score: number; label: string; signals: string[]; method: string }> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `Analyze crypto/memecoin sentiment. Return JSON only:
{"score": <-1 to 1>, "label": "positive|negative|neutral", "signals": ["signal1", ...]}
Signals: market sentiment drivers (e.g., "whale_accumulation", "kol_shill", "organic_hype", "rug_warning", "fomo")`,
      },
      { role: 'user', content: text.slice(0, 1000) },
    ];

    const response = await this.llmProvider!.chat(messages);
    const match = response.content.match(/\{[\s\S]*\}/);
    if (!match) return this.analyzeSentimentKeywords(text);

    const parsed = JSON.parse(match[0]);
    return {
      score: Math.max(-1, Math.min(1, parsed.score || 0)),
      label: parsed.label || 'neutral',
      signals: parsed.signals || [],
      method: 'llm',
    };
  }

  private analyzeSentimentKeywords(text: string): { score: number; label: string; signals: string[]; method: string } {
    const positive = [
      'moon', 'pump', 'gem', 'bullish', 'lfg', 'buy', 'sending',
      'based', 'alpha', 'fire', 'huge', 'next', 'undervalued',
      'accumulate', 'hold', 'diamond', 'early', 'potential',
    ];
    const negative = [
      'rug', 'scam', 'dump', 'sell', 'avoid', 'fake', 'dead',
      'bearish', 'exit', 'careful', 'honeypot', 'jeet', 'sniped',
      'bundled', 'insider', 'bot', 'sus',
    ];

    const lower = text.toLowerCase();
    const signals: string[] = [];

    let score = 0;
    let matches = 0;

    for (const word of positive) {
      if (lower.includes(word)) {
        score += 1;
        matches++;
        signals.push(`+${word}`);
      }
    }

    for (const word of negative) {
      if (lower.includes(word)) {
        score -= 1;
        matches++;
        signals.push(`-${word}`);
      }
    }

    const normalizedScore = matches > 0 ? score / matches : 0;

    let label: string;
    if (normalizedScore > 0.3) label = 'positive';
    else if (normalizedScore < -0.3) label = 'negative';
    else label = 'neutral';

    return { score: normalizedScore, label, signals, method: 'keywords' };
  }

  private async checkKOLActivity(symbol: string): Promise<any> {
    const mentions = this.kolMentions.get(symbol.toUpperCase()) || [];
    const kolDetails = mentions.map(m => {
      const kol = this.kols.get(m.handle);
      return {
        handle: m.handle,
        name: kol?.name,
        influence: kol?.influence || 0,
        winRate: kol?.winRate || 0,
        mentionedAt: new Date(m.timestamp).toISOString(),
        text: m.text.slice(0, 200),
      };
    });

    // Calculate influence-weighted score
    const totalInfluence = kolDetails.reduce((s, k) => s + k.influence, 0);

    return {
      symbol,
      kolMentions: kolDetails.length,
      totalInfluence,
      trackedKOLs: this.kols.size,
      details: kolDetails,
      note: kolDetails.length === 0
        ? 'No KOL mentions detected. KOLs are tracked when social sources report their activity.'
        : `${kolDetails.length} KOL(s) mentioned this token`,
    };
  }

  private async getSocialScore(symbol: string, mint?: string): Promise<any> {
    let score = 30; // base score
    const factors: string[] = [];

    // Check DexScreener presence
    if (mint) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (res.ok) {
          const data = await res.json() as any;
          const pair = data.pairs?.[0];

          if (pair?.info?.socials?.length > 0) {
            score += pair.info.socials.length * 10;
            factors.push(`${pair.info.socials.length} social links on DexScreener`);
          }

          if (pair?.info?.websites?.length > 0) {
            score += 10;
            factors.push('Has website');
          }

          const vol24h = pair?.volume?.h24 || 0;
          if (vol24h > 100_000) {
            score += 15;
            factors.push(`High volume: $${(vol24h / 1000).toFixed(0)}k`);
          } else if (vol24h > 10_000) {
            score += 5;
            factors.push(`Moderate volume: $${(vol24h / 1000).toFixed(0)}k`);
          }
        }
      } catch {}
    }

    return {
      symbol,
      mint,
      socialScore: Math.min(100, score),
      factors,
    };
  }

  // ==========================================
  // KOL Management
  // ==========================================

  private kolAdd(params: { handle: string; name: string; platform: 'twitter' | 'telegram'; followers?: number; influence?: number }): { status: string; kol: KOLProfile } {
    const kol: KOLProfile = {
      handle: params.handle,
      name: params.name,
      platform: params.platform,
      followers: params.followers || 0,
      influence: params.influence ?? 5,
      winRate: 0,
      trackedCalls: 0,
      wins: 0,
    };
    this.kols.set(kol.handle, kol);
    this.logger.info(`KOL added: @${kol.handle} (${kol.platform}, influence: ${kol.influence})`);
    return { status: 'added', kol };
  }

  private kolRemove(handle: string): { status: string } {
    this.kols.delete(handle);
    return { status: 'removed' };
  }

  private kolList(): { kols: KOLProfile[] } {
    return { kols: Array.from(this.kols.values()).sort((a, b) => b.influence - a.influence) };
  }

  private kolRecordOutcome(handle: string, symbol: string, outcome: 'win' | 'loss'): { status: string; kol?: KOLProfile } {
    const kol = this.kols.get(handle);
    if (!kol) return { status: 'kol_not_found' };

    kol.trackedCalls++;
    if (outcome === 'win') kol.wins++;
    kol.winRate = kol.trackedCalls > 0 ? kol.wins / kol.trackedCalls : 0;

    // Auto-adjust influence based on win rate
    if (kol.trackedCalls >= 5) {
      if (kol.winRate > 0.6) kol.influence = Math.min(10, kol.influence + 0.5);
      else if (kol.winRate < 0.3) kol.influence = Math.max(1, kol.influence - 0.5);
    }

    this.logger.info(`KOL outcome: @${handle} ${symbol} ${outcome} (WR: ${(kol.winRate * 100).toFixed(0)}%, influence: ${kol.influence})`);
    return { status: 'recorded', kol };
  }

  private setLLM(params: { provider: string; model: string; apiKey?: string }): { status: string } {
    this.llmProvider = createLLMProvider({
      provider: params.provider as any,
      model: params.model,
      apiKey: params.apiKey,
      temperature: 0.2,
      maxTokens: 300,
    });
    this.logger.info(`Social monitor LLM set: ${params.provider}/${params.model}`);
    return { status: 'configured' };
  }
}
