import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
  LLMProvider, LLMMessage,
} from '../types';
import { createLLMProvider } from '../llm';

/**
 * AlphaScannerSkill — Social intelligence → auto-snipe.
 *
 * TWO MODES:
 * A) CA Extraction — finds contract addresses in social messages → auto-buy
 * B) Narrative Sniping — reads news, extracts SEMANTIC MEANING via LLM,
 *    then watches for the FIRST token on pump.fun matching that narrative.
 *    Example: news "Trump hospitalized" → hot keywords ["trump", "hospital",
 *    "sick", "rip"] → first token named "TRUMP SICK" or "RIP TRUMP" → instant buy
 *
 * Sources: Telegram channels, Twitter/X, secondary sites (pump.fun, DexScreener)
 * Flow: Source → extract CA/narrative → dedupe → emit signal:buy or narrative:hot → pipeline
 */

// Solana address regex: base58, 32-44 characters
const SOLANA_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const PUMP_FUN_URL_RE = /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/g;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

interface AlphaSource {
  id: string;
  type: 'telegram' | 'twitter' | 'website';
  name: string;
  /** Telegram: channel username. Twitter: account handle or search query. Website: URL */
  target: string;
  enabled: boolean;
  pollIntervalMs: number;
  /** Auto-buy when CA found from this source */
  autoBuy: boolean;
  /** Minimum confidence to trigger auto-buy (0-1) */
  minConfidence: number;
}

interface ExtractedAlpha {
  mint: string;
  ticker?: string;
  source: AlphaSource;
  rawText: string;
  extractedAt: number;
  confidence: number;
}

/** Hot narrative extracted from news — used for semantic token matching */
interface HotNarrative {
  id: string;
  keywords: string[];
  summary: string;
  sourceText: string;
  sourceName: string;
  createdAt: number;
  expiresAt: number;
  autoBuy: boolean;
  buyAmountSol: number;
  /** Tokens already bought for this narrative (prevent double-buy) */
  matchedMints: Set<string>;
  maxBuys: number;
}

export class AlphaScannerSkill implements Skill {
  manifest: SkillManifest = {
    name: 'alpha-scanner',
    version: '1.0.0',
    description: 'Scans Telegram, Twitter, and secondary sites for new token mentions → auto-extracts CA → feeds pipeline for sniping. Real social intelligence for pump.fun.',
    tools: [
      {
        name: 'alpha_add_source',
        description: 'Add a new alpha source to monitor. Types: telegram (channel), twitter (account/search), website (URL to poll)',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['telegram', 'twitter', 'website'], description: 'Source type' },
            name: { type: 'string', description: 'Human-readable name (e.g., "Crypto Calls TG")' },
            target: { type: 'string', description: 'Channel username, Twitter handle, or URL' },
            autoBuy: { type: 'boolean', description: 'Auto-buy tokens found from this source (default: false)' },
            minConfidence: { type: 'number', description: 'Min confidence 0-1 for auto-buy (default: 0.6)' },
            pollIntervalMs: { type: 'number', description: 'Polling interval in ms (default: 30000)' },
          },
          required: ['type', 'name', 'target'],
        },
        riskLevel: 'write',
      },
      {
        name: 'alpha_remove_source',
        description: 'Remove an alpha source by ID',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Source ID to remove' },
          },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'alpha_list_sources',
        description: 'List all configured alpha sources with status',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'alpha_start',
        description: 'Start scanning all enabled alpha sources',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'write',
      },
      {
        name: 'alpha_stop',
        description: 'Stop all alpha source scanning',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'write',
      },
      {
        name: 'alpha_scan_now',
        description: 'Manually trigger an immediate scan of a specific source or all sources',
        parameters: {
          type: 'object',
          properties: {
            sourceId: { type: 'string', description: 'Source ID (omit for all sources)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'alpha_recent',
        description: 'Get recently discovered tokens from alpha sources',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (default: 20)' },
            sourceType: { type: 'string', enum: ['telegram', 'twitter', 'website', 'all'], description: 'Filter by source type' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'alpha_stats',
        description: 'Get alpha scanner statistics: sources, tokens found, auto-buys triggered, hit rate',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'alpha_add_narrative',
        description: 'Manually add a hot narrative to watch for. When a new pump.fun token matches these keywords by name/symbol, it will be auto-bought.',
        parameters: {
          type: 'object',
          properties: {
            keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to match in token names (e.g., ["trump", "rip", "dead"])' },
            summary: { type: 'string', description: 'Brief description of the narrative' },
            autoBuy: { type: 'boolean', description: 'Auto-buy matching tokens (default: true)' },
            buyAmountSol: { type: 'number', description: 'SOL amount per narrative buy (default: 0.1)' },
            maxBuys: { type: 'number', description: 'Max tokens to buy per narrative (default: 3)' },
            ttlMinutes: { type: 'number', description: 'How long narrative stays active (default: 60)' },
          },
          required: ['keywords', 'summary'],
        },
        riskLevel: 'write',
      },
      {
        name: 'alpha_remove_narrative',
        description: 'Remove an active narrative by ID',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Narrative ID' },
          },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'alpha_list_narratives',
        description: 'List all active hot narratives being watched',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'alpha_set_llm',
        description: 'Configure LLM for automatic narrative extraction from news. Without LLM, narratives must be added manually.',
        parameters: {
          type: 'object',
          properties: {
            provider: { type: 'string', description: 'LLM provider name (e.g., groq, openai, ollama)' },
            model: { type: 'string', description: 'Model name (e.g., llama-3.1-70b-versatile)' },
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

  private sources: Map<string, AlphaSource> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private running = false;

  /** Recently found alphas (ring buffer, max 500) */
  private recentAlphas: ExtractedAlpha[] = [];
  private readonly MAX_RECENT = 500;

  /** Dedup: track mints we've already processed */
  private seenMints: Set<string> = new Set();
  private readonly MAX_SEEN = 5000;

  /** Stats */
  private stats = {
    totalScans: 0,
    totalTokensFound: 0,
    totalAutoBuys: 0,
    narrativeBuys: 0,
    narrativesExtracted: 0,
    bySource: new Map<string, { scans: number; found: number; autoBuys: number }>(),
  };

  // ==========================================
  // Narrative Sniping Engine
  // ==========================================
  /** Active hot narratives — keywords extracted from breaking news */
  private narratives: Map<string, HotNarrative> = new Map();
  /** LLM for auto-extracting narratives from news text */
  private llmProvider: LLMProvider | null = null;
  /** Narrative cleanup timer */
  private narrativeCleanupTimer: ReturnType<typeof setInterval> | null = null;

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

    // Listen for new tokens → check against hot narratives
    this.eventBus.on('token:new', (data) => {
      this.checkNarrativeMatch(data.mint, data.name, data.symbol);
    });

    // Periodic cleanup of expired narratives
    this.narrativeCleanupTimer = setInterval(() => this.cleanExpiredNarratives(), 60_000);

    // Add default sources — pump.fun trending + dexscreener
    this.addSource({
      type: 'website',
      name: 'pump.fun Frontend',
      target: 'https://frontend-api-v2.pump.fun/coins/featured',
      autoBuy: false,
      minConfidence: 0.5,
      pollIntervalMs: 30_000,
    });
    this.addSource({
      type: 'website',
      name: 'DexScreener Trending',
      target: 'https://api.dexscreener.com/token-boosts/top/v1',
      autoBuy: false,
      minConfidence: 0.5,
      pollIntervalMs: 30_000,
    });
    this.addSource({
      type: 'website',
      name: 'pump.fun Latest',
      target: 'https://frontend-api-v2.pump.fun/coins/latest',
      autoBuy: false,
      minConfidence: 0.4,
      pollIntervalMs: 15_000,
    });
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'alpha_add_source': return this.addSource(params as any);
      case 'alpha_remove_source': return this.removeSource(params.id);
      case 'alpha_list_sources': return this.listSources();
      case 'alpha_start': return this.startScanning();
      case 'alpha_stop': return this.stopScanning();
      case 'alpha_scan_now': return this.scanNow(params.sourceId);
      case 'alpha_recent': return this.getRecent(params.limit, params.sourceType);
      case 'alpha_stats': return this.getStats();
      case 'alpha_add_narrative': return this.addNarrative(params as any);
      case 'alpha_remove_narrative': return this.removeNarrative(params.id);
      case 'alpha_list_narratives': return this.listNarratives();
      case 'alpha_set_llm': return this.setLLM(params as any);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopScanning();
    if (this.narrativeCleanupTimer) {
      clearInterval(this.narrativeCleanupTimer);
      this.narrativeCleanupTimer = null;
    }
  }

  // ==========================================
  // Source Management
  // ==========================================

  private addSource(params: {
    type: AlphaSource['type'];
    name: string;
    target: string;
    autoBuy?: boolean;
    minConfidence?: number;
    pollIntervalMs?: number;
  }): { status: string; source: AlphaSource } {
    const id = `${params.type}_${Date.now().toString(36)}`;
    const source: AlphaSource = {
      id,
      type: params.type,
      name: params.name,
      target: params.target,
      enabled: true,
      pollIntervalMs: params.pollIntervalMs ?? 30_000,
      autoBuy: params.autoBuy ?? false,
      minConfidence: params.minConfidence ?? 0.6,
    };

    this.sources.set(id, source);
    this.stats.bySource.set(id, { scans: 0, found: 0, autoBuys: 0 });

    // If already running, start polling this source
    if (this.running) {
      this.startSourcePolling(source);
    }

    this.logger.info(`Alpha source added: [${source.type}] ${source.name} → ${source.target}`);
    return { status: 'added', source };
  }

  private removeSource(id: string): { status: string } {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    this.sources.delete(id);
    this.stats.bySource.delete(id);
    return { status: 'removed' };
  }

  private listSources(): { sources: Array<AlphaSource & { stats: any }> } {
    const sources = Array.from(this.sources.values()).map(s => ({
      ...s,
      stats: this.stats.bySource.get(s.id) || { scans: 0, found: 0, autoBuys: 0 },
    }));
    return { sources };
  }

  // ==========================================
  // Scanning Engine
  // ==========================================

  private startScanning(): { status: string; sources: number } {
    if (this.running) return { status: 'already_running', sources: this.sources.size };

    this.running = true;
    for (const source of this.sources.values()) {
      if (source.enabled) {
        this.startSourcePolling(source);
      }
    }

    this.logger.info(`Alpha scanner STARTED: ${this.sources.size} sources`);
    return { status: 'started', sources: this.sources.size };
  }

  private stopScanning(): { status: string } {
    this.running = false;
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.logger.info('Alpha scanner STOPPED');
    return { status: 'stopped' };
  }

  private startSourcePolling(source: AlphaSource): void {
    // Initial scan
    this.pollSource(source);

    // Periodic polling
    const timer = setInterval(() => {
      this.pollSource(source);
    }, source.pollIntervalMs);

    this.timers.set(source.id, timer);
  }

  private async scanNow(sourceId?: string): Promise<{ scanned: number; found: number }> {
    let scanned = 0;
    let found = 0;

    if (sourceId) {
      const source = this.sources.get(sourceId);
      if (!source) return { scanned: 0, found: 0 };
      const results = await this.pollSource(source);
      return { scanned: 1, found: results.length };
    }

    for (const source of this.sources.values()) {
      if (source.enabled) {
        const results = await this.pollSource(source);
        scanned++;
        found += results.length;
      }
    }

    return { scanned, found };
  }

  // ==========================================
  // Source-specific Polling
  // ==========================================

  private async pollSource(source: AlphaSource): Promise<ExtractedAlpha[]> {
    try {
      const sourceStats = this.stats.bySource.get(source.id);
      if (sourceStats) sourceStats.scans++;
      this.stats.totalScans++;

      let alphas: ExtractedAlpha[] = [];
      let rawTexts: string[] = [];

      switch (source.type) {
        case 'telegram': {
          const result = await this.pollTelegram(source);
          alphas = result.alphas;
          rawTexts = result.texts;
          break;
        }
        case 'twitter': {
          const result = await this.pollTwitter(source);
          alphas = result.alphas;
          rawTexts = result.texts;
          break;
        }
        case 'website':
          alphas = await this.pollWebsite(source);
          break;
      }

      // Dedupe and process
      const newAlphas = alphas.filter(a => !this.seenMints.has(a.mint));
      for (const alpha of newAlphas) {
        this.trackSeen(alpha.mint);
        this.addRecentAlpha(alpha);

        if (sourceStats) sourceStats.found++;
        this.stats.totalTokensFound++;

        // Emit to pipeline
        this.eventBus.emit('token:new', {
          mint: alpha.mint,
          name: alpha.ticker || alpha.mint.slice(0, 8),
          symbol: alpha.ticker || '???',
          dev: '',
          timestamp: Date.now(),
        });

        // Auto-buy if configured
        if (source.autoBuy && alpha.confidence >= source.minConfidence) {
          this.eventBus.emit('signal:buy', {
            mint: alpha.mint,
            score: Math.round(alpha.confidence * 100),
            reason: `Alpha scanner: ${source.name} [${source.type}]`,
            agentId: 'alpha-scanner',
          });

          if (sourceStats) sourceStats.autoBuys++;
          this.stats.totalAutoBuys++;

          this.logger.info(`Alpha AUTO-BUY: ${alpha.mint.slice(0, 12)}... from ${source.name} (confidence: ${alpha.confidence.toFixed(2)})`);
        }
      }

      // LLM narrative extraction — analyze news text for semantic meaning
      if (this.llmProvider && alphas.length === 0) {
        // No CAs found → this might be a pure news message → extract narrative
        await this.tryExtractNarrative(rawTexts, source);
      }

      if (newAlphas.length > 0) {
        this.logger.debug(`Alpha scan [${source.name}]: ${newAlphas.length} new tokens`);
      }

      return newAlphas;
    } catch (err: any) {
      this.logger.debug(`Alpha scan error [${source.name}]: ${err.message}`);
      return [];
    }
  }

  // ==========================================
  // Telegram Polling
  // ==========================================

  /**
   * Poll Telegram channel for new messages with CAs.
   *
   * Uses Telegram Bot API (requires TELEGRAM_BOT_TOKEN env).
   * Bot must be added to the target channel as a member.
   *
   * If no bot token — falls back to public Telegram web preview scraping.
   */
  private async pollTelegram(source: AlphaSource): Promise<{ alphas: ExtractedAlpha[]; texts: string[] }> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      return this.pollTelegramBot(source, botToken);
    }
    return this.pollTelegramPublic(source);
  }

  private async pollTelegramBot(source: AlphaSource, botToken: string): Promise<{ alphas: ExtractedAlpha[]; texts: string[] }> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?limit=50&timeout=0`,
        { signal: AbortSignal.timeout(10_000) }
      );

      if (!res.ok) return { alphas: [], texts: [] };
      const data = await res.json() as any;

      if (!data.ok || !data.result) return { alphas: [], texts: [] };

      const alphas: ExtractedAlpha[] = [];
      const texts: string[] = [];

      for (const update of data.result) {
        const msg = update.message || update.channel_post;
        if (!msg?.text) continue;

        const msgAge = Date.now() / 1000 - msg.date;
        if (msgAge > 300) continue;

        texts.push(msg.text);
        const extracted = this.extractFromText(msg.text, source);
        alphas.push(...extracted);
      }

      return { alphas, texts };
    } catch {
      return { alphas: [], texts: [] };
    }
  }

  private async pollTelegramPublic(source: AlphaSource): Promise<{ alphas: ExtractedAlpha[]; texts: string[] }> {
    try {
      const channel = source.target.replace(/^@/, '');
      const res = await fetch(
        `https://t.me/s/${channel}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!res.ok) return { alphas: [], texts: [] };
      const html = await res.text();

      const messageTexts: string[] = [];
      const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
      let match;
      while ((match = msgRegex.exec(html)) !== null) {
        const text = match[1].replace(/<[^>]+>/g, ' ').trim();
        if (text.length > 5) messageTexts.push(text);
      }

      const recent = messageTexts.slice(-20);
      const alphas: ExtractedAlpha[] = [];
      for (const text of recent) {
        alphas.push(...this.extractFromText(text, source));
      }

      return { alphas, texts: recent };
    } catch {
      return { alphas: [], texts: [] };
    }
  }

  // ==========================================
  // Twitter Polling
  // ==========================================

  /**
   * Poll Twitter for token mentions.
   *
   * Strategy:
   * 1. If TWITTER_BEARER_TOKEN set → use Twitter API v2 search
   * 2. Fallback → scrape via Nitter instances or RSSHub
   */
  private async pollTwitter(source: AlphaSource): Promise<{ alphas: ExtractedAlpha[]; texts: string[] }> {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (bearerToken) {
      return this.pollTwitterAPI(source, bearerToken);
    }
    return this.pollTwitterFallback(source);
  }

  private async pollTwitterAPI(source: AlphaSource, bearerToken: string): Promise<{ alphas: ExtractedAlpha[]; texts: string[] }> {
    try {
      const query = encodeURIComponent(`${source.target} pump.fun OR solana`);
      const res = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=created_at,text`,
        {
          headers: { 'Authorization': `Bearer ${bearerToken}` },
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!res.ok) return { alphas: [], texts: [] };
      const data = await res.json() as any;

      if (!data.data) return { alphas: [], texts: [] };

      const alphas: ExtractedAlpha[] = [];
      const texts: string[] = [];
      for (const tweet of data.data) {
        texts.push(tweet.text);
        alphas.push(...this.extractFromText(tweet.text, source));
      }

      return { alphas, texts };
    } catch {
      return { alphas: [], texts: [] };
    }
  }

  private async pollTwitterFallback(source: AlphaSource): Promise<{ alphas: ExtractedAlpha[]; texts: string[] }> {
    const nitterInstances = [
      'nitter.privacydev.net',
      'nitter.poast.org',
      'nitter.woodland.cafe',
    ];

    const handle = source.target.replace(/^@/, '');

    for (const instance of nitterInstances) {
      try {
        const res = await fetch(
          `https://${instance}/${handle}/rss`,
          {
            headers: { 'Accept': 'application/rss+xml, text/xml' },
            signal: AbortSignal.timeout(8_000),
          }
        );

        if (!res.ok) continue;
        const xml = await res.text();

        const alphas: ExtractedAlpha[] = [];
        const texts: string[] = [];
        const itemRegex = /<description[^>]*>([\s\S]*?)<\/description>/g;
        let match;
        while ((match = itemRegex.exec(xml)) !== null) {
          const text = match[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
          texts.push(text);
          alphas.push(...this.extractFromText(text, source));
        }

        if (alphas.length > 0 || texts.length > 0) return { alphas, texts };
      } catch {
        continue;
      }
    }

    return { alphas: [], texts: [] };
  }

  // ==========================================
  // Website Polling
  // ==========================================

  private async pollWebsite(source: AlphaSource): Promise<ExtractedAlpha[]> {
    try {
      const res = await fetch(source.target, {
        headers: {
          'Accept': 'application/json, text/html',
          'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) return [];

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('json')) {
        return this.parseJsonResponse(await res.json(), source);
      }

      // HTML — extract CAs from page text
      const html = await res.text();
      const text = html.replace(/<[^>]+>/g, ' ');
      return this.extractFromText(text, source);
    } catch {
      return [];
    }
  }

  private parseJsonResponse(data: any, source: AlphaSource): ExtractedAlpha[] {
    const alphas: ExtractedAlpha[] = [];
    const items = Array.isArray(data) ? data : (data.data || data.coins || data.tokens || data.pairs || []);

    for (const item of items.slice(0, 50)) {
      // Try common field names for mint address
      const mint = item.mint || item.tokenAddress || item.address || item.baseToken?.address;
      if (!mint || typeof mint !== 'string') continue;

      // Validate it looks like a Solana address
      if (mint.length < 32 || mint.length > 44) continue;

      const ticker = item.symbol || item.name || item.baseToken?.symbol;
      const confidence = this.estimateConfidence(item, source);

      alphas.push({
        mint,
        ticker,
        source,
        rawText: JSON.stringify(item).slice(0, 200),
        extractedAt: Date.now(),
        confidence,
      });
    }

    return alphas;
  }

  // ==========================================
  // Text Extraction Engine
  // ==========================================

  private extractFromText(text: string, source: AlphaSource): ExtractedAlpha[] {
    const alphas: ExtractedAlpha[] = [];
    const foundMints = new Set<string>();

    // 1. Extract pump.fun URLs (highest confidence)
    PUMP_FUN_URL_RE.lastIndex = 0;
    let match;
    while ((match = PUMP_FUN_URL_RE.exec(text)) !== null) {
      const mint = match[1];
      if (!foundMints.has(mint)) {
        foundMints.add(mint);
        alphas.push({
          mint,
          source,
          rawText: text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30),
          extractedAt: Date.now(),
          confidence: 0.9, // pump.fun URL is very high confidence
        });
      }
    }

    // 2. Extract raw Solana addresses
    SOLANA_ADDRESS_RE.lastIndex = 0;
    while ((match = SOLANA_ADDRESS_RE.exec(text)) !== null) {
      const mint = match[0];
      if (!foundMints.has(mint) && this.looksLikeSolanaAddress(mint)) {
        foundMints.add(mint);
        alphas.push({
          mint,
          source,
          rawText: text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30),
          extractedAt: Date.now(),
          confidence: 0.7,
        });
      }
    }

    // 3. Extract $TICKER mentions (lower confidence — need pipeline to resolve)
    TICKER_RE.lastIndex = 0;
    while ((match = TICKER_RE.exec(text)) !== null) {
      // We can't convert ticker to mint here, but we store it for context
      // The AI Commander can later resolve tickers to mints via DexScreener
    }

    return alphas;
  }

  /**
   * Additional validation that a string is a real Solana address.
   * Filters out common false positives (hex strings, UUIDs, etc.)
   */
  private looksLikeSolanaAddress(addr: string): boolean {
    // Must be 32-44 chars
    if (addr.length < 32 || addr.length > 44) return false;
    // Must not be all-lowercase or all-uppercase (base58 has mixed case)
    if (addr === addr.toLowerCase() || addr === addr.toUpperCase()) return false;
    // Must not contain 0, O, I, l (not in base58)
    if (/[0OIl]/.test(addr)) return false;
    return true;
  }

  private estimateConfidence(item: any, source: AlphaSource): number {
    let confidence = 0.5;

    // Boost for social presence
    if (item.twitter || item.socials?.length > 0) confidence += 0.1;
    if (item.website || item.websites?.length > 0) confidence += 0.1;

    // Boost for volume/activity
    if (item.volume?.h24 > 10_000) confidence += 0.1;
    if (item.txns?.h24?.buys > 50) confidence += 0.1;

    // Boost for boosts (DexScreener)
    if (item.amount > 0 || item.totalAmount > 0) confidence += 0.15;

    return Math.min(confidence, 1.0);
  }

  // ==========================================
  // Helpers
  // ==========================================

  private trackSeen(mint: string): void {
    this.seenMints.add(mint);
    // Evict oldest when exceeding limit
    if (this.seenMints.size > this.MAX_SEEN) {
      const first = this.seenMints.values().next().value;
      if (first) this.seenMints.delete(first);
    }
  }

  private addRecentAlpha(alpha: ExtractedAlpha): void {
    this.recentAlphas.push(alpha);
    if (this.recentAlphas.length > this.MAX_RECENT) {
      this.recentAlphas.shift();
    }
  }

  private getRecent(limit: number = 20, sourceType?: string): { alphas: ExtractedAlpha[] } {
    let filtered = this.recentAlphas;
    if (sourceType && sourceType !== 'all') {
      filtered = filtered.filter(a => a.source.type === sourceType);
    }
    return { alphas: filtered.slice(-limit).reverse() };
  }

  private getStats(): any {
    const bySource: Record<string, any> = {};
    for (const [id, stats] of this.stats.bySource) {
      const source = this.sources.get(id);
      if (source) {
        bySource[source.name] = {
          type: source.type,
          ...stats,
          autoBuy: source.autoBuy,
        };
      }
    }

    return {
      running: this.running,
      totalSources: this.sources.size,
      totalScans: this.stats.totalScans,
      totalTokensFound: this.stats.totalTokensFound,
      totalAutoBuys: this.stats.totalAutoBuys,
      narrativeBuys: this.stats.narrativeBuys,
      narrativesExtracted: this.stats.narrativesExtracted,
      activeNarratives: this.narratives.size,
      seenMintsCache: this.seenMints.size,
      recentAlphasBuffer: this.recentAlphas.length,
      llmConfigured: !!this.llmProvider,
      bySource,
    };
  }

  // ==========================================
  // Narrative Sniping Engine
  //
  // Reads breaking news → LLM extracts semantic keywords →
  // when pump.fun token matches keywords by name → instant buy.
  //
  // Example: "Trump hospitalized" → ["trump", "hospital", "sick", "rip"]
  // → first token named "TRUMP HOSPITAL" or "$RIPTRUMP" → auto-buy
  // ==========================================

  private addNarrative(params: {
    keywords: string[];
    summary: string;
    autoBuy?: boolean;
    buyAmountSol?: number;
    maxBuys?: number;
    ttlMinutes?: number;
  }): { status: string; narrative: { id: string; keywords: string[]; summary: string; expiresIn: string } } {
    const id = `nar_${Date.now().toString(36)}`;
    const ttlMs = (params.ttlMinutes ?? 60) * 60_000;

    const narrative: HotNarrative = {
      id,
      keywords: params.keywords.map(k => k.toLowerCase().trim()),
      summary: params.summary,
      sourceText: 'manual',
      sourceName: 'manual',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      autoBuy: params.autoBuy ?? true,
      buyAmountSol: params.buyAmountSol ?? 0.1,
      matchedMints: new Set(),
      maxBuys: params.maxBuys ?? 3,
    };

    this.narratives.set(id, narrative);

    // Push keywords to pipeline as trend boosts
    this.pushNarrativeKeywordsToPipeline();

    this.logger.info(`Narrative added: "${params.summary}" → [${narrative.keywords.join(', ')}] (TTL: ${params.ttlMinutes ?? 60}min)`);
    return {
      status: 'added',
      narrative: {
        id,
        keywords: narrative.keywords,
        summary: narrative.summary,
        expiresIn: `${params.ttlMinutes ?? 60}min`,
      },
    };
  }

  private removeNarrative(id: string): { status: string } {
    this.narratives.delete(id);
    this.pushNarrativeKeywordsToPipeline();
    return { status: 'removed' };
  }

  private listNarratives(): { narratives: Array<{ id: string; keywords: string[]; summary: string; matched: number; maxBuys: number; ttlRemaining: string }> } {
    const now = Date.now();
    const result = Array.from(this.narratives.values()).map(n => ({
      id: n.id,
      keywords: n.keywords,
      summary: n.summary,
      matched: n.matchedMints.size,
      maxBuys: n.maxBuys,
      ttlRemaining: `${Math.max(0, Math.round((n.expiresAt - now) / 60_000))}min`,
    }));
    return { narratives: result };
  }

  private setLLM(params: { provider: string; model: string; apiKey?: string }): { status: string } {
    this.llmProvider = createLLMProvider({
      provider: params.provider as any,
      model: params.model,
      apiKey: params.apiKey,
      temperature: 0.3,
      maxTokens: 500,
    });
    this.logger.info(`Alpha scanner LLM set: ${params.provider}/${params.model}`);
    return { status: 'configured' };
  }

  /**
   * Check if a new token's name/symbol matches any active hot narrative.
   * This is called on every token:new event — must be fast.
   */
  private checkNarrativeMatch(mint: string, name: string, symbol: string): void {
    if (this.narratives.size === 0) return;

    const nameLower = name.toLowerCase();
    const symLower = symbol.toLowerCase();

    for (const narrative of this.narratives.values()) {
      // Skip expired or maxed-out narratives
      if (Date.now() > narrative.expiresAt) continue;
      if (narrative.matchedMints.size >= narrative.maxBuys) continue;
      if (narrative.matchedMints.has(mint)) continue;

      // Check if token name/symbol contains any narrative keyword
      let matchCount = 0;
      const matched: string[] = [];
      for (const kw of narrative.keywords) {
        if (nameLower.includes(kw) || symLower.includes(kw)) {
          matchCount++;
          matched.push(kw);
        }
      }

      // Require at least 1 keyword match (for short keywords require 2+)
      const minMatches = narrative.keywords.some(k => k.length <= 3) ? 2 : 1;
      if (matchCount < minMatches) continue;

      narrative.matchedMints.add(mint);

      this.logger.info(
        `NARRATIVE MATCH: "${name}" (${symbol}) matches "${narrative.summary}" ` +
        `keywords=[${matched.join(',')}] (${narrative.matchedMints.size}/${narrative.maxBuys})`
      );

      if (narrative.autoBuy) {
        this.eventBus.emit('signal:buy', {
          mint,
          score: 90,
          reason: `Narrative snipe: "${narrative.summary}" matched [${matched.join(',')}]`,
          agentId: 'alpha-scanner',
        });
        this.stats.narrativeBuys++;
      }
    }
  }

  /**
   * Try to extract a hot narrative from news text using LLM.
   * Called when social sources contain text but no CAs — indicates pure news.
   */
  private async tryExtractNarrative(texts: string[], source: AlphaSource): Promise<void> {
    if (!this.llmProvider || texts.length === 0) return;

    // Combine recent texts, limit size
    const combined = texts.slice(-5).join('\n---\n').slice(0, 2000);
    if (combined.length < 20) return;

    try {
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: `You are a crypto memecoin narrative detector. Analyze news/social media text and extract BREAKING narratives that could spawn memecoin tokens on pump.fun.

Rules:
- Only extract MAJOR events (deaths, scandals, memes, viral moments)
- Return keywords that would appear in token NAMES on pump.fun
- Include variations (e.g., for "Trump shot" → trump, shot, shooter, assassination, rip)
- Only real breaking news, not general crypto discussion
- If no actionable narrative found, return empty

Respond ONLY with JSON: {"narrative": "brief summary", "keywords": ["keyword1", "keyword2", ...]}
Or if no narrative: {"narrative": "", "keywords": []}`,
        },
        {
          role: 'user',
          content: `Extract memecoin narrative from these messages:\n\n${combined}`,
        },
      ];

      const response = await this.llmProvider.chat(messages);
      const content = response.content.trim();

      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.narrative || !parsed.keywords?.length) return;

      // Auto-add as hot narrative
      this.addNarrative({
        keywords: parsed.keywords,
        summary: parsed.narrative,
        autoBuy: true,
        buyAmountSol: 0.1,
        maxBuys: 3,
        ttlMinutes: 30,
      });

      this.stats.narrativesExtracted++;
      this.logger.info(`LLM narrative extracted from ${source.name}: "${parsed.narrative}" → [${parsed.keywords.join(', ')}]`);
    } catch (err: any) {
      this.logger.debug(`Narrative extraction failed: ${err.message}`);
    }
  }

  /** Push all active narrative keywords to pipeline as trend boosts */
  private pushNarrativeKeywordsToPipeline(): void {
    const allKeywords: string[] = [];
    for (const narrative of this.narratives.values()) {
      if (Date.now() < narrative.expiresAt) {
        allKeywords.push(...narrative.keywords);
      }
    }
    // Emit narrative:hot event for pipeline to pick up
    this.eventBus.emit('narrative:hot' as any, { keywords: allKeywords });
  }

  /** Remove expired narratives */
  private cleanExpiredNarratives(): void {
    const now = Date.now();
    for (const [id, narrative] of this.narratives) {
      if (now > narrative.expiresAt) {
        this.narratives.delete(id);
        this.logger.debug(`Narrative expired: "${narrative.summary}"`);
      }
    }
  }
}
