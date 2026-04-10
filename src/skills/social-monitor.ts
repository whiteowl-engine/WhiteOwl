import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface, LLMProvider, LLMMessage,
} from '../types.ts';
import { createLLMProvider } from '../llm/index.ts';

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

  influence: number;

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
      {
        name: 'twitter_feed_read',
        description: 'Read the live X Tracker (GMGN) Twitter feed. Returns recent tweets from the connected WebSocket stream with author, text, tokens mentioned, engagement stats. Use this to see what crypto Twitter is talking about right now.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max tweets to return (default: 30, max: 100)' },
            handle: { type: 'string', description: 'Filter by @handle (optional)' },
            keyword: { type: 'string', description: 'Filter by keyword in text (optional)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'twitter_feed_analyze',
        description: 'Analyze the current X Tracker feed to find trending narratives, hot tokens, sentiment shifts, and emerging trends. Uses LLM to produce actionable intelligence from the live tweet stream.',
        parameters: {
          type: 'object',
          properties: {
            focus: { type: 'string', description: 'Optional focus area: "tokens", "narratives", "sentiment", or free text query' },
            depth: { type: 'string', enum: ['quick', 'deep'], description: 'Quick = summary, Deep = detailed with per-token breakdown (default: quick)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'twitter_feed_stats',
        description: 'Get statistics about the X Tracker feed: most mentioned tokens, most active authors, tweet velocity, keyword frequency. Good for a quick pulse check.',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['5m', '15m', '1h', 'all'], description: 'Time window (default: all available)' },
          },
        },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private mentionCache = new Map<string, SocialMention[]>();
  private llmProvider: LLMProvider | null = null;

  private kols = new Map<string, KOLProfile>();

  private kolMentions = new Map<string, Array<{ handle: string; timestamp: number; text: string }>>();

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

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
      case 'twitter_feed_read': return this.twitterFeedRead(params);
      case 'twitter_feed_analyze': return this.twitterFeedAnalyze(params);
      case 'twitter_feed_stats': return this.twitterFeedStats(params);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.mentionCache.clear();
  }

  private async searchTwitter(query: string, limit: number = 20): Promise<SocialMention[] | { error: string; hint: string }> {

    if (this.ctx.browser) {
      try {
        const results = await this.ctx.browser.searchTwitter(query, limit);
        if (results.length > 0 && !results[0]?.error) {
          return results.map((tweet: any) => ({
            platform: 'twitter' as const,
            text: tweet.text || '',
            author: tweet.author?.username || tweet.author?.displayName || 'unknown',
            url: tweet.url,
            timestamp: tweet.date ? new Date(tweet.date).getTime() : Date.now(),
            sentiment: 0.5,
            tokens: [],
          }));
        }

      } catch {}
    }


    try {
      const res = await fetch(
        `https://gmgn.ai/defi/quotation/v1/tokens/search?q=trending&chain=sol`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' } }
      );

      if (!res.ok) {
        return {
          error: 'Twitter search unavailable — log in to Twitter via Settings or configure API key',
          hint: 'Use the "Login via Browser" button in Twitter settings to enable browser-based search',
        };
      }

      const data = await res.json() as any;
      const tokens = data?.data?.tokens || [];
      const mentions: SocialMention[] = tokens.slice(0, limit).map((item: any) => ({
        platform: 'twitter' as const,
        text: `${item.address} trending on GMGN (mcap: $${item.market_cap || 0})`,
        author: 'gmgn',
        url: `https://gmgn.ai/sol/token/${item.address}`,
        timestamp: Date.now(),
        sentiment: 0.5,
        tokens: [item.address],
      }));

      return mentions;
    } catch (err: any) {
      return { error: err.message, hint: 'Social search requires network access' };
    }
  }

  private async checkTokenSocial(symbol: string, mint?: string): Promise<any> {
    const mentions = this.mentionCache.get(symbol.toUpperCase()) || [];

    let gmgnData: any = null;
    if (mint) {
      try {
                const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
        });
        if (res.ok) {
          const json = await res.json() as any;
          const t = json?.data?.token;
          if (t) {
            gmgnData = {
              price: t.price,
              volume24h: t.volume_24h,
              holderCount: t.holder_count,
              twitter: t.twitter_username || null,
              telegram: t.telegram || null,
              website: t.website || null,
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
      gmgnData,
      socialPresence: {
        twitter: gmgnData?.twitter ? `https://x.com/${gmgnData.twitter}` : null,
        telegram: gmgnData?.telegram || null,
        website: gmgnData?.website || null,
      },
    };
  }

  private async getTrendingTickers(period?: string, limit?: number): Promise<any> {
    try {

            const res = await fetch('https://gmgn.ai/defi/quotation/v1/tokens/search?q=trending&chain=sol', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
      });
      if (!res.ok) return [];

      const json = await res.json() as any;
      const tokens = json?.data?.tokens || [];

      return tokens.slice(0, limit || 20).map((item: any) => ({
        mint: item.address,
        description: item.name || '',
        url: `https://gmgn.ai/sol/token/${item.address}`,
        boosts: 0,
      }));
    } catch {
      return [];
    }
  }

  private async analyzeSentiment(text: string, useLLM?: boolean): Promise<{ score: number; label: string; signals: string[]; method: string }> {

    if (this.llmProvider && useLLM !== false) {
      try {
        return await this.analyzeSentimentLLM(text);
      } catch {

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
    let score = 30;
    const factors: string[] = [];


    if (mint) {
      try {
                const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
        });
        if (res.ok) {
          const json = await res.json() as any;
          const t = json?.data?.token;

          if (t) {
            const socials = [];
            if (t.twitter_username) socials.push('twitter');
            if (t.telegram) socials.push('telegram');
            if (t.website) socials.push('website');
            if (socials.length > 0) {
              score += socials.length * 10;
              factors.push(`${socials.length} social links on GMGN`);
            }

            if (t.website) {
              score += 10;
              factors.push('Has website');
            }

            const vol24h = t.volume_24h || 0;
            if (vol24h > 100_000) {
              score += 15;
              factors.push(`High volume: $${(vol24h / 1000).toFixed(0)}k`);
            } else if (vol24h > 10_000) {
              score += 5;
              factors.push(`Moderate volume: $${(vol24h / 1000).toFixed(0)}k`);
            }
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


  private async fetchFeedRaw(limit: number = 100): Promise<any[]> {
    try {
      const port = process.env.API_PORT || '3377';
      const res = await fetch(`http://localhost:${port}/api/twitter/feed?limit=${limit}`);
      if (!res.ok) return [];
      const data = await res.json() as { items: any[] };
      return data.items || [];
    } catch {
      return [];
    }
  }

  private parseFeedItems(raw: any[]): Array<{
    tweetId: string; gmgnAnalysis: string; tokens: string[];
    timestamp: number; url: string; type: string;
    relatedAnalysis: string; relatedTokens: string[];
  }> {
    const results: any[] = [];
    for (const msg of raw) {
      const dataArr = Array.isArray(msg.data) ? msg.data : [];
      for (const item of dataArr) {
        if (item.et !== 'twitter_watched' || !item.ed) continue;
        const tp = item.ed.tp || 'unknown';
        const ot = item.ed.ot || {};
        const st = item.ed.st || {};
        const tweetId = ot.ti || '';

        if (!tweetId && !ot.ak) continue;
        results.push({
          tweetId,
          gmgnAnalysis: ot.ak || '',
          tokens: ot.kw || [],
          timestamp: msg._ts || Date.now(),
          url: tweetId ? `https://x.com/i/status/${tweetId}` : '',
          type: tp,
          relatedAnalysis: st.ak || '',
          relatedTokens: st.kw || [],
        });
      }
    }
    return results;
  }

private async enrichTweet(tweetId: string): Promise<any | null> {
    if (!tweetId) return null;
    try {
      const port = process.env.API_PORT || '3377';
      const res = await fetch(`http://localhost:${port}/api/tweet/${tweetId}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  private async enrichBatch(tweetIds: string[], concurrency: number = 6): Promise<Map<string, any>> {
    const cache = new Map<string, any>();
    const unique = [...new Set(tweetIds.filter(Boolean))];

    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(id => this.enrichTweet(id)));
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) cache.set(batch[j], results[j]);
      }
    }
    return cache;
  }

  private async twitterFeedRead(params: Record<string, any>): Promise<any> {
    const limit = Math.min(params.limit || 30, 100);
    const handle = (params.handle || '').toLowerCase().replace(/^@/, '');
    const keyword = (params.keyword || '').toLowerCase();
    const enrich = params.enrich !== false;

    const raw = await this.fetchFeedRaw(200);
    if (!raw.length) {
      return {
        error: 'X Tracker feed is empty. Make sure the GMGN WebSocket is connected in the dashboard (Twitter Monitor section).',
        hint: 'Go to Dashboard -> X Tracker -> Connect to Chrome -> Auto-Detect WS',
      };
    }

    let items = this.parseFeedItems(raw);

    if (handle || enrich) {
      items = items.filter(t => t.tweetId);
    }

    if (keyword && !handle) {
      items = items.filter(t =>
        t.gmgnAnalysis.toLowerCase().includes(keyword) ||
        t.tokens.some((tk: string) => tk.toLowerCase().includes(keyword)) ||
        t.relatedAnalysis.toLowerCase().includes(keyword)
      );
    }

    items = items.slice(-limit);

    if (!items.length) {
      return { count: 0, totalInBuffer: raw.length, tweets: [], filter: { handle, keyword } };
    }

    let enriched = new Map<string, any>();
    if (enrich) {
      enriched = await this.enrichBatch(items.map(t => t.tweetId));
    }

    let tweets = items.map(t => {
      const vx = enriched.get(t.tweetId);
      return {
        tweetId: t.tweetId,
        author: vx?.user_screen_name || '',
        authorName: vx?.user_name || '',
        text: vx?.text || '',
        gmgnTopic: t.gmgnAnalysis,
        tokens: [...t.tokens, ...t.relatedTokens].filter(Boolean),
        likes: vx?.likes || 0,
        retweets: vx?.retweets || 0,
        replies: vx?.replies || 0,
        time: new Date(t.timestamp).toLocaleTimeString(),
        url: vx?.user_screen_name
          ? `https://x.com/${vx.user_screen_name}/status/${t.tweetId}`
          : t.url,
      };
    });


    if (handle) {
      tweets = tweets.filter(t => t.author.toLowerCase() === handle);
    }
    if (keyword) {
      tweets = tweets.filter(t =>
        t.text.toLowerCase().includes(keyword) ||
        t.gmgnTopic.toLowerCase().includes(keyword) ||
        t.author.toLowerCase().includes(keyword) ||
        t.tokens.some((tk: string) => tk.toLowerCase().includes(keyword))
      );
    }

    return {
      count: tweets.length,
      totalInBuffer: raw.length,
      filter: { handle: handle || null, keyword: keyword || null },
      tweets,
    };
  }

  private async twitterFeedAnalyze(params: Record<string, any>): Promise<any> {
    const focus = params.focus || '';
    const deep = params.depth === 'deep';

    const raw = await this.fetchFeedRaw(200);
    if (!raw.length) {
      return {
        error: 'X Tracker feed is empty. Connect the GMGN WebSocket first.',
        hint: 'Go to Dashboard -> X Tracker -> Auto-Detect WS',
      };
    }

    const items = this.parseFeedItems(raw);
    if (!items.length) {
      return { error: 'No tweets parsed from the feed buffer.' };
    }


    const withIds = items.filter(t => t.tweetId).slice(-50);
    const enriched = await this.enrichBatch(withIds.map(t => t.tweetId));


    const tokenFreq = new Map<string, number>();
    const authorFreq = new Map<string, number>();
    const allTexts: string[] = [];
    let totalLikes = 0;
    let totalRetweets = 0;

    for (const t of items) {
      for (const tk of [...t.tokens, ...t.relatedTokens]) {
        if (tk) tokenFreq.set(tk, (tokenFreq.get(tk) || 0) + 1);
      }
      if (t.gmgnAnalysis) {

        const words = t.gmgnAnalysis.split(/\W+/).filter((w: string) => w.length >= 2);
        for (const w of words) {
          tokenFreq.set(w, (tokenFreq.get(w) || 0) + 1);
        }
      }
    }

    for (const t of withIds) {
      const vx = enriched.get(t.tweetId);
      if (vx) {
        const author = vx.user_screen_name || '';
        if (author) authorFreq.set(author, (authorFreq.get(author) || 0) + 1);
        totalLikes += vx.likes || 0;
        totalRetweets += vx.retweets || 0;
        allTexts.push(`@${author}: ${vx.text || t.gmgnAnalysis}`);
      } else if (t.gmgnAnalysis) {
        allTexts.push(`[GMGN]: ${t.gmgnAnalysis}`);
      }
    }

    const topTokens = [...tokenFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([token, count]) => ({ token, mentions: count }));

    const topAuthors = [...authorFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([author, count]) => ({ author, tweets: count }));


    if (this.llmProvider) {
      try {
        const tweetSample = allTexts.slice(-50).join('\n');
        const focusPrompt = focus ? `\nFocus your analysis on: ${focus}` : '';
        const depthNote = deep
          ? 'Provide a DETAILED analysis with per-token sentiment breakdown and specific trade signals.'
          : 'Provide a CONCISE summary with key takeaways.';

        const messages: LLMMessage[] = [
          {
            role: 'system',
            content: `You are a crypto Twitter analyst. Analyze the live tweet feed from GMGN X Tracker and extract actionable trading intelligence.
${depthNote}

Return JSON:
{
  "summary": "1-3 sentence overview of current Twitter sentiment",
  "trending_narratives": ["narrative1", "narrative2"],
  "hot_tokens": [{"symbol": "X", "sentiment": "bullish|bearish|neutral", "signal_strength": 1-10, "reason": "why"}],
  "alerts": ["any urgent signals or warnings"],
  "recommendation": "what to watch or act on next"
}${focusPrompt}`,
          },
          {
            role: 'user',
            content: `Live X Tracker feed (${items.length} tweets, enriched ${enriched.size}):\n\nTop tokens by mentions: ${JSON.stringify(topTokens.slice(0, 10))}\nTop active authors: ${JSON.stringify(topAuthors.slice(0, 5))}\nTotal engagement: ${totalLikes} likes, ${totalRetweets} RTs\n\nRecent tweets:\n${tweetSample.slice(0, 3000)}`,
          },
        ];

        const response = await this.llmProvider.chat(messages);
        const match = response.content.match(/\{[\s\S]*\}/);
        let llmAnalysis: any = {};
        if (match) {
          try { llmAnalysis = JSON.parse(match[0]); } catch {}
        }

        return {
          feedSize: items.length,
          enrichedCount: enriched.size,
          totalEngagement: { likes: totalLikes, retweets: totalRetweets },
          topTokens,
          topAuthors,
          analysis: llmAnalysis.summary ? llmAnalysis : { raw: response.content },
          method: 'llm',
        };
      } catch (err: any) {
        this.logger.error(`Twitter feed LLM analysis failed: ${err.message}`);
      }
    }


    const sampleTexts = allTexts.slice(-20).join(' ');
    const sentiment = this.analyzeSentimentKeywords(sampleTexts);

    return {
      feedSize: items.length,
      enrichedCount: enriched.size,
      totalEngagement: { likes: totalLikes, retweets: totalRetweets },
      topTokens,
      topAuthors,
      sentiment,
            note: 'LLM not configured. Use social_set_llm to enable deep analysis.',
      method: 'keywords',
    };
  }

  private async twitterFeedStats(params: Record<string, any>): Promise<any> {
    const period = params.period || 'all';
    const raw = await this.fetchFeedRaw(200);
    if (!raw.length) {
      return { error: 'X Tracker feed is empty.' };
    }

    let items = this.parseFeedItems(raw);


    const now = Date.now();
    const periodMs: Record<string, number> = {
      '5m': 5 * 60_000,
      '15m': 15 * 60_000,
      '1h': 60 * 60_000,
    };
    if (period !== 'all' && periodMs[period]) {
      const cutoff = now - periodMs[period];
      items = items.filter(t => t.timestamp >= cutoff);
    }

    if (!items.length) {
      return { period, count: 0, note: 'No tweets in this time window.' };
    }


    const withIds = items.filter(t => t.tweetId).slice(-30);
    const enriched = await this.enrichBatch(withIds.map(t => t.tweetId));

    const tokenFreq = new Map<string, number>();
    const authorFreq = new Map<string, number>();
    const keywordFreq = new Map<string, number>();
    let totalLikes = 0;
    let totalRetweets = 0;

    for (const t of items) {
      for (const tk of [...t.tokens, ...t.relatedTokens]) {
        if (tk) tokenFreq.set(tk, (tokenFreq.get(tk) || 0) + 1);
      }
      const words = (t.gmgnAnalysis || '').toLowerCase().split(/\W+/).filter((w: string) => w.length > 3);
      for (const w of words) {
        keywordFreq.set(w, (keywordFreq.get(w) || 0) + 1);
      }
    }

    for (const t of withIds) {
      const vx = enriched.get(t.tweetId);
      if (vx) {
        const author = vx.user_screen_name || '';
        if (author) authorFreq.set(author, (authorFreq.get(author) || 0) + 1);
        totalLikes += vx.likes || 0;
        totalRetweets += vx.retweets || 0;
      }
    }

    const oldest = items[0]?.timestamp || now;
    const newest = items[items.length - 1]?.timestamp || now;
    const spanMin = Math.max(1, (newest - oldest) / 60_000);

    return {
      period,
      totalTweets: items.length,
      tweetsWithIds: items.filter(t => t.tweetId).length,
      enrichedCount: enriched.size,
      tweetsPerMinute: +(items.length / spanMin).toFixed(1),
      timeSpan: `${spanMin.toFixed(0)} minutes`,
      totalEngagement: { likes: totalLikes, retweets: totalRetweets },
      topTokens: [...tokenFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([token, count]) => ({ token, mentions: count })),
      topAuthors: [...authorFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([author, count]) => ({ author, tweets: count })),
      topKeywords: [...keywordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([w]) => !['http', 'https', 'pump', 'the', 'this', 'that', 'with', 'from', 'will'].includes(w))
        .slice(0, 15)
        .map(([word, count]) => ({ word, count })),
    };
  }
}
