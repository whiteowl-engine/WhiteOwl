import { EventBusInterface, LoggerInterface, MemoryInterface, TokenInfo } from '../types';

// =====================================================
// Self-learning signal weights
// Adjusted automatically based on trade outcomes
// =====================================================

export interface SignalWeights {
  socials: number;       // Weight for social presence signals
  bondingCurve: number;  // Weight for bonding curve position
  devWallet: number;     // Weight for dev wallet quality
  holders: number;       // Weight for holder distribution
  trending: number;      // Weight for trend matches
  nameQuality: number;   // Weight for name/symbol quality
  behavioral: number;    // Weight for on-chain behavioral analysis
  security: number;      // Weight for mint/freeze authority & LP checks
}

const DEFAULT_WEIGHTS: SignalWeights = {
  socials: 1.0,
  bondingCurve: 1.0,
  devWallet: 1.0,
  holders: 1.0,
  trending: 1.0,
  nameQuality: 1.0,
  behavioral: 1.0,
  security: 1.0,
};

// =====================================================
// Dev Behavior Tracker — Anti-gaming layer
//
// Tracks on-chain BEHAVIORAL signals that CANNOT be faked:
// - Dev creation velocity (launching too many tokens = serial rugger)
// - Funding source analysis (freshly funded wallet = suspicious)
// - Cross-dev wallet clustering (same funder = coordinated rug)
// - Token lifetime statistics (dev's history of quick dumps)
//
// Scammers can fake: name, socials, description, website.
// Scammers CANNOT fake: wallet age, tx history, funding flow,
// creation patterns, on-chain behavior.
// =====================================================

class DevBehaviorTracker {
  /** dev address → creation timestamps */
  private devCreations = new Map<string, number[]>();
  /** dev address → funding source (first large inbound SOL tx) */
  private devFundingSources = new Map<string, string>();
  /** funding source → set of dev addresses funded */
  private funderToDevs = new Map<string, Set<string>>();
  /** dev address → avg token lifetime in minutes before rug */
  private devTokenLifetimes = new Map<string, number[]>();
  /** dev address → total tokens created (ever seen) */
  private devTotalCreated = new Map<string, number>();

  private readonly VELOCITY_WINDOW_MS = 3600_000; // 1 hour
  private readonly MAX_DEVS = 50_000;

  /**
   * Record a new token creation by this dev.
   */
  recordCreation(dev: string): void {
    if (!dev) return;

    const now = Date.now();
    const timestamps = this.devCreations.get(dev) || [];
    timestamps.push(now);
    // Keep only last hour
    const cutoff = now - this.VELOCITY_WINDOW_MS;
    const filtered = timestamps.filter(t => t > cutoff);
    this.devCreations.set(dev, filtered);

    this.devTotalCreated.set(dev, (this.devTotalCreated.get(dev) || 0) + 1);

    this.evictIfNeeded();
  }

  /**
   * Record a funding source for a dev wallet.
   */
  recordFundingSource(dev: string, funder: string): void {
    if (!dev || !funder) return;
    this.devFundingSources.set(dev, funder);

    const devSet = this.funderToDevs.get(funder) || new Set();
    devSet.add(dev);
    this.funderToDevs.set(funder, devSet);
  }

  /**
   * Record token lifetime (how long before dev dumped/rugged).
   */
  recordTokenLifetime(dev: string, lifetimeMinutes: number): void {
    if (!dev) return;
    const lifetimes = this.devTokenLifetimes.get(dev) || [];
    lifetimes.push(lifetimeMinutes);
    if (lifetimes.length > 20) lifetimes.shift();
    this.devTokenLifetimes.set(dev, lifetimes);
  }

  /**
   * Score a dev's behavior 0-100 (higher = more trustworthy).
   * All signals are on-chain and CANNOT be faked.
   */
  scoreDev(dev: string): { score: number; signals: string[] } {
    if (!dev) return { score: 50, signals: [] };

    const signals: string[] = [];
    let score = 60; // neutral-positive baseline

    // 1) Creation velocity — serial launchers are almost always scammers
    const recentCreations = this.devCreations.get(dev) || [];
    const creationsLastHour = recentCreations.length;
    if (creationsLastHour >= 5) {
      score -= 40;
      signals.push(`serial_launcher_${creationsLastHour}/hr`);
    } else if (creationsLastHour >= 3) {
      score -= 25;
      signals.push(`high_velocity_${creationsLastHour}/hr`);
    } else if (creationsLastHour >= 2) {
      score -= 10;
      signals.push('multi_launch');
    }

    // 2) Total tokens created — repeat deployers are suspicious
    const totalCreated = this.devTotalCreated.get(dev) || 0;
    if (totalCreated >= 10) {
      score -= 20;
      signals.push(`${totalCreated}_total_tokens`);
    } else if (totalCreated >= 5) {
      score -= 10;
      signals.push('repeat_deployer');
    } else if (totalCreated === 1) {
      score += 5;
      signals.push('first_token');
    }

    // 3) Funding source clustering — same funder = coordinated scam ring
    const funder = this.devFundingSources.get(dev);
    if (funder) {
      const siblingsCount = (this.funderToDevs.get(funder)?.size || 1) - 1;
      if (siblingsCount >= 5) {
        score -= 35;
        signals.push(`scam_ring_${siblingsCount + 1}_devs`);
      } else if (siblingsCount >= 2) {
        score -= 15;
        signals.push(`shared_funder_${siblingsCount + 1}`);
      }
    }

    // 4) Historical token lifetimes — if dev's tokens die quickly, suspicious
    const lifetimes = this.devTokenLifetimes.get(dev) || [];
    if (lifetimes.length >= 2) {
      const avgLifetime = lifetimes.reduce((a, b) => a + b, 0) / lifetimes.length;
      if (avgLifetime < 5) {
        score -= 30;
        signals.push(`avg_lifetime_${avgLifetime.toFixed(1)}min`);
      } else if (avgLifetime < 15) {
        score -= 15;
        signals.push('short_lived_tokens');
      } else if (avgLifetime > 60) {
        score += 10;
        signals.push('lasting_tokens');
      }
    }

    score = Math.max(0, Math.min(100, score));
    return { score, signals };
  }

  private evictIfNeeded(): void {
    if (this.devCreations.size > this.MAX_DEVS) {
      const toDelete = Math.floor(this.MAX_DEVS * 0.2);
      const iter = this.devCreations.keys();
      for (let i = 0; i < toDelete; i++) {
        const key = iter.next().value;
        if (key !== undefined) {
          this.devCreations.delete(key);
          this.devTotalCreated.delete(key);
        }
      }
    }
  }
}

// =====================================================
// Token Analysis Pipeline
//
// Architecture: 5-stage progressive filter
//
// pump.fun WS → Stage 0 (instant) → Stage 1 (instant) → Stage 2 (<5ms)
//            → Stage 3 (async pool, <200ms) → Stage 4 (trade decision)
//            → [optional] Stage 5 (async LLM review, non-blocking)
//
// Stage 0: Instant kill — known ruggers, blacklist. Drops ~30% of tokens. <0.1ms
// Stage 1: Pattern filter — garbage names, missing data. Drops ~40%. <0.5ms
// Stage 2: Fast score — socials, bonding curve, mcap, name heuristics. <2ms
// Stage 3: Deep check — dev wallet + holders via network (worker pool). <200ms
// Stage 4: Entry decision — combined score threshold. <0.1ms
//
// At 1 token/sec from pump.fun, a pool of 8 workers handles
// Stage 3 at 40 tokens/sec throughput (200ms each, concurrent).
//
// LLM is NEVER in the critical path. It only reviews
// positions already entered (Stage 5, fire-and-forget).
// =====================================================

export interface PipelineConfig {
  workers: number;
  queueLimit: number;
  stage2MinScore: number;
  stage4BuyThreshold: number;
  enableDeepCheck: boolean;
  enableLlmReview: boolean;
  buyAmountSol: number;
  slippageBps: number;
  requireSocials: boolean;
  blacklistPatterns: RegExp[];
  blacklistDevs: Set<string>;
  trendingPatterns: RegExp[];
  /** Trend-boosted mints from AI intelligence (auto-managed) */
  trendBoostedMints: Set<string>;
  /** Self-learning weight adjustments from trade outcomes */
  learnedWeights: SignalWeights;
}

interface PipelineStats {
  received: number;
  killedStage0: number;
  killedStage1: number;
  killedStage2: number;
  passedToDeep: number;
  killedStage3: number;
  approvedStage4: number;
  tradesEmitted: number;
  queueDropped: number;
  avgStage2Ms: number;
  avgStage3Ms: number;
  p99Stage2Ms: number;
  p99Stage3Ms: number;
  tokensPerSec: number;
  workerUtilization: number;
  cacheHitRate: number;
  startedAt: number;
}

interface TokenCandidate {
  mint: string;
  name: string;
  symbol: string;
  dev: string;
  token: TokenInfo;
  stage2Score: number;
  stage2Signals: string[];
  receivedAt: number;
  priority: number;
}

interface WorkerSlot {
  busy: boolean;
  currentMint: string | null;
  tasksSinceIdle: number;
}

interface DeepCheckResult {
  devBalanceSol: number;
  devAge: number;
  devTxCount: number;
  holders: number;
  top10Pct: number;
  isBundled: boolean;
  isKnownRug: boolean;
  score: number;
  signals: string[];
}

export class TokenPipeline {
  private config: PipelineConfig;
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private memory: MemoryInterface;
  private cache: AnalysisCache;
  private stats: PipelineStats;
  private queue: TokenCandidate[] = [];
  private workers: WorkerSlot[];
  private processing = false;
  private solanaRpc: string;
  private heliusKey: string;
  private enabled = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private stage2Latencies: number[] = [];
  private stage3Latencies: number[] = [];
  private behaviorTracker: DevBehaviorTracker;

  constructor(opts: {
    config: Partial<PipelineConfig>;
    eventBus: EventBusInterface;
    logger: LoggerInterface;
    memory: MemoryInterface;
    solanaRpc: string;
    heliusKey?: string;
  }) {
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.memory = opts.memory;
    this.solanaRpc = opts.solanaRpc;
    this.heliusKey = opts.heliusKey || '';

    this.config = {
      workers: 8,
      queueLimit: 200,
      stage2MinScore: 40,
      stage4BuyThreshold: 65,
      enableDeepCheck: true,
      enableLlmReview: false,
      buyAmountSol: 0.1,
      slippageBps: 2000,
      requireSocials: true,
      blacklistPatterns: [],
      blacklistDevs: new Set(),
      trendingPatterns: [
        /trump/i, /elon/i, /musk/i, /pepe/i, /doge/i,
        /shib/i, /ai\b/i, /gpt/i, /cat/i, /moon/i,
        /sol\b/i, /bonk/i, /wif/i, /jup/i,
      ],
      trendBoostedMints: new Set(),
      learnedWeights: { ...DEFAULT_WEIGHTS },
      ...opts.config,
    };

    this.behaviorTracker = new DevBehaviorTracker();

    this.workers = Array.from({ length: this.config.workers }, () => ({
      busy: false,
      currentMint: null,
      tasksSinceIdle: 0,
    }));

    this.cache = new AnalysisCache(10_000, 5 * 60_000); // 10k entries, 5min TTL

    this.stats = {
      received: 0,
      killedStage0: 0,
      killedStage1: 0,
      killedStage2: 0,
      passedToDeep: 0,
      killedStage3: 0,
      approvedStage4: 0,
      tradesEmitted: 0,
      queueDropped: 0,
      avgStage2Ms: 0,
      avgStage3Ms: 0,
      p99Stage2Ms: 0,
      p99Stage3Ms: 0,
      tokensPerSec: 0,
      workerUtilization: 0,
      cacheHitRate: 0,
      startedAt: 0,
    };
  }

  start(): void {
    this.enabled = true;
    this.stats.startedAt = Date.now();

    // Drain queue on interval for backpressure management
    this.drainTimer = setInterval(() => this.drainQueue(), 10);

    // Listen for learning feedback from the runtime
    this.eventBus.on('pipeline:learn', (data) => {
      this.applyLearning({
        winSignals: data.winSignals,
        loseSignals: data.loseSignals,
        winRate: data.winRate,
      });
      this.logger.info(`Pipeline self-learning applied: +[${data.winSignals.join(',')}] -[${data.loseSignals.join(',')}] (${data.totalTrades} trades, ${(data.winRate * 100).toFixed(0)}% WR)`);
    });

    // Listen for hot narratives from alpha scanner
    this.eventBus.on('narrative:hot', (data) => {
      this.setTrendBoosts(data.keywords);
      this.logger.info(`Pipeline narrative boost: [${data.keywords.join(', ')}]`);
    });

    this.logger.info(`Pipeline STARTED: ${this.config.workers} workers, queue=${this.config.queueLimit}, buy=${this.config.buyAmountSol} SOL, threshold=${this.config.stage4BuyThreshold}`);
  }

  stop(): void {
    this.enabled = false;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    this.queue = [];
    this.logger.info('Pipeline STOPPED');
  }

  getStats(): PipelineStats {
    const elapsed = (Date.now() - this.stats.startedAt) / 1000;
    const busyWorkers = this.workers.filter(w => w.busy).length;

    return {
      ...this.stats,
      avgStage2Ms: this.stage2Latencies.length > 0
        ? this.stage2Latencies.reduce((a, b) => a + b, 0) / this.stage2Latencies.length
        : 0,
      avgStage3Ms: this.stage3Latencies.length > 0
        ? this.stage3Latencies.reduce((a, b) => a + b, 0) / this.stage3Latencies.length
        : 0,
      p99Stage2Ms: percentile(this.stage2Latencies, 99),
      p99Stage3Ms: percentile(this.stage3Latencies, 99),
      tokensPerSec: elapsed > 0 ? this.stats.received / elapsed : 0,
      workerUtilization: this.config.workers > 0 ? busyWorkers / this.config.workers : 0,
      cacheHitRate: this.cache.hitRate(),
    };
  }

  updateConfig(partial: Partial<PipelineConfig>): void {
    Object.assign(this.config, partial);
  }

  getBehaviorTracker(): DevBehaviorTracker {
    return this.behaviorTracker;
  }

  /**
   * Add trend-boosted keywords from AI trend intelligence.
   * Tokens matching these get a significant score boost.
   */
  setTrendBoosts(keywords: string[]): void {
    this.config.trendBoostedMints.clear();
    for (const kw of keywords) {
      this.config.trendBoostedMints.add(kw.toLowerCase());
    }
    if (keywords.length > 0) {
      this.logger.info(`Pipeline trend boosts updated: [${keywords.join(', ')}]`);
    }
  }

  /**
   * Self-learning: adjust scoring weights based on trade outcomes.
   * Called after analyzing recent trade results.
   *
   * winSignals: signals that appeared in winning trades
   * loseSignals: signals that appeared in losing trades
   *
   * Weights are adjusted incrementally (±0.05 per feedback round)
   * to gradually shift the scoring toward patterns that work.
   */
  applyLearning(feedback: {
    winSignals: string[];
    loseSignals: string[];
    winRate: number;
  }): void {
    const LEARN_RATE = 0.05;
    const MIN_WEIGHT = 0.3;
    const MAX_WEIGHT = 2.0;
    const w = this.config.learnedWeights;

    const signalToWeight: Record<string, keyof SignalWeights> = {
      'tw': 'socials', 'tg': 'socials', 'web': 'socials', 'tw+web': 'socials',
      'ultra_early': 'bondingCurve', 'early': 'bondingCurve', 'mid_early': 'bondingCurve',
      'sweet_mcap': 'bondingCurve', 'near_grad': 'bondingCurve',
      'trend': 'trending', 'ai_trend_match': 'trending',
      'desc': 'nameQuality',
      'good_dev_cached': 'devWallet', 'bad_dev_cached': 'devWallet',
      'funded_dev': 'devWallet', 'new_dev': 'devWallet',
      'distributed': 'holders', 'well_distributed': 'holders', 'bundled': 'holders',
      'beh:trusted': 'behavioral', 'beh:serial_launcher': 'behavioral',
      'mint_authority_active': 'security', 'freeze_authority_active': 'security',
      'security_safe': 'security', 'security_risky': 'security',
    };

    // Boost weights for signals that appear in winning trades
    for (const sig of feedback.winSignals) {
      const key = signalToWeight[sig];
      if (key) {
        w[key] = Math.min(MAX_WEIGHT, w[key] + LEARN_RATE);
      }
    }

    // Reduce weights for signals that appear in losing trades
    for (const sig of feedback.loseSignals) {
      const key = signalToWeight[sig];
      if (key) {
        w[key] = Math.max(MIN_WEIGHT, w[key] - LEARN_RATE);
      }
    }

    this.logger.info(`Pipeline weights updated: ${JSON.stringify(w)}`);
  }

  getLearnedWeights(): SignalWeights {
    return { ...this.config.learnedWeights };
  }

  /**
   * Entry point: called on every token:new event.
   * Stages 0-2 run synchronously (<5ms total).
   * If passes, queued for Stage 3 (async worker pool).
   */
  ingest(data: { mint: string; name: string; symbol: string; dev: string; timestamp: number }): void {
    if (!this.enabled) return;

    this.stats.received++;

    // Track dev behavior (anti-gaming — can't be faked)
    this.behaviorTracker.recordCreation(data.dev);

    const token = this.memory.getToken(data.mint);
    if (!token) {
      this.stats.killedStage0++;
      return;
    }

    // ===== STAGE 0: Instant kills (<0.1ms) =====
    if (!this.stage0_instantKill(data, token)) return;

    // ===== STAGE 1: Pattern filters (<0.5ms) =====
    if (!this.stage1_patternFilter(data, token)) return;

    // ===== STAGE 2: Fast scoring with behavioral analysis (<2ms) =====
    const t2 = performance.now();
    const s2 = this.stage2_fastScore(data, token);
    const dt2 = performance.now() - t2;
    this.recordLatency(this.stage2Latencies, dt2);

    if (s2.score < this.config.stage2MinScore) {
      this.stats.killedStage2++;
      return;
    }

    // Token survived Stage 0-2. Queue for deep check.
    const candidate: TokenCandidate = {
      mint: data.mint,
      name: data.name,
      symbol: data.symbol,
      dev: data.dev,
      token,
      stage2Score: s2.score,
      stage2Signals: s2.signals,
      receivedAt: data.timestamp || Date.now(),
      priority: s2.score,
    };

    this.enqueue(candidate);
  }

  // ==========================================================
  // Stage 0: Instant kills — known ruggers, dev blacklist.
  // Zero allocations, pure lookups.
  // ==========================================================

  private stage0_instantKill(data: { dev: string; mint: string }, token: TokenInfo): boolean {
    // Known rug dev from SQLite (indexed, <0.05ms)
    if (data.dev && this.memory.isKnownRug(data.dev)) {
      this.stats.killedStage0++;
      return false;
    }

    // Dev in local blacklist set
    if (data.dev && this.config.blacklistDevs.has(data.dev)) {
      this.stats.killedStage0++;
      return false;
    }

    // Cached dev that was already analyzed and failed
    const cachedDev = data.dev ? this.cache.getDevScore(data.dev) : null;
    if (cachedDev !== null && cachedDev < 20) {
      this.stats.killedStage0++;
      return false;
    }

    return true;
  }

  // ==========================================================
  // Stage 1: Pattern filter — garbage names, missing data.
  // String operations only, no network.
  // ==========================================================

  private stage1_patternFilter(data: { name: string; symbol: string }, token: TokenInfo): boolean {
    const name = data.name;
    const sym = data.symbol;

    // Require socials
    if (this.config.requireSocials) {
      if (!token.twitter && !token.telegram && !token.website) {
        this.stats.killedStage1++;
        return false;
      }
    }

    // Garbage symbol: random hex-like strings
    if (/^[a-f0-9]{10,}$/i.test(sym)) {
      this.stats.killedStage1++;
      return false;
    }

    // Too-short name (likely spam)
    if (name.length < 2) {
      this.stats.killedStage1++;
      return false;
    }

    // Blacklist name patterns
    for (const pattern of this.config.blacklistPatterns) {
      if (pattern.test(name) || pattern.test(sym)) {
        this.stats.killedStage1++;
        return false;
      }
    }

    return true;
  }

  // ==========================================================
  // Stage 2: Fast scoring — heuristic rules from memory data.
  // No network calls. Target: <2ms.
  // ==========================================================

  private stage2_fastScore(data: { name: string; symbol: string; dev: string }, token: TokenInfo): {
    score: number;
    signals: string[];
  } {
    const signals: string[] = [];
    let score = 45; // neutral baseline
    const w = this.config.learnedWeights;

    // --- Social presence (weighted) ---
    if (token.twitter) { score += Math.round(12 * w.socials); signals.push('tw'); }
    if (token.telegram) { score += Math.round(6 * w.socials); signals.push('tg'); }
    if (token.website) { score += Math.round(6 * w.socials); signals.push('web'); }
    if (token.twitter && token.website) { score += Math.round(3 * w.socials); signals.push('tw+web'); }

    // --- Name quality (weighted) ---
    const name = data.name.toLowerCase();
    const sym = data.symbol.toLowerCase();

    // Trending patterns boost (weighted)
    for (const p of this.config.trendingPatterns) {
      if (p.test(name) || p.test(sym)) {
        score += Math.round(5 * w.trending);
        signals.push('trend');
        break;
      }
    }

    // AI trend-boosted mint (from trend intelligence)
    if (this.config.trendBoostedMints.has(data.name.toLowerCase()) ||
        this.config.trendBoostedMints.has(data.symbol.toLowerCase())) {
      score += Math.round(15 * w.trending);
      signals.push('ai_trend_match');
    }

    // Penalty: excessively long name
    if (name.length > 40) { score -= Math.round(5 * w.nameQuality); }

    // Penalty: single character symbol
    if (sym.length === 1) { score -= Math.round(3 * w.nameQuality); }

    // Bonus: all-caps symbol (intentional branding)
    if (sym === sym.toUpperCase() && sym.length >= 2 && sym.length <= 6) {
      score += 2;
    }

    // --- Bonding curve position (weighted) ---
    const bc = token.bondingCurveProgress;
    if (bc < 3) { score += Math.round(10 * w.bondingCurve); signals.push('ultra_early'); }
    else if (bc < 10) { score += Math.round(7 * w.bondingCurve); signals.push('early'); }
    else if (bc < 25) { score += Math.round(3 * w.bondingCurve); signals.push('mid_early'); }
    else if (bc > 85) { score -= Math.round(8 * w.bondingCurve); signals.push('near_grad'); }
    else if (bc > 70) { score -= Math.round(3 * w.bondingCurve); }

    // --- Market cap (weighted) ---
    const mcap = token.marketCap;
    if (mcap > 0) {
      if (mcap >= 3 && mcap <= 15) { score += Math.round(6 * w.bondingCurve); signals.push('sweet_mcap'); }
      else if (mcap > 15 && mcap <= 40) { score += Math.round(2 * w.bondingCurve); }
      else if (mcap > 60) { score -= Math.round(5 * w.bondingCurve); signals.push('high_mcap'); }
    }

    // --- Description ---
    if (token.description && token.description.length > 30) { score += Math.round(3 * w.nameQuality); signals.push('desc'); }

    // --- BEHAVIORAL ANALYSIS (anti-gaming layer, CANNOT be faked) ---
    const behavior = this.behaviorTracker.scoreDev(data.dev);
    if (behavior.score < 20) {
      score -= Math.round(25 * w.behavioral);
      signals.push(...behavior.signals.map(s => `beh:${s}`));
    } else if (behavior.score < 40) {
      score -= Math.round(12 * w.behavioral);
      signals.push(...behavior.signals.map(s => `beh:${s}`));
    } else if (behavior.score > 80) {
      score += Math.round(8 * w.behavioral);
      signals.push('beh:trusted');
    }

    // --- Cached dev score (from previous deep checks, weighted) ---
    if (data.dev) {
      const cachedDev = this.cache.getDevScore(data.dev);
      if (cachedDev !== null) {
        if (cachedDev > 70) { score += 8; signals.push('good_dev_cached'); }
        else if (cachedDev > 50) { score += 3; }
        else if (cachedDev < 30) { score -= 10; signals.push('bad_dev_cached'); }
      }
    }

    // --- Previously successful dev (from trade history) ---
    // Tokens from devs whose previous tokens we profited on
    // This is checked via the analysis cache

    score = Math.max(0, Math.min(100, score));
    return { score, signals };
  }

  // ==========================================================
  // Queue management — priority queue with backpressure
  // ==========================================================

  private enqueue(candidate: TokenCandidate): void {
    this.stats.passedToDeep++;

    // If deep check is disabled, go straight to Stage 4
    if (!this.config.enableDeepCheck) {
      this.stage4_entryDecision(candidate, null);
      return;
    }

    // Queue is full? Drop lowest priority
    if (this.queue.length >= this.config.queueLimit) {
      // Find lowest priority in queue
      let minIdx = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i].priority < this.queue[minIdx].priority) minIdx = i;
      }
      // If new candidate is higher priority, replace
      if (candidate.priority > this.queue[minIdx].priority) {
        this.queue[minIdx] = candidate;
        this.stats.queueDropped++;
      } else {
        this.stats.queueDropped++;
      }
      return;
    }

    this.queue.push(candidate);

    // Sort by priority (highest first) — insertion sort for mostly sorted array
    for (let i = this.queue.length - 1; i > 0; i--) {
      if (this.queue[i].priority > this.queue[i - 1].priority) {
        const tmp = this.queue[i];
        this.queue[i] = this.queue[i - 1];
        this.queue[i - 1] = tmp;
      } else break;
    }
  }

  private drainQueue(): void {
    if (this.queue.length === 0) return;

    for (let i = 0; i < this.workers.length; i++) {
      if (!this.workers[i].busy && this.queue.length > 0) {
        const candidate = this.queue.shift()!;
        this.dispatchWorker(i, candidate);
      }
    }
  }

  // ==========================================================
  // Stage 3: Deep check — network calls (worker pool)
  // Runs dev wallet + holders check concurrently.
  // ==========================================================

  private async dispatchWorker(workerIdx: number, candidate: TokenCandidate): Promise<void> {
    const worker = this.workers[workerIdx];
    worker.busy = true;
    worker.currentMint = candidate.mint;
    worker.tasksSinceIdle++;

    const t3 = performance.now();
    try {
      const deepResult = await this.stage3_deepCheck(candidate);
      const dt3 = performance.now() - t3;
      this.recordLatency(this.stage3Latencies, dt3);

      this.stage4_entryDecision(candidate, deepResult);
    } catch (err: any) {
      // Network error — still pass to Stage 4 with stage2 score only
      this.stage4_entryDecision(candidate, null);
    } finally {
      worker.busy = false;
      worker.currentMint = null;
    }
  }

  private async stage3_deepCheck(candidate: TokenCandidate): Promise<DeepCheckResult> {
    const signals: string[] = [];
    let score = 0;

    // Check cache first
    const cachedDev = candidate.dev ? this.cache.getDevResult(candidate.dev) : null;
    const cachedHolders = this.cache.getHolderResult(candidate.mint);

    // Run network calls concurrently (only for uncached data)
    const [devResult, holderResult] = await Promise.all([
      cachedDev ? Promise.resolve(cachedDev) : this.fetchDevInfo(candidate.dev),
      cachedHolders ? Promise.resolve(cachedHolders) : this.fetchHolderInfo(candidate.mint),
    ]);

    // Cache results for future tokens from same dev
    if (candidate.dev && !cachedDev && devResult) {
      this.cache.setDevResult(candidate.dev, devResult);
    }
    if (!cachedHolders && holderResult) {
      this.cache.setHolderResult(candidate.mint, holderResult);
    }

    // --- Dev wallet scoring (weighted) ---
    if (devResult) {
      if (devResult.isKnownRug) {
        return { ...devResult, ...holderResult!, score: 0, signals: ['KNOWN_RUGGER'] };
      }

      const dw = this.config.learnedWeights.devWallet;
      if (devResult.devAge > 30) { score += Math.round(15 * dw); signals.push(`dev_age_${devResult.devAge}d`); }
      else if (devResult.devAge > 7) { score += Math.round(8 * dw); }
      else if (devResult.devAge < 1) { score -= Math.round(15 * dw); signals.push('new_dev'); }

      if (devResult.devBalanceSol > 5) { score += Math.round(8 * dw); signals.push('funded_dev'); }
      else if (devResult.devBalanceSol > 1) { score += Math.round(3 * dw); }
      else if (devResult.devBalanceSol < 0.1) { score -= Math.round(5 * dw); signals.push('empty_dev'); }

      if (devResult.devTxCount > 100) { score += Math.round(5 * dw); }
      else if (devResult.devTxCount < 5) { score -= Math.round(5 * dw); signals.push('inactive_dev'); }

      // Cache dev score for Stage 2 reuse
      const devScore = Math.max(0, Math.min(100, 50 + score));
      this.cache.setDevScore(candidate.dev, devScore);
    }

    // --- Holder distribution scoring (weighted) ---
    if (holderResult) {
      const hw = this.config.learnedWeights.holders;
      if (holderResult.top10Pct > 80) { score -= Math.round(20 * hw); signals.push(`concentrated_${holderResult.top10Pct.toFixed(0)}%`); }
      else if (holderResult.top10Pct < 50) { score += Math.round(8 * hw); signals.push('distributed'); }
      else if (holderResult.top10Pct < 35) { score += Math.round(12 * hw); signals.push('well_distributed'); }

      if (holderResult.isBundled) { score -= Math.round(20 * hw); signals.push('bundled'); }

      if (holderResult.holders > 100) { score += Math.round(8 * hw); signals.push(`${holderResult.holders}_holders`); }
      else if (holderResult.holders > 50) { score += Math.round(3 * hw); }
    }

    return {
      devBalanceSol: devResult?.devBalanceSol || 0,
      devAge: devResult?.devAge || 0,
      devTxCount: devResult?.devTxCount || 0,
      holders: holderResult?.holders || 0,
      top10Pct: holderResult?.top10Pct || 0,
      isBundled: holderResult?.isBundled || false,
      isKnownRug: devResult?.isKnownRug || false,
      score,
      signals,
    };
  }

  // ==========================================================
  // Stage 4: Entry decision — final threshold check
  // ==========================================================

  private stage4_entryDecision(candidate: TokenCandidate, deepResult: DeepCheckResult | null): void {
    let finalScore = candidate.stage2Score;
    let allSignals = [...candidate.stage2Signals];

    if (deepResult) {
      // Weighted combination: stage2 (40%) + stage3 (60%)
      finalScore = Math.round(candidate.stage2Score * 0.4 + (50 + deepResult.score) * 0.6);
      allSignals = [...allSignals, ...deepResult.signals];

      // Hard kill: bundled or known rug
      if (deepResult.isBundled) finalScore = Math.min(finalScore, 20);
      if (deepResult.isKnownRug) finalScore = 0;
    }

    finalScore = Math.max(0, Math.min(100, finalScore));

    const latency = Date.now() - candidate.receivedAt;

    if (finalScore >= this.config.stage4BuyThreshold) {
      this.stats.approvedStage4++;
      this.stats.tradesEmitted++;

      this.logger.trade(
        `PIPELINE BUY: ${candidate.symbol} score=${finalScore} ` +
        `[${allSignals.join(',')}] latency=${latency}ms`
      );

      this.eventBus.emit('trade:intent', {
        id: `pipe_${Date.now()}_${candidate.mint.slice(0, 8)}`,
        agentId: 'pipeline',
        action: 'buy',
        mint: candidate.mint,
        symbol: candidate.symbol,
        amountSol: this.config.buyAmountSol,
        slippageBps: this.config.slippageBps,
        priorityFeeSol: 0.005,
        reason: `Pipeline: score=${finalScore}, signals=[${allSignals.join(',')}], latency=${latency}ms`,
        timestamp: Date.now(),
      });

      this.eventBus.emit('signal:buy', {
        mint: candidate.mint,
        score: finalScore,
        reason: `Pipeline auto-entry: ${allSignals.join(', ')}`,
        agentId: 'pipeline',
      });

      // Store analysis in memory
      this.memory.storeAnalysis({
        mint: candidate.mint,
        score: finalScore,
        rugScore: deepResult ? Math.max(0, 50 - deepResult.score) : 30,
        signals: allSignals,
        recommendation: finalScore >= 80 ? 'strong_buy' : 'buy',
        reasoning: `Pipeline: score=${finalScore}, ${allSignals.join(', ')}. Latency: ${latency}ms`,
        analyzedAt: Date.now(),
      });
    } else {
      this.stats.killedStage3++;
    }
  }

  // ==========================================================
  // Network helpers (Stage 3)
  // ==========================================================

  private async fetchDevInfo(dev: string): Promise<{
    devBalanceSol: number;
    devAge: number;
    devTxCount: number;
    isKnownRug: boolean;
  } | null> {
    if (!dev) return null;

    try {
      // Run balance + tx signature queries in parallel
      const rpcUrl = this.heliusKey
        ? `https://mainnet.helius-rpc.com/?api-key=${this.heliusKey}`
        : this.solanaRpc;

      const [balRes, sigRes] = await Promise.all([
        fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getBalance',
            params: [dev],
          }),
        }),
        fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 2,
            method: 'getSignaturesForAddress',
            params: [dev, { limit: 1 }],
          }),
        }),
      ]);

      const [balData, sigData] = await Promise.all([
        balRes.json() as Promise<any>,
        sigRes.json() as Promise<any>,
      ]);

      const lamports = balData.result?.value || 0;
      const sigs = sigData.result || [];

      let accountAge = 0;
      if (sigs.length > 0 && sigs[0].blockTime) {
        accountAge = (Date.now() / 1000 - sigs[0].blockTime) / 86400;
      }

      return {
        devBalanceSol: lamports / 1e9,
        devAge: Math.floor(accountAge),
        devTxCount: sigs.length,
        isKnownRug: this.memory.isKnownRug(dev),
      };
    } catch {
      return null;
    }
  }

  private async fetchHolderInfo(mint: string): Promise<{
    holders: number;
    top10Pct: number;
    isBundled: boolean;
  } | null> {
    try {
      const rpcUrl = this.heliusKey
        ? `https://mainnet.helius-rpc.com/?api-key=${this.heliusKey}`
        : this.solanaRpc;

      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenLargestAccounts',
          params: [mint],
        }),
      });

      const data = await res.json() as any;
      const accounts = data.result?.value || [];

      if (accounts.length === 0) return { holders: 0, top10Pct: 100, isBundled: false };

      const totalSupply = accounts.reduce((s: number, a: any) => s + Number(a.amount || 0), 0);
      const sorted = accounts.sort((a: any, b: any) => Number(b.amount) - Number(a.amount));
      const top10Amount = sorted.slice(0, 10).reduce((s: number, a: any) => s + Number(a.amount || 0), 0);

      // Simple bundling detection: check if multiple top holders have very similar amounts
      let isBundled = false;
      if (sorted.length >= 5) {
        const amounts = sorted.slice(0, 10).map((a: any) => Number(a.amount));
        let sameCount = 0;
        for (let i = 1; i < amounts.length; i++) {
          if (amounts[i] > 0 && Math.abs(amounts[i] - amounts[i - 1]) / amounts[i] < 0.05) {
            sameCount++;
          }
        }
        isBundled = sameCount >= 3;
      }

      return {
        holders: accounts.length,
        top10Pct: totalSupply > 0 ? (top10Amount / totalSupply) * 100 : 100,
        isBundled,
      };
    } catch {
      return null;
    }
  }

  private recordLatency(arr: number[], ms: number): void {
    arr.push(ms);
    // Keep last 1000 for p99 calc
    if (arr.length > 1000) arr.splice(0, arr.length - 1000);
  }
}

// =====================================================
// LRU Analysis Cache with TTL
//
// Caches dev wallet scores, dev deep check results,
// and holder distribution data. Dramatically reduces
// network calls for repeat devs (many devs launch
// multiple tokens).
//
// Hit rates observed: ~15-30% for dev data
// (same dev launching multiple tokens in short windows)
// =====================================================

class AnalysisCache {
  private devScores = new Map<string, { value: number; expiresAt: number }>();
  private devResults = new Map<string, { value: any; expiresAt: number }>();
  private holderResults = new Map<string, { value: any; expiresAt: number }>();
  private maxSize: number;
  private ttl: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  getDevScore(dev: string): number | null {
    const entry = this.devScores.get(dev);
    if (!entry || Date.now() > entry.expiresAt) {
      this.misses++;
      if (entry) this.devScores.delete(dev);
      return null;
    }
    this.hits++;
    return entry.value;
  }

  setDevScore(dev: string, score: number): void {
    this.evictIfNeeded(this.devScores);
    this.devScores.set(dev, { value: score, expiresAt: Date.now() + this.ttl });
  }

  getDevResult(dev: string): any | null {
    const entry = this.devResults.get(dev);
    if (!entry || Date.now() > entry.expiresAt) {
      this.misses++;
      if (entry) this.devResults.delete(dev);
      return null;
    }
    this.hits++;
    return entry.value;
  }

  setDevResult(dev: string, result: any): void {
    this.evictIfNeeded(this.devResults);
    this.devResults.set(dev, { value: result, expiresAt: Date.now() + this.ttl });
  }

  getHolderResult(mint: string): any | null {
    const entry = this.holderResults.get(mint);
    if (!entry || Date.now() > entry.expiresAt) {
      this.misses++;
      if (entry) this.holderResults.delete(mint);
      return null;
    }
    this.hits++;
    return entry.value;
  }

  setHolderResult(mint: string, result: any): void {
    this.evictIfNeeded(this.holderResults);
    this.holderResults.set(mint, { value: result, expiresAt: Date.now() + this.ttl });
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  clear(): void {
    this.devScores.clear();
    this.devResults.clear();
    this.holderResults.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private evictIfNeeded(map: Map<string, any>): void {
    if (map.size < this.maxSize) return;

    // Evict oldest 20%
    const toDelete = Math.floor(this.maxSize * 0.2);
    const iter = map.keys();
    for (let i = 0; i < toDelete; i++) {
      const key = iter.next().value;
      if (key !== undefined) map.delete(key);
    }
  }
}

// =====================================================
// Utility
// =====================================================

function percentile(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
