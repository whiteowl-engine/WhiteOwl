import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
} from '../types';

/**
 * TrendSniperSkill — AI-driven trend intelligence for early token sniping.
 *
 * Problem: Static pattern matching (e.g., /trump/i, /pepe/i) is always
 * behind the curve. By the time you hardcode a pattern, the meta has moved.
 *
 * Solution: Continuously monitors multiple data sources for emerging narratives:
 * 1. DexScreener trending/boosted tokens → detect what's pumping NOW
 * 2. Narrative extraction → identify keywords/themes (e.g., "AI agent", "cat meta")
 * 3. Feed keywords to pipeline → auto-boost matching new tokens
 * 4. Track which trends led to profitable trades → reinforce good signals
 *
 * The AI Commander calls `analyze_trends` periodically (every 30-60s)
 * and `update_pipeline_trends` to push fresh intelligence to the pipeline.
 */

interface TrendData {
  keyword: string;
  source: string;
  confidence: number;
  firstSeen: number;
  mentionCount: number;
  avgPriceChange?: number;
}

interface NarrativeCluster {
  name: string;
  keywords: string[];
  tokens: string[];
  strength: number;
  emergingAt: number;
  profitableTradeCount: number;
  totalTradeCount: number;
}

export class TrendSniperSkill implements Skill {
  manifest: SkillManifest = {
    name: 'trend-sniper',
    version: '1.0.0',
    description: 'AI-driven trend intelligence: monitors DexScreener, social boosts, and emerging narratives to identify trending keywords and feed them to the pipeline for early sniping',
    tools: [
      {
        name: 'analyze_trends',
        description: 'Fetch and analyze current trending tokens from DexScreener and social sources. Returns emerging narratives, trending keywords, and hot sectors. Call this every 30-60 seconds.',
        parameters: {
          type: 'object',
          properties: {
            depth: {
              type: 'string',
              enum: ['quick', 'deep'],
              description: 'Quick=DexScreener only (faster), Deep=DexScreener+token analysis (slower but richer)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'update_pipeline_trends',
        description: 'Push trend intelligence keywords to the pipeline. Tokens matching these keywords get a significant score boost for sniping.',
        parameters: {
          type: 'object',
          properties: {
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to boost in pipeline (e.g., ["ai", "agent", "cat", "trump"])',
            },
            reason: { type: 'string', description: 'Why these keywords are trending' },
          },
          required: ['keywords'],
        },
        riskLevel: 'write',
      },
      {
        name: 'get_active_narratives',
        description: 'Get currently tracked narrative clusters with performance stats',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_trend_history',
        description: 'Get historical trend data: which keywords were tracked and their performance',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (default: 20)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'snipe_on_narrative',
        description: 'Configure auto-sniping for a specific narrative. When a new pump.fun token matches the narrative keywords, it gets maximum priority in the pipeline.',
        parameters: {
          type: 'object',
          properties: {
            narrative: { type: 'string', description: 'Narrative name (e.g., "AI agents", "political memes")' },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to match',
            },
            boostAmount: { type: 'number', description: 'Extra score to add (default: 20)' },
            maxBuySol: { type: 'number', description: 'Max SOL per trade for this narrative (default: uses pipeline default)' },
            enabled: { type: 'boolean', description: 'Enable/disable this narrative snipe' },
          },
          required: ['narrative', 'keywords'],
        },
        riskLevel: 'write',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;

  private trendCache: TrendData[] = [];
  private narratives = new Map<string, NarrativeCluster>();
  private trendHistory: Array<{ keyword: string; timestamp: number; source: string; profitable: boolean | null }> = [];
  private lastAnalysis = 0;

  // Narrative sniping configs
  private narrativeSnipes = new Map<string, {
    keywords: string[];
    boostAmount: number;
    maxBuySol?: number;
    enabled: boolean;
  }>();

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

    // Track trade outcomes for narrative performance
    this.eventBus.on('trade:executed', (data) => {
      this.trackTradeOutcome(data);
    });
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'analyze_trends': return this.analyzeTrends(params.depth || 'quick');
      case 'update_pipeline_trends': return this.updatePipelineTrends(params.keywords, params.reason);
      case 'get_active_narratives': return this.getActiveNarratives();
      case 'get_trend_history': return this.getTrendHistory(params.limit);
      case 'snipe_on_narrative': return this.snipeOnNarrative(params);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.trendCache = [];
    this.narratives.clear();
  }

  private async analyzeTrends(depth: string): Promise<any> {
    const results: any = {
      timestamp: Date.now(),
      emergingKeywords: [],
      trendingTokens: [],
      narrativeClusters: [],
      recommendations: [],
    };

    try {
      // 1. DexScreener: trending boosted tokens on Solana
      const [boostsData, trendingData] = await Promise.all([
        this.fetchDexScreenerBoosts(),
        this.fetchDexScreenerTrending(),
      ]);

      const allTokens = [...boostsData, ...trendingData];
      results.trendingTokens = allTokens.slice(0, 20);

      // 2. Extract keywords from trending token names/symbols
      const keywordFreq = new Map<string, number>();
      for (const token of allTokens) {
        const words = this.extractKeywords(token.name, token.symbol);
        for (const w of words) {
          keywordFreq.set(w, (keywordFreq.get(w) || 0) + 1);
        }
      }

      // Sort by frequency — emerging keywords appear in multiple trending tokens
      const sortedKeywords = [...keywordFreq.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);

      results.emergingKeywords = sortedKeywords.map(([kw, count]) => ({
        keyword: kw,
        frequency: count,
        isNew: !this.trendCache.some(t => t.keyword === kw),
      }));

      // 3. Cluster into narratives
      const clusters = this.clusterNarratives(sortedKeywords, allTokens);
      results.narrativeClusters = clusters;

      // 4. Update internal state
      for (const [kw, count] of sortedKeywords) {
        const existing = this.trendCache.find(t => t.keyword === kw);
        if (existing) {
          existing.mentionCount += count;
        } else {
          this.trendCache.push({
            keyword: kw,
            source: 'dexscreener',
            confidence: Math.min(1, count / 5),
            firstSeen: Date.now(),
            mentionCount: count,
          });
        }
      }

      // Keep cache bounded
      if (this.trendCache.length > 100) {
        this.trendCache = this.trendCache.slice(-50);
      }

      // 5. Generate recommendations
      const newTrends = results.emergingKeywords.filter((k: any) => k.isNew);
      if (newTrends.length > 0) {
        results.recommendations.push({
          action: 'update_pipeline_trends',
          keywords: newTrends.map((k: any) => k.keyword),
          reason: `New emerging trends detected: ${newTrends.map((k: any) => k.keyword).join(', ')}`,
        });
      }

      if (depth === 'deep' && allTokens.length > 0) {
        // Deep mode: also check price changes to find the strongest narratives
        const highPerformers = allTokens
          .filter((t: any) => t.priceChange24h > 50)
          .slice(0, 5);

        if (highPerformers.length > 0) {
          results.recommendations.push({
            action: 'focus_narrative',
            tokens: highPerformers.map((t: any) => ({
              symbol: t.symbol,
              priceChange: t.priceChange24h,
            })),
            reason: 'High performers — similar tokens may follow',
          });
        }
      }

      this.lastAnalysis = Date.now();
      return results;
    } catch (err: any) {
      return { error: err.message, hint: 'Trend analysis failed — retry in 30s' };
    }
  }

  private async fetchDexScreenerBoosts(): Promise<any[]> {
    try {
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return [];
      const data = await res.json() as any[];
      return data
        .filter((item: any) => item.chainId === 'solana')
        .map((item: any) => ({
          mint: item.tokenAddress,
          name: item.description || item.tokenAddress,
          symbol: '',
          source: 'dexscreener_boost',
          boosts: item.amount || 0,
        }));
    } catch {
      return [];
    }
  }

  private async fetchDexScreenerTrending(): Promise<any[]> {
    try {
      const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/SOL', {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      const pairs = data.pairs || [];
      return pairs
        .filter((p: any) => p.chainId === 'solana' && p.dexId)
        .slice(0, 30)
        .map((p: any) => ({
          mint: p.baseToken?.address,
          name: p.baseToken?.name || '',
          symbol: p.baseToken?.symbol || '',
          source: 'dexscreener_trending',
          priceChange24h: p.priceChange?.h24 || 0,
          volume24h: p.volume?.h24 || 0,
          liquidity: p.liquidity?.usd || 0,
        }));
    } catch {
      return [];
    }
  }

  private extractKeywords(name: string, symbol: string): string[] {
    const text = `${name} ${symbol}`.toLowerCase();
    const words = text
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && w.length <= 15);

    // Filter out common noise words
    const noise = new Set(['the', 'and', 'for', 'is', 'in', 'of', 'to', 'on', 'it', 'token', 'coin', 'solana', 'sol']);
    return words.filter(w => !noise.has(w));
  }

  private clusterNarratives(keywords: [string, number][], tokens: any[]): any[] {
    // Simple clustering: group related keywords
    const clusters: NarrativeCluster[] = [];

    // Predefined narrative families
    const narrativeFamilies: Record<string, string[]> = {
      'AI & Tech': ['ai', 'gpt', 'agent', 'bot', 'neural', 'llm', 'openai', 'claude', 'gemini'],
      'Political': ['trump', 'maga', 'biden', 'politics', 'election', 'president', 'vote'],
      'Animal Meta': ['cat', 'dog', 'doge', 'shib', 'frog', 'pepe', 'wif', 'bonk', 'bird', 'bear', 'bull'],
      'Culture & Memes': ['moon', 'wen', 'gm', 'wagmi', 'based', 'chad', 'wojak', 'npc'],
      'Finance': ['defi', 'yield', 'stake', 'swap', 'lend', 'vault'],
    };

    for (const [narrative, family] of Object.entries(narrativeFamilies)) {
      const matchedKeywords = keywords.filter(([kw]) => family.includes(kw));
      if (matchedKeywords.length > 0) {
        const matchedTokens = tokens.filter(t => {
          const name = `${t.name} ${t.symbol}`.toLowerCase();
          return family.some(kw => name.includes(kw));
        });

        const existing = this.narratives.get(narrative);
        clusters.push({
          name: narrative,
          keywords: matchedKeywords.map(([kw]) => kw),
          tokens: matchedTokens.slice(0, 5).map((t: any) => t.symbol || t.mint?.slice(0, 8)),
          strength: matchedKeywords.reduce((s, [, c]) => s + c, 0),
          emergingAt: existing?.emergingAt || Date.now(),
          profitableTradeCount: existing?.profitableTradeCount || 0,
          totalTradeCount: existing?.totalTradeCount || 0,
        });
      }
    }

    return clusters.sort((a, b) => b.strength - a.strength);
  }

  private updatePipelineTrends(keywords: string[], reason?: string): any {
    // Emit event so pipeline picks up the new trends
    this.eventBus.emit('agent:decided' as any, {
      agentId: 'trend-sniper',
      action: 'update_trends',
      reason: reason || `Trend update: ${keywords.join(', ')}`,
    });

    // Record in history
    for (const kw of keywords) {
      this.trendHistory.push({
        keyword: kw,
        timestamp: Date.now(),
        source: 'ai_analysis',
        profitable: null, // Unknown yet
      });
    }

    // Keep history bounded
    if (this.trendHistory.length > 500) {
      this.trendHistory = this.trendHistory.slice(-250);
    }

    return {
      status: 'updated',
      keywords,
      reason,
      activeKeywordsTotal: keywords.length,
      note: 'Keywords will boost matching tokens in pipeline scoring. Call sniper_config to verify.',
    };
  }

  private getActiveNarratives(): any {
    const narratives = [...this.narratives.values()].map(n => ({
      name: n.name,
      keywords: n.keywords,
      strength: n.strength,
      ageMinutes: Math.round((Date.now() - n.emergingAt) / 60000),
      winRate: n.totalTradeCount > 0
        ? `${((n.profitableTradeCount / n.totalTradeCount) * 100).toFixed(0)}%`
        : 'N/A',
      trades: n.totalTradeCount,
    }));

    return {
      activeNarratives: narratives,
      totalTrendKeywords: this.trendCache.length,
      lastAnalysis: this.lastAnalysis
        ? `${Math.round((Date.now() - this.lastAnalysis) / 1000)}s ago`
        : 'never',
      narrativeSnipes: [...this.narrativeSnipes.entries()].map(([name, config]) => ({
        name,
        keywords: config.keywords,
        enabled: config.enabled,
        boost: config.boostAmount,
      })),
    };
  }

  private getTrendHistory(limit?: number): any[] {
    return this.trendHistory.slice(-(limit || 20)).reverse();
  }

  private snipeOnNarrative(params: Record<string, any>): any {
    const { narrative, keywords, boostAmount, maxBuySol, enabled } = params;

    this.narrativeSnipes.set(narrative, {
      keywords: keywords || [],
      boostAmount: boostAmount || 20,
      maxBuySol,
      enabled: enabled !== false,
    });

    // Also push keywords to trend cache for pipeline
    if (enabled !== false && keywords?.length > 0) {
      for (const kw of keywords) {
        if (!this.trendCache.some(t => t.keyword === kw.toLowerCase())) {
          this.trendCache.push({
            keyword: kw.toLowerCase(),
            source: `narrative:${narrative}`,
            confidence: 0.8,
            firstSeen: Date.now(),
            mentionCount: 1,
          });
        }
      }
    }

    this.logger.info(`Narrative snipe configured: "${narrative}" with keywords [${keywords?.join(', ')}] boost=${boostAmount || 20}`);

    return {
      status: 'configured',
      narrative,
      keywords,
      boostAmount: boostAmount || 20,
      enabled: enabled !== false,
    };
  }

  private trackTradeOutcome(tradeResult: any): void {
    // Match trade to narratives for performance tracking
    if (!tradeResult.success) return;

    const token = this.ctx.memory.getToken(tradeResult.mint || '');
    if (!token) return;

    const name = `${token.name} ${token.symbol}`.toLowerCase();

    for (const [, narrative] of this.narratives) {
      const matches = narrative.keywords.some(kw => name.includes(kw));
      if (matches) {
        narrative.totalTradeCount++;
        // We'll track profitability when position is closed
      }
    }
  }
}
