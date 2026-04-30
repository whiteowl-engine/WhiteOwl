
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import { EventBusInterface, LoggerInterface, LLMMessage, Position } from '../types.ts';
import { TrendContext, TrendSnapshot } from './trend-context.ts';
import { MarketStateBuilder } from './market-state.ts';
import type { Memory, ContextualMemory } from '../memory/index.ts';
import { fetchBubblemapsPortal } from '../skills/insightx.ts';
import { fetchCabalSpy, CabalSpyResult } from '../lib/cabalspy.ts';
import { axiomBatchTokenDataTracked } from '../skills/axiom-api.ts';
import {
  SniperStrategy,
  SniperState,
  buildSniperSystemPrompt,
  buildSniperUserPrompt,
  parseSniperDecision,
  SniperDecision,
} from './sniper-prompt.ts';

const __filename_sj = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename_sj), '..', '..');

export interface SniperCandidate {
  mint: string;
  symbol: string;
  name: string;
  bondingProgress: number;
  mcap: number;
  holders: number;
  score: number;
  hasSocials: boolean;
  ageSeconds: number;
  narrativeBonus: number;
  description?: string;
}

export interface SniperCycleResult {
  timestamp: number;
  decision: SniperDecision;
  candidatesEvaluated: number;
  walletBalance: number;
  openPositions: number;
  cycleDurationMs: number;
  usedLLM: boolean;

  thinking: SniperThinking;
}

export interface SniperThinking {

  lines: Array<{ icon: string; text: string; color?: string }>;

  candidates?: Array<{ symbol: string; score: number; narrative: number; reason: string; bundleCheck?: string; top10Holders?: string }>;

  trends?: { narratives: string[]; sentiment: string; hotTokens: string[] };

  risk?: { portfolio: number; exposure: number; winRate: number; buySize: number; maxPos: number };
}

export interface SniperStats {
  running: boolean;
  startedAt: number;
  cycles: number;
  buys: number;
  sells: number;
  skips: number;
  llmCalls: number;
  errors: number;
  consecutiveLosses: number;
  cooldownUntil: number;
  lastCycle: SniperCycleResult | null;
  recentDecisions: Array<{ ts: number; action: string; mint?: string; reason?: string }>;

  recentThinking: Array<{ ts: number; cycle: number; thinking: SniperThinking }>;

  riskProfile: {
    portfolioTotal: number;
    exposurePercent: number;
    winRate: number;
    dynamicBuyAmount: number;
    dynamicMaxPositions: number;
    dynamicStopLoss: number;
    dynamicMinScore: number;
  } | null;
}

interface SniperPositionTracker {
  position: Position;
  peakMcap: number;
  peakPrice: number;
  lastHolders: number;
  peakHolders: number;
  lastMcap: number;
  lastBundlePct: number;
  lastClusterPct: number;
  partialsSold: number;
  lastCheckAt: number;
  bondingProgress: number;
  graduated: boolean;
  exitSignals: string[];

  dynamicStopLoss: number;

  dynamicTpLevels: Array<{ at: number; sellPercent: number }>;

  lastChartAnalysisAt: number;

  lastChartVerdict: string;
}

export class SniperJob {
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private trendContext: TrendContext;
  private marketState: MarketStateBuilder;
  private strategy: SniperStrategy;
  private stats: SniperStats;

  private memory: Memory | null = null;
  private contextMemory: ContextualMemory | null = null;

  private candidates = new Map<string, SniperCandidate>();
  private readonly MAX_CANDIDATES = 100;
  private readonly CANDIDATE_TTL_MS = 120_000;

  private recentEvaluated = new Map<string, { symbol: string; score: number; ts: number }>();
  private readonly MAX_RECENT_EVALUATED = 200;

  private openPositions = new Map<string, SniperPositionTracker>();

  private llmFn: ((messages: LLMMessage[], tools: any[]) => Promise<any>) | null = null;

  private tradeFn: ((tool: string, params: Record<string, any>) => Promise<any>) | null = null;

  private balanceFn: (() => Promise<number>) | null = null;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private cycleInProgress = false;

  private baseStrategy: SniperStrategy | null = null;

  private paperMode = false;

  private paperBalanceOverride: number | null = null;

  private paperPnlAccum = 0;

  private paperTrades: Array<{
    mint: string; symbol: string; action: 'buy' | 'sell';
    amountSol: number; price: number; mcap: number;
    timestamp: number; reason: string;
    pnlPercent?: number; pnlSol?: number;
    pairAddress?: string;
  }> = [];

  private learningJournal: Array<{
    ts: number; type: 'insight' | 'mistake' | 'pattern' | 'user_instruction';
    text: string; context?: string;
  }> = [];

  private chatHistory: Array<{ role: 'user' | 'assistant'; text: string; ts: number }> = [];

  private userInstructions: string[] = [];

  private paperStats = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, bestTrade: 0, worstTrade: 0 };

  private paperMinWinsForLive = 10;

  private lastRealBalance = 0;

  private tradedMints = new Set<string>();

  private announcementBoosts = new Map<string, { multiplier: number; scoreBoost: number; until: number; label: string; direction: 'long' | 'short' }>();
  private readonly ANNOUNCEMENT_BOOST_TTL_MS = 15 * 60_000;
  private announcementMultiplier = 1.5;
  private announcementMinScore = 85;
  private announcementStopLossPercent = 30;
  private allowAnnouncements = true;

  setAnnouncementOptions(opts: { allowAnnouncements?: boolean; multiplier?: number; minScore?: number; stopLossPercent?: number }): void {
    if (opts.allowAnnouncements !== undefined) this.allowAnnouncements = opts.allowAnnouncements;
    if (opts.multiplier !== undefined) this.announcementMultiplier = Math.max(1, Math.min(3, opts.multiplier));
    if (opts.minScore !== undefined) this.announcementMinScore = Math.max(0, Math.min(100, opts.minScore));
    if (opts.stopLossPercent !== undefined) this.announcementStopLossPercent = Math.max(5, Math.min(80, opts.stopLossPercent));
  }

  private readonly COOLDOWN_LOSSES = 3;
  private readonly COOLDOWN_BASE_MS = 2 * 60_000;

  constructor(opts: {
    eventBus: EventBusInterface;
    logger: LoggerInterface;
    trendContext: TrendContext;
    marketState: MarketStateBuilder;
    memory?: any;
    contextMemory?: any;
  }) {
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.trendContext = opts.trendContext;
    this.marketState = opts.marketState;
    if (opts.memory) this.memory = opts.memory;
    if (opts.contextMemory) this.contextMemory = opts.contextMemory;

    this.strategy = this.loadStrategy();
    this.stats = this.createEmptyStats();
  }

  setLLMFunction(fn: (messages: LLMMessage[], tools: any[]) => Promise<any>): void {
    this.llmFn = fn;
  }

  setTradeFunction(fn: (tool: string, params: Record<string, any>) => Promise<any>): void {
    this.tradeFn = fn;
  }

  setBalanceFunction(fn: () => Promise<number>): void {
    this.balanceFn = fn;
  }

  private browserService: any = null;

  setBrowserService(browser: any): void {
    this.browserService = browser;
  }

  private async recalculateRisk(): Promise<void> {
    if (!this.baseStrategy) this.baseStrategy = { ...this.strategy };

    let balance: number;

    let realBalance = this.lastRealBalance;
    try {
      if (this.balanceFn) {
        realBalance = await this.balanceFn();
        this.lastRealBalance = realBalance;
      }
    } catch {}

    if (this.paperMode && this.paperBalanceOverride !== null) {
      balance = this.paperBalanceOverride + this.paperPnlAccum;
      this.marketState.updateBalance(balance);
    } else if (this.paperMode) {

      balance = realBalance + this.paperPnlAccum;
      this.marketState.updateBalance(balance);
    } else try {
      if (this.balanceFn) {
        balance = realBalance;
        this.marketState.updateBalance(balance);
      } else {
        const snap = this.marketState.getExposureSummary(
          this.baseStrategy.maxConcurrentPositions,
          this.baseStrategy.maxPortfolioPercent,
        );
        balance = snap.availableBalance + snap.totalInvestedSol;
        if (balance <= 0) {
          this.logger.debug('[Sniper/Risk] No balance function and no market state balance — skipping');
          return;
        }
      }
    } catch (err: any) {
      this.logger.debug(`[Sniper/Risk] Balance fetch failed (${err?.message}), using cached`);
      const snap = this.marketState.getExposureSummary(
        this.baseStrategy.maxConcurrentPositions,
        this.baseStrategy.maxPortfolioPercent,
      );
      balance = snap.availableBalance + snap.totalInvestedSol;
      if (balance <= 0) return;
    }

    const exposure = this.marketState.getExposureSummary(
      this.baseStrategy.maxConcurrentPositions,
      this.baseStrategy.maxPortfolioPercent,
    );

    const totalPortfolio = balance + exposure.totalInvestedSol;
    if (totalPortfolio <= 0.01) return;

    const availableBalance = balance;
    const exposureRatio = exposure.totalInvestedSol / totalPortfolio;
    const winRate = this.getWinRate();
    const losses = this.stats.consecutiveLosses;
    const totalTrades = this.stats.buys + this.stats.sells;


    let tier: 'micro' | 'small' | 'medium' | 'large';
    let baseBuyPct: number;
    let baseMaxPos: number;
    let baseReserve: number;
    let baseMaxExposure: number;

    if (totalPortfolio < 0.5) {

      tier = 'micro';
      baseBuyPct = 0.12;
      baseMaxPos = 1;
      baseReserve = 0.15;
      baseMaxExposure = 0.60;
    } else if (totalPortfolio < 2) {

      tier = 'small';
      baseBuyPct = 0.08;
      baseMaxPos = 3;
      baseReserve = 0.15;
      baseMaxExposure = 0.55;
    } else if (totalPortfolio < 10) {

      tier = 'medium';
      baseBuyPct = 0.05;
      baseMaxPos = 5;
      baseReserve = 0.20;
      baseMaxExposure = 0.50;
    } else {

      tier = 'large';
      baseBuyPct = 0.03;
      baseMaxPos = 8;
      baseReserve = 0.25;
      baseMaxExposure = 0.45;
    }


    let performanceMultiplier = 1.0;

    if (totalTrades >= 5) {

      if (winRate > 0.65) performanceMultiplier = 1.4;
      else if (winRate > 0.5) performanceMultiplier = 1.15;
      else if (winRate > 0.35) performanceMultiplier = 0.85;
      else if (winRate > 0.2) performanceMultiplier = 0.6;
      else performanceMultiplier = 0.4;
    }


    if (losses >= 4) performanceMultiplier *= 0.3;
    else if (losses >= 3) performanceMultiplier *= 0.5;
    else if (losses >= 2) performanceMultiplier *= 0.7;


    if (exposureRatio > 0.4) performanceMultiplier *= 0.5;
    else if (exposureRatio > 0.25) performanceMultiplier *= 0.75;

    let buyPct = baseBuyPct * performanceMultiplier;


    buyPct = Math.max(0.02, Math.min(0.20, buyPct));


    let buyAmount = totalPortfolio * buyPct;


    buyAmount = Math.max(0.02, Math.min(buyAmount, availableBalance * 0.30));

    this.strategy.buyAmountSol = +buyAmount.toFixed(4);


    let maxPos = baseMaxPos;


    if (losses >= 3) maxPos = Math.max(1, maxPos - 2);
    else if (losses >= 2) maxPos = Math.max(1, maxPos - 1);
    else if (winRate > 0.6 && totalTrades >= 8) maxPos = Math.min(10, maxPos + 1);


    const maxAffordable = Math.max(1, Math.floor(availableBalance / buyAmount));
    maxPos = Math.min(maxPos, maxAffordable);

    this.strategy.maxConcurrentPositions = maxPos;


    const avgWinPct = this.paperStats.wins > 0 && this.paperStats.totalPnl !== undefined
      ? (this.paperStats.totalPnl > 0
        ? (this.paperStats.totalPnl / this.paperStats.wins) / (this.strategy.buyAmountSol || 0.05) * 100
        : 15)
      : 15;

    let sl: number;
    if (totalTrades < 3) {

      sl = this.baseStrategy?.stopLossPercent || 20;
    } else {

      const wr = Math.max(0.1, Math.min(0.9, winRate));


      const kellyRatio = wr / (1 - wr);
      sl = Math.round(avgWinPct * kellyRatio * 0.5);
    }


    if (exposureRatio > 0.35) sl = Math.round(sl * 0.8);
    else if (exposureRatio > 0.2) sl = Math.round(sl * 0.9);


    if (losses >= 4) sl = Math.max(15, Math.round(sl * 0.6));
    else if (losses >= 3) sl = Math.max(15, Math.round(sl * 0.7));
    else if (losses >= 2) sl = Math.max(15, Math.round(sl * 0.8));


    sl = Math.max(15, Math.min(40, sl));

    this.strategy.stopLossPercent = sl;


    let ms = this.baseStrategy.minScore;
    if (losses >= 4) ms = Math.min(85, ms + 20);
    else if (losses >= 3) ms = Math.min(75, ms + 15);
    else if (losses >= 2) ms = Math.min(65, ms + 10);
    else if (winRate > 0.6 && totalTrades >= 8) ms = Math.max(30, ms - 10);
    this.strategy.minScore = Math.round(ms);


    this.strategy.maxPortfolioPercent = Math.round(baseMaxExposure * 100);


    this.strategy.minBalanceSol = Math.max(0.02, totalPortfolio * baseReserve);


    {
      const slFrac = sl / 100;
      const tp1 = +(1 + slFrac * 2).toFixed(2);
      const tp2 = +(1 + slFrac * 4).toFixed(2);
      const tp3 = +(1 + slFrac * 6).toFixed(2);
      const tp4 = +(1 + slFrac * 10).toFixed(2);

      if (tier === 'micro' || tier === 'small') {

        this.strategy.takeProfitLevels = [
          { at: tp1, sellPercent: 50 },
          { at: tp2, sellPercent: 30 },
          { at: tp3, sellPercent: 100 },
        ];
      } else {

        this.strategy.takeProfitLevels = [
          { at: tp1, sellPercent: 40 },
          { at: tp2, sellPercent: 30 },
          { at: tp3, sellPercent: 20 },
          { at: tp4, sellPercent: 100 },
        ];
      }
    }


    if (tier === 'micro') this.strategy.trailingStopPercent = 12;
    else if (tier === 'small') this.strategy.trailingStopPercent = 15;
    else if (tier === 'medium') this.strategy.trailingStopPercent = 18;
    else this.strategy.trailingStopPercent = 20;

    this.logger.debug(
      `[Sniper/Risk] TIER=${tier} portfolio=${totalPortfolio.toFixed(3)} avail=${availableBalance.toFixed(3)} ` +
      `exposure=${(exposureRatio * 100).toFixed(1)}% winRate=${(winRate * 100).toFixed(0)}% losses=${losses} perf=${performanceMultiplier.toFixed(2)} → ` +
      `buy=${this.strategy.buyAmountSol.toFixed(4)} (${(buyPct * 100).toFixed(1)}%) maxPos=${this.strategy.maxConcurrentPositions} ` +
      `SL=${this.strategy.stopLossPercent}% minScore=${this.strategy.minScore} reserve=${this.strategy.minBalanceSol.toFixed(3)}`
    );


    this.stats.riskProfile = {
      portfolioTotal: totalPortfolio,
      exposurePercent: +(exposureRatio * 100).toFixed(1),
      winRate: +(winRate * 100).toFixed(0),
      dynamicBuyAmount: this.strategy.buyAmountSol,
      dynamicMaxPositions: this.strategy.maxConcurrentPositions,
      dynamicStopLoss: this.strategy.stopLossPercent,
      dynamicMinScore: this.strategy.minScore,
    };
  }

private getWinRate(): number {

    if (this.paperMode && this.paperStats.totalTrades > 2) {
      const total = this.paperStats.wins + this.paperStats.losses;
      if (total > 0) return this.paperStats.wins / total;
    }

    if (this.stats.buys + this.stats.sells < 2) return 0.5;

    const sellRatio = this.stats.sells / Math.max(1, this.stats.buys);
    return Math.min(1, Math.max(0, sellRatio * 0.5));
  }

start(): void {
    if (this.running) {
      this.logger.info('[Sniper] Already running');
      return;
    }

    this.running = true;
    this.stats = this.createEmptyStats();
    this.stats.running = true;
    this.stats.startedAt = Date.now();


    this.eventBus.on('trenches:alert' as any, this.onTrenchesAlert.bind(this));
    this.eventBus.on('token:new' as any, this.onTokenNew.bind(this));
    this.eventBus.on('trade:executed' as any, this.onTradeExecuted.bind(this));
    this.eventBus.on('announcement:detected' as any, this.onAnnouncementDetected.bind(this));


    this.intervalHandle = setInterval(() => {
      this.cycle().catch(err => {
        this.stats.errors++;
        this.logger.error(`[Sniper] Cycle error: ${err?.message}`);
      });
    }, 10_000);


    this.ensureDataSources();

    this.logger.info(`[Sniper] Started — buy=${this.strategy.buyAmountSol} SOL, maxPos=${this.strategy.maxConcurrentPositions}, stopLoss=-${this.strategy.stopLossPercent}%`);
    this.eventBus.emit('sniper:started' as any, { strategy: this.strategy });
  }

private ensureDataSources(): void {
    if (!this.tradeFn) {
      this.logger.warn('[Sniper] No tradeFn — cannot start data sources');
      return;
    }


    this.tradeFn('start_monitoring', {}).then(res => {
      this.logger.info(`[Sniper] start_monitoring → ${res?.status || JSON.stringify(res)}`);
    }).catch(err => {
      this.logger.error(`[Sniper] start_monitoring failed: ${err?.message}`);
    });


        this.tradeFn('start_trenches', {
      mode: 'alert',
      requireSocials: false,
      minScore: 30,
      evalIntervalMs: 10_000,
    }).then(res => {
      this.logger.info(`[Sniper] start_trenches → ${res?.status || JSON.stringify(res)}`);
    }).catch(err => {
      this.logger.error(`[Sniper] start_trenches failed: ${err?.message}`);
    });


    this.tradeFn('exit_enable', {}).then(res => {
      this.logger.info(`[Sniper] exit_enable → ${res?.status || JSON.stringify(res)}`);
    }).catch(err => {
      this.logger.debug(`[Sniper] exit_enable failed (non-critical): ${err?.message}`);
    });
  }

stop(): void {
    if (!this.running) return;

    this.running = false;
    this.stats.running = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    try {
      this.eventBus.off('trenches:alert' as any, this.onTrenchesAlert.bind(this));
      this.eventBus.off('token:new' as any, this.onTokenNew.bind(this));
      this.eventBus.off('trade:executed' as any, this.onTradeExecuted.bind(this));
    } catch {}

    this.candidates.clear();

    this.logger.info(`[Sniper] Stopped — ${this.stats.buys} buys, ${this.stats.sells} sells in ${this.stats.cycles} cycles | ${this.openPositions.size} positions still tracked`);
    this.eventBus.emit('sniper:stopped' as any, { stats: this.stats });
  }

private serializeTrackedPosition(tracker: SniperPositionTracker): {
    mint: string;
    symbol: string;
    entryMcap: number;
    currentMcap: number;
    currentPrice: number;
    amountTokens: number;
    investedSol: number;
    pnlPercent: number;
    pnlSol: number;
    holdMinutes: number;
    holders: number;
    peakHolders: number;
    peakMcap: number;
    bondingProgress: number;
    graduated: boolean;
    bundlePct: number;
    clusterPct: number;
    partialsSold: number;
    exitSignals: string[];
    dynamicStopLoss: number;
    dynamicTpLevels: Array<{ at: number; sellPercent: number }>;
    chartVerdict: string;
    openedAt: number;
    lastUpdated: number;
  } {
    return {
      mint: tracker.position.mint,
      symbol: tracker.position.symbol,
      entryMcap: tracker.position.entryPrice,
      currentMcap: tracker.lastMcap,
      currentPrice: tracker.position.currentPrice,
      amountTokens: tracker.position.amountTokens,
      investedSol: tracker.position.amountSolInvested,
      pnlPercent: tracker.position.unrealizedPnlPercent,
      pnlSol: tracker.position.unrealizedPnl,
      holdMinutes: Math.round((Date.now() - tracker.position.openedAt) / 60_000),
      holders: tracker.lastHolders,
      peakHolders: tracker.peakHolders,
      peakMcap: tracker.peakMcap,
      bondingProgress: tracker.bondingProgress,
      graduated: tracker.graduated,
      bundlePct: tracker.lastBundlePct,
      clusterPct: tracker.lastClusterPct,
      partialsSold: tracker.partialsSold,
      exitSignals: [...tracker.exitSignals],
      dynamicStopLoss: tracker.dynamicStopLoss,
      dynamicTpLevels: tracker.dynamicTpLevels.map((level) => ({ ...level })),
      chartVerdict: tracker.lastChartVerdict,
      openedAt: tracker.position.openedAt,
      lastUpdated: tracker.position.lastUpdated,
    };
  }

  getStats(): SniperStats & { trackedPositions?: any[] } {
    const positions = [...this.openPositions.values()].map((tracker) => this.serializeTrackedPosition(tracker));
    return {
      ...this.stats,
      trackedPositions: positions,
      paperMode: this.paperMode,
      paperBalance: this.paperMode ? this.getPaperBalance() : undefined,
      paperStats: this.paperMode ? this.paperStats : undefined,
    };
  }

  getTrackedPosition(mint: string): ReturnType<SniperJob['serializeTrackedPosition']> | null {
    const tracker = this.openPositions.get(mint);
    return tracker ? this.serializeTrackedPosition(tracker) : null;
  }

getStrategy(): SniperStrategy {
    return { ...this.strategy };
  }

updateStrategy(partial: Partial<SniperStrategy>): void {
    Object.assign(this.strategy, partial);
    this.logger.info('[Sniper] Strategy updated');
  }

getTokenOverlay(): Array<{
    mint: string;
    symbol: string;
    status: 'analyzed' | 'bought';
    score?: number;
    pnl?: number;
    paperMode?: boolean;
    position?: ReturnType<SniperJob['serializeTrackedPosition']>;
  }> {
    const result: Array<{
      mint: string;
      symbol: string;
      status: 'analyzed' | 'bought';
      score?: number;
      pnl?: number;
      paperMode?: boolean;
      position?: ReturnType<SniperJob['serializeTrackedPosition']>;
    }> = [];
    const seen = new Set<string>();

    for (const [mint, tracker] of this.openPositions) {
      seen.add(mint);
      result.push({
        mint,
        symbol: tracker.position.symbol,
        status: 'bought',
        pnl: tracker.position.unrealizedPnlPercent,
        paperMode: this.paperMode,
        position: this.serializeTrackedPosition(tracker),
      });
    }

    for (const [mint, c] of this.candidates) {
      if (!seen.has(mint)) {
        seen.add(mint);
        result.push({ mint, symbol: c.symbol, status: 'analyzed', score: c.score });
      }
    }

    for (const [mint, entry] of this.recentEvaluated) {
      if (!seen.has(mint)) {
        seen.add(mint);
        result.push({ mint, symbol: entry.symbol, status: 'analyzed', score: entry.score });
      }
    }
    return result;
  }


  private onTrenchesAlert(data: any): void {
    if (!this.running) return;
    this.logger.info(`[Sniper] trenches:alert received — ${data?.symbol} mint=${data?.mint?.slice(0, 8)} score=${data?.score} mcap=${data?.mcap || 0} bond=${data?.bondingProgress?.toFixed?.(0) || 0}%`);
    this.addCandidate({
      mint: data.mint,
      symbol: data.symbol || '???',
      name: data.name || '',
      bondingProgress: data.bondingProgress || 0,
      mcap: data.mcap || 0,
      holders: typeof data.holders === 'number' ? data.holders : (Number(data.holders) || 0),
      score: data.score || 0,
      hasSocials: !!(data.twitter || data.telegram || data.website),
      ageSeconds: 0,
      narrativeBonus: 0,
      description: data.description,
    });
  }

  private onTokenNew(data: any): void {
    if (!this.running) return;

    if (data.mint && data.symbol) {
      const narrativeBonus = this.trendContext.scoreNarrativeMatch(
        data.name || data.symbol,
        data.description,
      );
      this.logger.debug(`[Sniper] token:new ${data.symbol} narrative=${narrativeBonus}`);

      if (narrativeBonus > 0) {
        this.addCandidate({
          mint: data.mint,
          symbol: data.symbol,
          name: data.name || '',
          bondingProgress: 0,
          mcap: 0,
          holders: 0,
          score: narrativeBonus,
          hasSocials: false,
          ageSeconds: 0,
          narrativeBonus,
          description: data.description,
        });
      }
    }
  }

  private onTradeExecuted(data: any): void {
    if (!data) return;

    if (!data.success) {
      this.stats.consecutiveLosses++;
      if (!this.paperMode && this.stats.consecutiveLosses >= this.COOLDOWN_LOSSES) {
        const extraMin = Math.min(3, this.stats.consecutiveLosses - this.COOLDOWN_LOSSES);
        const cooldownMs = this.COOLDOWN_BASE_MS + extraMin * 60_000;
        this.stats.cooldownUntil = Date.now() + cooldownMs;
        this.logger.warn(`[Sniper] Cooldown activated: ${this.stats.consecutiveLosses} losses → pause ${cooldownMs / 60000}min`);
      }
    } else {
      this.stats.consecutiveLosses = 0;
    }
  }

  private onAnnouncementDetected(det: any): void {
    if (!this.running || !this.allowAnnouncements) return;
    if (!det?.mint || typeof det.mint !== 'string') return;
    if ((det.score ?? 0) < this.announcementMinScore) return;
    if (det.direction !== 'long') return; // sniper only opens longs

    const until = Date.now() + this.ANNOUNCEMENT_BOOST_TTL_MS;
    this.announcementBoosts.set(det.mint, {
      multiplier: this.announcementMultiplier,
      scoreBoost: Math.max(15, Math.round((det.score - this.announcementMinScore) / 2) + 15),
      until,
      label: det.patternLabel || det.patternId || 'announcement',
      direction: 'long',
    });
    const c = this.candidates.get(det.mint);
    if (c) {
      c.score = Math.min(100, c.score + this.announcementBoosts.get(det.mint)!.scoreBoost);
      this.logger.info(`[Sniper] Announcement boost applied to existing candidate ${c.symbol} (${det.patternLabel}) -> score=${c.score}`);
    } else {
      this.logger.info(`[Sniper] Announcement boost armed for ${det.mint.slice(0, 8)}... (${det.patternLabel}) - TTL ${this.ANNOUNCEMENT_BOOST_TTL_MS / 60000}min`);
    }
    for (const [m, b] of this.announcementBoosts) {
      if (b.until < Date.now()) this.announcementBoosts.delete(m);
    }
  }

  private applyAnnouncementSL(baseSL: number, candidate: SniperCandidate | null | undefined): number {
    if (!candidate) return baseSL;
    const annBoost = (candidate as any)._announcementBoost as { until: number } | undefined;
    if (!annBoost || annBoost.until < Date.now()) return baseSL;
    return Math.min(baseSL, this.announcementStopLossPercent);
  }

  private addCandidate(c: SniperCandidate): void {

    const nameLower = (c.name + ' ' + c.symbol).toLowerCase();
    for (const pat of this.strategy.blacklistPatterns) {
      if (nameLower.includes(pat.toLowerCase())) {
        this.logger.debug(`[Sniper] Candidate ${c.symbol} blacklisted by pattern "${pat}"`);
        return;
      }
    }

    c.ageSeconds = 0;
    (c as any)._addedAt = Date.now();

    const boost = this.announcementBoosts.get(c.mint);
    if (boost && boost.until > Date.now() && boost.direction === 'long') {
      c.score = Math.min(100, c.score + boost.scoreBoost);
      (c as any)._announcementBoost = boost;
      this.logger.info(`[Sniper] Candidate ${c.symbol} carries announcement boost (${boost.label}) -> score=${c.score}`);
    }

    this.candidates.set(c.mint, c);
    this.logger.debug(`[Sniper] Candidate added: ${c.symbol} score=${c.score} — pool size: ${this.candidates.size}`);


    if (this.candidates.size > this.MAX_CANDIDATES) {
      const oldest = [...this.candidates.entries()]
        .sort((a, b) => a[1].ageSeconds - b[1].ageSeconds)
        .slice(this.MAX_CANDIDATES);
      for (const [mint] of oldest) this.candidates.delete(mint);
    }
  }


  private async cycle(): Promise<void> {

    if (this.cycleInProgress) {
      this.logger.debug('[Sniper] Cycle already in progress, skipping');
      return;
    }
    this.cycleInProgress = true;

    try {
      await this._cycleInner();
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async _cycleInner(): Promise<void> {
    const cycleStart = Date.now();
    this.stats.cycles++;
    const think: SniperThinking = { lines: [] };


    if (this.paperMode) {
      think.lines.push({ icon: '📝', text: `PAPER TRADING | Balance: ${this.getPaperBalance().toFixed(3)} SOL${this.paperBalanceOverride !== null ? ' (custom)' : ' (real+pnl)'} | W/L: ${this.paperStats.wins}/${this.paperStats.losses} | P&L: ${this.paperStats.totalPnl >= 0 ? '+' : ''}${this.paperStats.totalPnl.toFixed(4)} SOL`, color: 'blue' });
    }


    if (this.userInstructions.length > 0) {
      think.lines.push({ icon: '💬', text: `User instructions: ${this.userInstructions.length} active`, color: 'cyan' });
    }


    if (!this.paperMode && this.stats.cooldownUntil > cycleStart) {
      think.lines.push({ icon: '❄️', text: 'Cooldown mode after loss streak. Waiting...', color: 'blue' });
      this.stats.recentDecisions.push({ ts: Date.now(), action: 'COOLDOWN', reason: 'Loss cooldown active' });
      if (this.stats.recentDecisions.length > 50) this.stats.recentDecisions.shift();
      this.broadcastThinking(think);
      return;
    }


    if (!this.paperMode && this.contextMemory) {
      try {
        const worstHours = this.contextMemory.getWorstTradingHours(15);
        const utcHour = new Date().getUTCHours();
        const currentBad = worstHours.find((h: any) => h.hour === utcHour && h.winRate < 0.2);
        if (currentBad) {
          think.lines.push({ icon: '⏰', text: `Bad hour (UTC ${utcHour}): WR=${(currentBad.winRate * 100).toFixed(0)}% — SKIP CYCLE`, color: 'yellow' });
          this.broadcastThinking(think);
          return;
        }
      } catch {}
    }


    await this.recalculateRisk();


    if (this.stats.riskProfile) {
      const rp = this.stats.riskProfile;
      think.risk = {
        portfolio: rp.portfolioTotal,
        exposure: rp.exposurePercent,
        winRate: rp.winRate,
        buySize: rp.dynamicBuyAmount,
        maxPos: rp.dynamicMaxPositions,
      };
      think.lines.push({
        icon: '💰',
        text: `Portfolio: ${rp.portfolioTotal.toFixed(3)} SOL | Exposure: ${rp.exposurePercent}% | Win Rate: ${rp.winRate}%`,
      });
      think.lines.push({
        icon: '🎯',
        text: `Risk Engine → Buy: ${rp.dynamicBuyAmount.toFixed(4)} SOL | Max positions: ${rp.dynamicMaxPositions} | SL: ${rp.dynamicStopLoss}% | Min Score: ${rp.dynamicMinScore}`,
        color: 'cyan',
      });
    }


    if (this.openPositions.size > 0) {
      think.lines.push({ icon: '👁️', text: `Monitoring ${this.openPositions.size} open positions...`, color: 'cyan' });
      await this.monitorPositions(think);
    }


    const exposure = this.marketState.getExposureSummary(
      this.strategy.maxConcurrentPositions,
      this.strategy.maxPortfolioPercent,
    );

    if (exposure.openPositions > 0) {
      think.lines.push({
        icon: '📊',
        text: `Open positions: ${exposure.openPositions} | Invested: ${exposure.totalInvestedSol.toFixed(3)} SOL | Available: ${exposure.availableBalance.toFixed(3)} SOL`,
      });
      for (const p of exposure.positions) {
        const pnlColor = p.pnlPercent >= 0 ? 'green' : 'red';
        think.lines.push({
          icon: p.pnlPercent >= 0 ? '📈' : '📉',
          text: `  ${p.symbol} — P&L: ${p.pnlPercent >= 0 ? '+' : ''}${p.pnlPercent.toFixed(1)}% | Hold: ${p.holdMinutes}m | Invested: ${p.invested.toFixed(3)} SOL`,
          color: pnlColor,
        });
      }
    }


    if (exposure.availableBalance < this.strategy.minBalanceSol) {
      think.lines.push({
        icon: '⚠️',
        text: `Balance ${exposure.availableBalance.toFixed(3)} SOL below minimum ${this.strategy.minBalanceSol.toFixed(3)} SOL — waiting`,
        color: 'yellow',
      });
      this.stats.recentDecisions.push({ ts: Date.now(), action: 'WAIT', reason: `Low balance: ${exposure.availableBalance.toFixed(3)} < ${this.strategy.minBalanceSol.toFixed(3)} SOL min` });
      if (this.stats.recentDecisions.length > 50) this.stats.recentDecisions.shift();
      this.broadcastThinking(think);
      return;
    }


    const trendSnap = this.trendContext.getSnapshot();
    think.trends = {
      narratives: trendSnap.hotNarratives,
      sentiment: trendSnap.sentiment.trend,
      hotTokens: trendSnap.hotTokens,
    };

    if (trendSnap.hotNarratives.length > 0) {
      think.lines.push({
        icon: '🔥',
        text: `Trends${trendSnap.llmPowered ? ' (AI)' : ''}: ${trendSnap.hotNarratives.join(', ')} | Sentiment: ${trendSnap.sentiment.trend} (${trendSnap.sentiment.bullish}🟢 ${trendSnap.sentiment.bearish}🔴)`,
        color: trendSnap.sentiment.trend === 'bullish' ? 'green' : trendSnap.sentiment.trend === 'bearish' ? 'red' : undefined,
      });
    } else {
      think.lines.push({
        icon: '📡',
        text: `No active trends — scanning token stream without narrative bonus`,
      });
    }


    if (trendSnap.events && trendSnap.events.length > 0) {
      for (const ev of trendSnap.events) {
        think.lines.push({
          icon: '🧠',
          text: `EVENT (w${ev.weight}): ${ev.event} → pump.fun: ${ev.predictedNames.join(', ')}`,
          color: ev.weight >= 7 ? 'cyan' : undefined,
        });
      }
    }


    if (trendSnap.catalysts && trendSnap.catalysts.length > 0 && (!trendSnap.events || trendSnap.events.length === 0)) {
      for (const cat of trendSnap.catalysts) {
        think.lines.push({
          icon: '⚡',
          text: `CATALYST: ${cat.entity} ${cat.action} (weight ${cat.weight}) — boosts: ${cat.relatedNarratives.join(', ')}`,
          color: 'cyan',
        });
      }
    }

    if (trendSnap.hotTokens.length > 0) {
      think.lines.push({
        icon: '🪙',
        text: `Predicted tokens: ${trendSnap.hotTokens.slice(0, 8).join(', ')}`,
      });
    }

    if (trendSnap.xTrackerMints.length > 0) {
      think.lines.push({
        icon: '🐦',
        text: `X Tracker detected ${trendSnap.xTrackerMints.length} calls from KOLs`,
        color: 'cyan',
      });
    }


    const now = Date.now();
    for (const [mint, c] of this.candidates) {
      c.ageSeconds = Math.round((now - (c as any)._addedAt || now) / 1000);
      if (c.ageSeconds > this.CANDIDATE_TTL_MS / 1000) {
        this.candidates.delete(mint);
      }
    }


    const unenriched = [...this.candidates.values()].filter(c => c.mcap === 0 && c.holders === 0);
    if (unenriched.length > 0 && this.tradeFn) {
      const mints = unenriched.map(c => c.mint).slice(0, 20);
      let enriched = 0;


      const applyCoinData = (coins: any[]) => {
        for (const coin of coins) {
          const key = coin?.coinMint || coin?.mint;
          const c = key ? this.candidates.get(key) : null;
          if (c && (c.mcap === 0 && c.holders === 0)) {
            c.mcap = coin.marketCap || coin.usd_market_cap || 0;
            c.bondingProgress = coin.bondingCurveProgress ?? c.bondingProgress;
            c.holders = Number(coin.numHolders || coin.holders) || c.holders;
            c.hasSocials = c.hasSocials || !!(coin.twitter || coin.telegram || coin.website);
            if (c.mcap > 0 || c.holders > 0) enriched++;
          }
        }
      };


      try {
        const coinRes = await Promise.race([
          this.tradeFn('batch_get_coins', { mints }),
          new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]).catch(() => null);
        if (coinRes?.coins?.length > 0) {
          applyCoinData(coinRes.coins);
        }
      } catch {  }


      const stillUnenriched = mints.filter(m => {
        const c = this.candidates.get(m);
        return c && c.mcap === 0 && c.holders === 0;
      });
      if (stillUnenriched.length > 0) {
        try {
          const onChainRes = await Promise.race([
            this.tradeFn('batch_enrich_onchain', { mints: stillUnenriched }),
            new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
          ]).catch(() => null);
          if (onChainRes?.coins?.length > 0) {
            applyCoinData(onChainRes.coins);
            this.logger.debug(`[Sniper] On-chain fallback enriched ${onChainRes.coins.length}/${stillUnenriched.length} tokens`);
          }
        } catch {  }
      }


      const finalUnenriched = mints.filter(m => {
        const c = this.candidates.get(m);
        return c && c.mcap === 0;
      }).slice(0, 5);
      if (finalUnenriched.length > 0) {
        try {
          const gmgnResults = await Promise.allSettled(
            finalUnenriched.map(mint =>
              this.tradeFn!('get_token_pairs', { mint }).then((pairs: any) => {
                if (Array.isArray(pairs) && pairs.length > 0) {
                  const best = pairs[0];
                  return {
                    mint,
                    coinMint: mint,
                    marketCap: best.marketCap || best.fdv || 0,
                    bondingCurveProgress: 100,
                    numHolders: best.holderCount || 0,
                  };
                }
                return null;
              }).catch(() => null)
            )
          );
          const gmgnCoins = gmgnResults
            .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && !!r.value)
            .map(r => r.value);
          if (gmgnCoins.length > 0) {
            applyCoinData(gmgnCoins);
            this.logger.debug(`[Sniper] GMGN fallback enriched ${gmgnCoins.length}/${finalUnenriched.length} tokens`);
          }
        } catch {  }
      }

      if (enriched < mints.length) {
        this.logger.debug(`[Sniper] Enrichment: ${enriched}/${mints.length} tokens got data (${mints.length - enriched} still missing)`);
      }
    }


    const PUMP_MCAP_FLOOR_SCORE = 4000;
    const scoredCandidates: SniperCandidate[] = [];
    for (const [mint, c] of this.candidates) {

      if (c.narrativeBonus === 0) {
        c.narrativeBonus = this.trendContext.scoreNarrativeMatch(c.name, c.description);
      }

      if (this.trendContext.isXTrackerMint(c.mint)) {
        c.score += 15;
      }
      c.score = Math.min(100, c.score + c.narrativeBonus);


      if (c.mcap <= 0) {
        this.logger.debug(`[Sniper] Skip no-mcap candidate $${c.symbol}: mcap=0 — no price data`);
        continue;
      }

      if (c.mcap < PUMP_MCAP_FLOOR_SCORE && c.holders <= 2) {
        this.logger.debug(`[Sniper] Skip dead candidate $${c.symbol}: mcap=${(c.mcap/1000).toFixed(1)}k holders=${c.holders}`);
        this.candidates.delete(mint);
        continue;
      }

      if (c.holders === 0 && c.mcap > 0) {
        c.score = Math.max(0, c.score - 15);
      }

      if (c.holders >= 10 && c.ageSeconds < 120) {
        c.score = Math.min(100, c.score + 10);
      }


      if (this.contextMemory && (c as any).dev) {
        try {
          const devRep = this.contextMemory.getDevReputation((c as any).dev);
          if (devRep) {
            if (devRep.reputation === 'serial_rugger') {
              c.score = Math.max(0, c.score - 40);
              this.logger.debug(`[Sniper] Dev ${(c as any).dev.slice(0, 8)} is serial rugger (${devRep.rugRate.toFixed(0)}% rug rate) → -40 score on $${c.symbol}`);
            } else if (devRep.reputation === 'suspicious') {
              c.score = Math.max(0, c.score - 15);
            } else if (devRep.reputation === 'trusted' && devRep.totalLaunches >= 3) {
              c.score = Math.min(100, c.score + 10);
            }
          }
        } catch {  }
      }


      if (this.contextMemory) {
        try {
          const patternsForName = this.contextMemory.getProfitablePatterns('name', 3);
          const symbolL = c.symbol.toLowerCase();
          for (const p of patternsForName) {
            if (p.pattern === symbolL && p.winRate > 0.6) {
              c.score = Math.min(100, c.score + 8);
              break;
            }
          }
        } catch {  }
      }


      if (this.openPositions.has(mint)) {
        this.logger.debug(`[Sniper] Skip duplicate (open position): $${c.symbol}`);
        continue;
      }
      if (this.tradedMints.has(mint)) {
        this.logger.debug(`[Sniper] Skip duplicate (already traded): $${c.symbol}`);
        this.candidates.delete(mint);
        continue;
      }

      scoredCandidates.push(c);
    }


    scoredCandidates.sort((a, b) => b.score - a.score);
    const topCandidates = scoredCandidates.slice(0, 10);


    for (const c of scoredCandidates) {
      this.recentEvaluated.set(c.mint, { symbol: c.symbol, score: c.score, ts: now });
    }

    if (this.recentEvaluated.size > this.MAX_RECENT_EVALUATED) {
      const cutoff = now - 600_000;
      for (const [mint, entry] of this.recentEvaluated) {
        if (entry.ts < cutoff) this.recentEvaluated.delete(mint);
      }
    }


    if (topCandidates.length > 0) {
      think.lines.push({
        icon: '🔍',
        text: `Evaluating ${topCandidates.length} candidates from ${this.candidates.size} in pool (min score: ${this.strategy.minScore}):`,
      });


      const top5 = topCandidates.slice(0, 5);
      const axiomStatus = this.browserService?.getStatus();
      const axiomAvailable = axiomStatus?.axiomConnected === true;
      if (!axiomAvailable) {
        this.logger.debug(`[Sniper] Axiom API unavailable (browserService=${!!this.browserService}, status=${JSON.stringify(axiomStatus || {})})`);
      }
      const [ixResults, cabalResults, axiomResults] = await Promise.all([
        Promise.all(
          top5.map(c => this.checkBundleCluster(c.mint).catch(() => ({ safe: true, reason: '?', top10Holders: undefined as string | undefined })))
        ),
        Promise.all(
          top5.map(c => fetchCabalSpy(c.mint).catch(() => null))
        ),

        axiomAvailable
          ? Promise.all(
              top5.map(async (c) => {
                try {
                  return await Promise.race([
                    axiomBatchTokenDataTracked(c.mint),
                    new Promise<null>((_, rej) => setTimeout(() => rej(new Error('axiom-timeout')), 12000)),
                  ]).catch(() => null);
                } catch { return null; }
              })
            )
          : top5.map(() => null),
      ]);


      const top10Results = await Promise.all(
        top5.map(async (c, i) => {


          const axm = axiomResults[i] as any;
          if (axm?.holderData) {
            const raw = axm.holderData;
            const holders: any[] = Array.isArray(raw) ? raw
              : Array.isArray(raw?.holders) ? raw.holders
              : Array.isArray(raw?.data) ? raw.data
              : [];
            if (holders.length > 0) {

              try { this.logger.debug(`[Sniper/holderV5] mint=${c.mint.slice(0,8)} isArray=${Array.isArray(holders[0])} len=${Array.isArray(holders[0]) ? holders[0].length : 'obj'} sample=${JSON.stringify(holders[0]).slice(0,400)}`); } catch {}


              let supplyIdx = 2;
              const sample = holders[0];
              if (Array.isArray(sample) && sample.length > 3) {

                const testTop = holders.slice(0, Math.min(10, holders.length));
                const h2Max = Math.max(...testTop.map((h: any) => Number(h[2]) || 0));
                if (h2Max > 100) {


                  const refTop10 = axm?.tokenInfo?.top10HoldersPercent;
                  let bestIdx = -1;
                  let bestDiff = Infinity;
                  for (let idx = 3; idx < Math.min(sample.length, 8); idx++) {
                    const vals = testTop.map((h: any) => Number(h[idx]) || 0);
                    const allValid = vals.every(v => v >= 0 && v <= 100);
                    if (!allValid) continue;
                    const sum = vals.reduce((s, v) => s + v, 0);
                    if (sum > 100) continue;
                    if (refTop10 && refTop10 > 0) {
                      const diff = Math.abs(sum - refTop10);
                      if (diff < bestDiff) { bestDiff = diff; bestIdx = idx; }
                    } else if (bestIdx < 0) {
                      bestIdx = idx;
                    }
                  }
                  if (bestIdx >= 0) supplyIdx = bestIdx;
                  else {

                    this.logger.warn(`[Sniper] holder-data-v5 for ${c.mint.slice(0, 8)}… has no valid supply % field (h[2] max=${h2Max.toFixed(1)}), skipping`);
                  }
                }
              }
              const getPct = (h: any) => {
                if (Array.isArray(h)) {
                  const v = Number(h[supplyIdx] ?? 0);
                  return (v >= 0 && v <= 100) ? v : 0;
                }
                return Number(h.pctSupply ?? h.pct ?? h.percentage ?? 0);
              };
              const getAddr = (h: any) => (Array.isArray(h) ? h[0] : (h.address || h.wallet || h.owner)) || '?';
              const sorted = holders.sort((a: any, b: any) => getPct(b) - getPct(a));
              const formatted = sorted.slice(0, 6).map((h: any) => {
                const addr = String(getAddr(h));
                const pct = getPct(h);
                return `${addr.slice(0, 4)}..${addr.slice(-4)}(${Number(pct).toFixed(1)}%)`;
              }).join(' ');
              if (formatted && !formatted.includes('(0.0%)')) return formatted;
            }
          }

          if (ixResults[i].top10Holders) return ixResults[i].top10Holders;

          if (!this.tradeFn) return undefined;
          try {
            const holdersRes = await Promise.race([
              this.tradeFn('insightx_top_holders', { mint: c.mint }),
              new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
            ]).catch(() => null);
            if (holdersRes?.holders?.length) {
              return holdersRes.holders
                .slice(0, 6)
                .map((h: any) => `${(h.address || '?').slice(0, 4)}..${(h.address || '?').slice(-4)}(${(h.pct ?? 0).toFixed(1)}%)`)
                .join(' ');
            }
          } catch {}
          return undefined;
        })
      );

      think.candidates = top5.map((c, i) => {
        const ix = ixResults[i];
        const cabal = cabalResults[i];
        const axm = axiomResults[i] as any;

        if (cabal) {
          if (cabal.kols >= 5) c.score = Math.min(100, c.score + 15);
          else if (cabal.kols >= 3) c.score = Math.min(100, c.score + 10);
          else if (cabal.kols >= 1) c.score = Math.min(100, c.score + 5);
          if (cabal.whales >= 2) c.score = Math.min(100, c.score + 10);
          else if (cabal.whales >= 1) c.score = Math.min(100, c.score + 6);
          if (cabal.smart >= 3) c.score = Math.min(100, c.score + 8);
          else if (cabal.smart >= 1) c.score = Math.min(100, c.score + 5);

          if (cabal.kolSellVol > cabal.kolBuyVol * 2 && cabal.kolSellVol > 1) {
            c.score = Math.max(0, c.score - 10);
          }

          (c as any)._cabal = cabal;
        }


        let axiomTag = '';

        if (axm?.pairAddress) (c as any)._pairAddress = axm.pairAddress;
        if (axm?.tokenInfo) {
          const ti = axm.tokenInfo;

          if (ti.insidersHoldPercent > 20) c.score = Math.max(0, c.score - 10);
          else if (ti.insidersHoldPercent > 10) c.score = Math.max(0, c.score - 5);

          if (ti.bundlersHoldPercent > 15) c.score = Math.max(0, c.score - 8);

          if (ti.snipersHoldPercent > 20) c.score = Math.max(0, c.score - 5);

          if (ti.dexPaid) c.score = Math.min(100, c.score + 3);

          if (ti.numHolders > c.holders) c.holders = ti.numHolders;

          axiomTag = ` top10=${ti.top10HoldersPercent?.toFixed(1)}% dev=${ti.devHoldsPercent?.toFixed(1)}% ins=${ti.insidersHoldPercent?.toFixed(1)}%`;
          if (ti.bundlersHoldPercent > 0) axiomTag += ` bnd=${ti.bundlersHoldPercent?.toFixed(1)}%`;
          if (ti.snipersHoldPercent > 0) axiomTag += ` snp=${ti.snipersHoldPercent?.toFixed(1)}%`;
          if (ti.dexPaid) axiomTag += ' 💰dexPaid';
        }

        if (axm?.kolTxns?.length > 0) {
          const kolBuys = axm.kolTxns.filter((t: any) => t.side === 'buy' || t.type === 'buy').length;
          axiomTag += ` axKOL=${axm.kolTxns.length}(${kolBuys}buy)`;

          if (!cabal || cabal.kols === 0) {
            if (axm.kolTxns.length >= 3) c.score = Math.min(100, c.score + 8);
            else if (axm.kolTxns.length >= 1) c.score = Math.min(100, c.score + 4);
          }
        }

        if (axm?.sniperTxns?.length > 5) {
          axiomTag += ` snp🎯=${axm.sniperTxns.length}`;
        }
        if (axm?.tokenAnalysis) {
          const ta = axm.tokenAnalysis;

          if (ta.creatorRugCount > 2) c.score = Math.max(0, c.score - 20);
          else if (ta.creatorRugCount > 0) c.score = Math.max(0, c.score - 10);

          if (ta.reusedImageOgTokens?.length > 0) c.score = Math.max(0, c.score - 8);
          if (ta.creatorRugCount > 0) axiomTag += ` ⚠️rugs=${ta.creatorRugCount}`;
          if (ta.reusedImageOgTokens?.length > 0) axiomTag += ' 🖼️reused';
        }

        const cabalTag = cabal ? ` | 🕵️KOL=${cabal.kols} Smart=${cabal.smart} Whale=${cabal.whales}` : '';

        return {
          symbol: c.symbol,
          score: c.score,
          narrative: c.narrativeBonus,
          reason: `mcap=${c.mcap ? (c.mcap/1000).toFixed(0)+'k' : '?'} holders=${c.holders} bond=${c.bondingProgress.toFixed(0)}%${c.hasSocials ? ' ✅socials' : ''}`,
          bundleCheck: ix.reason + cabalTag + (axiomTag ? ` |${axiomTag}` : ''),
          top10Holders: top10Results[i],
        };
      });
      for (const tc of think.candidates) {
        const scoreColor = tc.score >= this.strategy.minScore ? 'green' : tc.score >= 40 ? 'yellow' : 'red';
        const isSafe = !tc.bundleCheck?.includes('bundled') && !tc.bundleCheck?.includes('cluster ') && !tc.bundleCheck?.includes('check failed');
        const bundleTag = tc.bundleCheck ? ` | ${isSafe ? '🛡️' : '🚨'}${tc.bundleCheck}` : '';
        think.lines.push({
          icon: tc.score >= this.strategy.minScore ? '✅' : tc.score >= 40 ? '🤔' : '❌',
          text: `  $${tc.symbol} — score: ${tc.score}${tc.narrative > 0 ? ' (+' + tc.narrative + ' trend)' : ''} | ${tc.reason}${bundleTag}`,
          color: scoreColor,
        });
        if (tc.top10Holders) {
          think.lines.push({
            icon: '👥',
            text: `    └ top10: ${tc.top10Holders}`,
          });
        }
      }
    } else {
      think.lines.push({
        icon: '👀',
        text: `Pool empty — waiting for new tokens from pump.fun and trenches...`,
      });
    }


    let decision: SniperDecision = { action: 'wait' };
    let usedLLM = false;

    if (!exposure.canOpenNew) {
      decision = { action: 'skip', reason: 'Max positions reached or no balance' };
      think.lines.push({ icon: '🚫', text: 'Position limit reached or no balance — skipping', color: 'yellow' });
    } else if (topCandidates.length > 0) {
      const best = topCandidates[0];

      if (best.score >= this.strategy.minScore) {


        let buyAmount = this.strategy.buyAmountSol;
        const cabalData = (best as any)._cabal;
        let buyBoostReason = '';
        if (cabalData) {
          const kolCount = cabalData.kols || 0;
          const smartCount = cabalData.smart || 0;
          const whaleCount = cabalData.whales || 0;
          if (kolCount >= 5 || smartCount >= 3 || whaleCount >= 2) {
            buyAmount = +(buyAmount * 1.5).toFixed(4);
            buyBoostReason = ` (1.5x boost: KOL=${kolCount} Smart=${smartCount} Whale=${whaleCount})`;
          } else if (kolCount >= 3 || smartCount >= 1 || whaleCount >= 1) {
            buyAmount = +(buyAmount * 1.25).toFixed(4);
            buyBoostReason = ` (1.25x boost: KOL=${kolCount} Smart=${smartCount})`;
          }

          buyAmount = Math.min(buyAmount, exposure.availableBalance * 0.30);
          buyAmount = +buyAmount.toFixed(4);
        }

        const annBoost = (best as any)._announcementBoost as { multiplier: number; label: string; until: number } | undefined;
        if (annBoost && annBoost.until > Date.now()) {
          const before = buyAmount;
          buyAmount = +(buyAmount * annBoost.multiplier).toFixed(4);
          buyAmount = Math.min(buyAmount, exposure.availableBalance * 0.30);
          buyAmount = +buyAmount.toFixed(4);
          buyBoostReason += ` (${annBoost.multiplier}x announcement: ${annBoost.label})`;
          this.logger.info(`[Sniper] Announcement size boost ${before}->${buyAmount} SOL (${annBoost.label})`);
        }

        if (buyAmount >= 0.005 && buyAmount <= (exposure.availableBalance + 0.001)) {

          const cachedIx = think.candidates?.find(tc => tc.symbol === best.symbol);
          const isCachedSafe = cachedIx?.bundleCheck && !cachedIx.bundleCheck.includes('bundled') && !cachedIx.bundleCheck.includes('cluster ') && !cachedIx.bundleCheck.includes('check failed');
          const ixCheck = cachedIx?.bundleCheck
            ? { safe: !!isCachedSafe, reason: cachedIx.bundleCheck }
            : await this.checkBundleCluster(best.mint);
          if (!ixCheck.safe) {
            decision = { action: 'skip', reason: `InsightX: ${ixCheck.reason}` };
            think.lines.push({ icon: '🚨', text: `REJECTED $${best.symbol} — ${ixCheck.reason}`, color: 'red' });

            this.candidates.delete(best.mint);
          } else {
            think.lines.push({ icon: '✅', text: `InsightX OK — ${ixCheck.reason}`, color: 'green' });


            think.lines.push({ icon: '📊', text: `Analyzing chart $${best.symbol}...`, color: 'cyan' });
            const chartVerdict = await this.preBuyChartCheck(best.mint, best.symbol, best.score, best.mcap, best.narrativeBonus, best.description);
            this.stats.llmCalls++;

            if (!chartVerdict.buy) {
              decision = { action: 'skip', reason: `Chart AI: ${chartVerdict.reason}` };
              think.lines.push({ icon: '🚫', text: `CHART REJECTED: ${chartVerdict.reason} — not buying`, color: 'red' });
              this.candidates.delete(best.mint);
            } else {
              think.lines.push({
                icon: '📈',
                text: `Chart OK: ${chartVerdict.reason} | AI SL: ${chartVerdict.stopLoss}% | TP: ${chartVerdict.tpLevels.map(l => l.at + 'x').join('/')}`,
                color: 'green',
              });

              (best as any)._chartStopLoss = chartVerdict.stopLoss;
              (best as any)._chartTpLevels = chartVerdict.tpLevels;

              decision = {
                action: 'buy',
                mint: best.mint,
                amount: buyAmount,
                reason: `score=${best.score} ${best.symbol}${buyBoostReason}`,
              };
              think.lines.push({
                icon: '🚀',
                text: `BUYING $${best.symbol} for ${buyAmount.toFixed(4)} SOL${buyBoostReason}! Score ${best.score} ≥ ${this.strategy.minScore} | SL=${chartVerdict.stopLoss}% TP=${chartVerdict.tpLevels[0]?.at}x`,
                color: 'green',
              });
            }
          }
        }
      } else if (best.score >= 40 && this.llmFn) {

        think.lines.push({
          icon: '🧠',
          text: `$${best.symbol} score ${best.score} — ambiguous, asking LLM...`,
          color: 'cyan',
        });
        usedLLM = true;
        this.stats.llmCalls++;
        try {
          const sniperState: SniperState = {
            walletBalance: exposure.availableBalance + exposure.totalInvestedSol,
            openPositions: exposure.openPositions,
            totalInvested: exposure.totalInvestedSol,
            maxNewPosition: exposure.maxNewPosition,
            availableForTrading: exposure.availableBalance,
            consecutiveLosses: this.stats.consecutiveLosses,
            positions: exposure.positions,
          };

          const systemPrompt = buildSniperSystemPrompt(this.strategy);


          let learningCtx: string | undefined;
          if (this.contextMemory) {
            try {
              learningCtx = this.contextMemory.buildContextSummary();
              if (learningCtx === '[CONTEXTUAL MEMORY]') learningCtx = undefined;
            } catch {  }
          }

          const userPrompt = buildSniperUserPrompt(
            sniperState,
            this.trendContext,
            topCandidates.map(c => ({
              mint: c.mint,
              symbol: c.symbol,
              name: c.name,
              bondingProgress: c.bondingProgress,
              mcap: c.mcap,
              holders: c.holders,
              score: c.score,
              hasSocials: c.hasSocials,
              ageSeconds: c.ageSeconds,
            })),
            learningCtx,
          );

          const messages: LLMMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ];

          const response = await Promise.race([
            this.llmFn(messages, []),
            new Promise<any>((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), 8000)),
          ]);

          const text = response?.content || response?.message?.content || '';
          decision = parseSniperDecision(text);
          think.lines.push({
            icon: decision.action === 'buy' ? '🟢' : decision.action === 'sell' ? '🔴' : '⏸️',
            text: `LLM decided: ${decision.action.toUpperCase()}${decision.reason ? ' — ' + decision.reason : ''}`,
            color: decision.action === 'buy' ? 'green' : decision.action === 'sell' ? 'red' : undefined,
          });


          if (decision.action === 'buy' && decision.mint) {
            think.lines.push({ icon: '🔍', text: `Checking bundles/clusters via InsightX...`, color: 'cyan' });
            const ixCheck = await this.checkBundleCluster(decision.mint);
            if (!ixCheck.safe) {
              think.lines.push({ icon: '🚨', text: `REJECTED — ${ixCheck.reason}`, color: 'red' });
              this.candidates.delete(decision.mint);
              decision = { action: 'skip', reason: `InsightX: ${ixCheck.reason}` };
            } else {
              think.lines.push({ icon: '✅', text: `InsightX OK — ${ixCheck.reason}`, color: 'green' });
            }
          }
        } catch (err: any) {
          this.logger.debug(`[Sniper] LLM decision error: ${err?.message}`);
          decision = { action: 'skip', reason: 'LLM error' };
          think.lines.push({ icon: '⚠️', text: `LLM error: ${err?.message}`, color: 'red' });
        }
      } else {
        think.lines.push({
          icon: '⏳',
          text: `Best: $${best.symbol} score ${best.score} — below threshold ${this.strategy.minScore}, waiting for better`,
        });
      }
    } else {
      think.lines.push({
        icon: '⏳',
        text: 'No suitable candidates — scanning...',
      });
    }


    await this.executeDecision(decision);


    const cycleResult: SniperCycleResult = {
      timestamp: now,
      decision,
      candidatesEvaluated: topCandidates.length,
      walletBalance: exposure.availableBalance,
      openPositions: exposure.openPositions,
      cycleDurationMs: Date.now() - cycleStart,
      usedLLM,
      thinking: think,
    };
    this.stats.lastCycle = cycleResult;


    this.stats.recentThinking.push({ ts: now, cycle: this.stats.cycles, thinking: think });
    if (this.stats.recentThinking.length > 20) this.stats.recentThinking.shift();


    if (decision.action === 'buy') {
      this.candidates.delete(decision.mint);
    }


    this.eventBus.emit('sniper:cycle' as any, cycleResult);
  }

  private async executeDecision(decision: SniperDecision): Promise<void> {
    if (!this.tradeFn) return;

    const record = (action: string, mint?: string, reason?: string) => {
      this.stats.recentDecisions.push({ ts: Date.now(), action, mint, reason });
      if (this.stats.recentDecisions.length > 50) this.stats.recentDecisions.shift();
    };

    switch (decision.action) {
      case 'buy': {

        if (this.openPositions.has(decision.mint)) {
          this.logger.warn(`[Sniper] Duplicate blocked (already holding ${decision.mint.slice(0, 8)}) — skipping buy`);
          record('SKIP', decision.mint, 'duplicate: already holding');
          break;
        }
        if (this.tradedMints.has(decision.mint)) {
          this.logger.warn(`[Sniper] Duplicate blocked (already traded ${decision.mint.slice(0, 8)}) — skipping buy`);
          record('SKIP', decision.mint, 'duplicate: already traded this session');
          break;
        }


        if (this.openPositions.size >= this.strategy.maxConcurrentPositions) {
          this.logger.warn(`[Sniper] Position limit hit (${this.openPositions.size}/${this.strategy.maxConcurrentPositions}) — skipping buy`);
          record('SKIP', decision.mint, 'position limit re-check');
          break;
        }

        this.stats.buys++;
        record('BUY', decision.mint, decision.reason);

        const candidate = this.candidates.get(decision.mint);
        const symbol = candidate?.symbol || decision.reason?.match(/\$?(\w+)/)?.[1] || decision.mint.slice(0, 8);
        const amountSol = decision.amount;


        if (this.paperMode) {
          if (this.getPaperBalance() < amountSol) {
            this.logger.info(`[Sniper/Paper] Not enough virtual balance for ${symbol}`);
            break;
          }
          this.paperPnlAccum -= amountSol;
          const now = Date.now();
          const simulatedTokens = candidate?.mcap && candidate.mcap > 0
            ? (amountSol / candidate.mcap) * 1e9 : amountSol * 100_000;

          const position: Position = {
            mint: decision.mint,
            symbol,
            entryPrice: candidate?.mcap || 0,
            currentPrice: candidate?.mcap || 0,
            amountTokens: simulatedTokens,
            amountSolInvested: amountSol,
            unrealizedPnl: 0,
            unrealizedPnlPercent: 0,
            openedAt: now,
            lastUpdated: now,
          };

          const tracker: SniperPositionTracker = {
            position,
            peakMcap: candidate?.mcap || 0,
            peakPrice: position.entryPrice,
            lastHolders: candidate?.holders || 0,
            peakHolders: candidate?.holders || 0,
            lastMcap: candidate?.mcap || 0,
            lastBundlePct: 0,
            lastClusterPct: 0,
            partialsSold: 0,
            lastCheckAt: now,
            bondingProgress: candidate?.bondingProgress || 0,
            graduated: false,
            exitSignals: [],
            dynamicStopLoss: this.applyAnnouncementSL(
              (candidate as any)?._chartStopLoss || this.strategy.stopLossPercent,
              candidate,
            ),
            dynamicTpLevels: (candidate as any)?._chartTpLevels || [...this.strategy.takeProfitLevels],
            lastChartAnalysisAt: now,
            lastChartVerdict: 'initial',
          };

          this.openPositions.set(decision.mint, tracker);
          this.tradedMints.add(decision.mint);
          this.paperTrades.push({
            mint: decision.mint, symbol, action: 'buy',
            amountSol, price: candidate?.mcap || 0, mcap: candidate?.mcap || 0,
            timestamp: now, reason: decision.reason || '',
            pairAddress: (candidate as any)?._pairAddress || undefined,
          });
          this.paperStats.totalTrades++;
          this.eventBus.emit('position:opened', position);
          if (candidate) this.storeEntryAnalysis(decision.mint, candidate);
          this.logger.info(`[Sniper/Paper] 📝 PAPER BUY ${symbol} for ${amountSol.toFixed(4)} vSOL | mcap=${candidate?.mcap || 0} | SL=${tracker.dynamicStopLoss}%`);
          this.savePaperState();
          break;
        }


        this.logger.info(`[Sniper] BUY ${decision.mint.slice(0, 12)} for ${amountSol.toFixed(4)} SOL — ${decision.reason}`);
        try {
          const result = await this.tradeFn!('fast_buy', {
            mint: decision.mint,
            amount_sol: amountSol,
            slippage_bps: this.strategy.slippageBps,
            use_jito: true,
          });


          if (result?.success) {
            const now = Date.now();
            const investedSol = result.amountSol || amountSol;
            const tokens = result.amountTokens || 0;


            const entryPricePerToken = tokens > 0 ? investedSol / tokens : 0;
            const entryMcap = candidate?.mcap || 0;

            const position: Position = {
              mint: decision.mint,
              symbol,
              entryPrice: entryMcap,
              currentPrice: entryMcap,
              amountTokens: tokens,
              amountSolInvested: investedSol,
              unrealizedPnl: 0,
              unrealizedPnlPercent: 0,
              openedAt: now,
              lastUpdated: now,
            };

            const tracker: SniperPositionTracker = {
              position,
              peakMcap: entryMcap,
              peakPrice: entryPricePerToken,
              lastHolders: candidate?.holders || 0,
              peakHolders: candidate?.holders || 0,
              lastMcap: entryMcap,
              lastBundlePct: 0,
              lastClusterPct: 0,
              partialsSold: 0,
              lastCheckAt: now,
              bondingProgress: candidate?.bondingProgress || 0,
              graduated: false,
              exitSignals: [],
              dynamicStopLoss: this.applyAnnouncementSL(
                (candidate as any)?._chartStopLoss || this.strategy.stopLossPercent,
                candidate,
              ),
              dynamicTpLevels: (candidate as any)?._chartTpLevels || [...this.strategy.takeProfitLevels],
              lastChartAnalysisAt: now,
              lastChartVerdict: 'initial',
            };

            this.openPositions.set(decision.mint, tracker);
            this.tradedMints.add(decision.mint);
            this.eventBus.emit('position:opened', position);
            if (candidate) this.storeEntryAnalysis(decision.mint, candidate);
            this.logger.info(`[Sniper] Position opened: ${symbol} | invested=${investedSol.toFixed(4)} SOL | tokens=${tokens} | pricePer=${entryPricePerToken.toFixed(10)} | mcap=${entryMcap} | SL=${tracker.dynamicStopLoss}% | tracking started`);
          }
        } catch (err: any) {
          this.stats.errors++;
          this.logger.error(`[Sniper] Buy execution failed: ${err?.message}`);
        }
        break;
      }
      case 'sell': {
        record('SELL', decision.mint, decision.reason);


        if (this.paperMode) {
          const tracker = this.openPositions.get(decision.mint);
          if (tracker) {
            const pos = tracker.position;
            const sellFraction = (decision.percent || 100) / 100;
            const returnSol = pos.amountSolInvested * sellFraction * (1 + pos.unrealizedPnlPercent / 100);
            const pnlSol = returnSol - (pos.amountSolInvested * sellFraction);
            this.paperPnlAccum += returnSol;
            this.paperTrades.push({
              mint: decision.mint, symbol: pos.symbol, action: 'sell',
              amountSol: returnSol, price: pos.currentPrice, mcap: tracker.lastMcap,
              timestamp: Date.now(), reason: decision.reason || '',
              pnlPercent: pos.unrealizedPnlPercent, pnlSol,
            });
            this.paperStats.totalTrades++;
            if (pnlSol >= 0) { this.paperStats.wins++; } else { this.paperStats.losses++; }
            this.paperStats.totalPnl += pnlSol;
            if (pnlSol > this.paperStats.bestTrade) this.paperStats.bestTrade = pnlSol;
            if (pnlSol < this.paperStats.worstTrade) this.paperStats.worstTrade = pnlSol;
            this.logger.info(`[Sniper/Paper] 📝 PAPER SELL ${pos.symbol} ${decision.percent}% | P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} vSOL (${pos.unrealizedPnlPercent.toFixed(1)}%)`);

            this.addLearningEntry(pnlSol >= 0 ? 'pattern' : 'mistake',
              `${pnlSol >= 0 ? 'WIN' : 'LOSS'} $${pos.symbol}: ${pos.unrealizedPnlPercent.toFixed(1)}% | ${decision.reason}`,
              `mcap_entry=${pos.entryPrice} mcap_exit=${tracker.lastMcap} hold=${((Date.now() - pos.openedAt) / 60000).toFixed(1)}min`);

            if (decision.percent >= 100) {
              const sellCandidate = this.candidates.get(decision.mint);
              this.recordTradeOutcome(
                decision.mint, pos.symbol, (sellCandidate as any)?.dev,
                pnlSol, pos.unrealizedPnlPercent, Date.now() - pos.openedAt,
                sellCandidate, tracker,
              );
              this.closePosition(decision.mint, decision.reason);
            }
            this.savePaperState();
          }
          break;
        }


        this.logger.info(`[Sniper] SELL ${decision.percent}% of ${decision.mint.slice(0, 12)} — ${decision.reason}`);
        try {
          await this.tradeFn!('fast_sell', {
            mint: decision.mint,
            percent: decision.percent,
            slippage_bps: this.strategy.slippageBps,
            use_jito: true,
          });


          if (decision.percent >= 100) {
            this.closePosition(decision.mint, decision.reason);
          }
        } catch (err: any) {
          this.stats.errors++;
          this.logger.error(`[Sniper] Sell execution failed: ${err?.message}`);
        }
        break;
      }
      case 'skip': {
        this.stats.skips++;
        record('SKIP', undefined, decision.reason);
        break;
      }
      case 'wait': {
        record('WAIT', undefined, `cycle #${this.stats.cycles} — ${this.candidates.size} candidates in pool`);
        break;
      }
    }
  }


private async monitorPositions(think: SniperThinking): Promise<void> {
    if (this.openPositions.size === 0 || !this.tradeFn) return;

    const now = Date.now();
    const sellQueue: Array<{ mint: string; percent: number; reason: string; urgency: string }> = [];

    for (const [mint, tracker] of this.openPositions) {
      const pos = tracker.position;
      const holdMs = now - pos.openedAt;
      const holdMinutes = holdMs / 60_000;
      tracker.exitSignals = [];


      try {
        const [tokenInfo, marketActivity] = await Promise.all([
          Promise.race([
            this.tradeFn('get_token_info', { mint }),
            new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]).catch(() => null),
          Promise.race([
            this.tradeFn('get_market_activity', { mint }),
            new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
          ]).catch(() => null),
        ]);

        if (tokenInfo && !tokenInfo.error) {
          const newMcap = tokenInfo.marketCap || tokenInfo.onChain?.marketCapSOL || 0;
          const newHolders = Number(tokenInfo.totalHolders || tokenInfo.holders) || 0;
          const newBondingProgress = tokenInfo.bondingCurveProgress ?? tracker.bondingProgress;
          const newPrice = tokenInfo.price || tokenInfo.onChain?.marketCapSOL || newMcap;


          tracker.lastMcap = newMcap;
          tracker.lastHolders = newHolders;
          tracker.bondingProgress = newBondingProgress;
          tracker.graduated = tokenInfo.onChain?.graduated ?? newBondingProgress >= 100;
          if (newMcap > tracker.peakMcap) tracker.peakMcap = newMcap;
          if (newHolders > tracker.peakHolders) tracker.peakHolders = newHolders;
          if (newPrice > tracker.peakPrice) tracker.peakPrice = newPrice;


          pos.currentPrice = newMcap;
          pos.lastUpdated = now;


          if (pos.entryPrice <= 0 && newMcap > 0) {
            pos.entryPrice = newMcap;
            tracker.peakMcap = newMcap;
            (tracker as any)._justBackfilled = true;
            this.logger.info(`[Sniper/Monitor] Backfilled entryPrice for ${pos.symbol}: mcap=${newMcap}`);
          }

          if (pos.entryPrice > 0 && newMcap > 0) {
            pos.unrealizedPnlPercent = ((newMcap - pos.entryPrice) / pos.entryPrice) * 100;
            pos.unrealizedPnl = pos.amountSolInvested * (pos.unrealizedPnlPercent / 100);
          } else {

            this.logger.debug(`[Sniper/Monitor] ${pos.symbol}: no price data yet (entry=${pos.entryPrice}, mcap=${newMcap})`);
          }

          this.eventBus.emit('position:updated', pos);
        }


        if (marketActivity && !marketActivity.error) {

          this.eventBus.emit('token:update' as any, {
            mint,
            price: pos.currentPrice,
            mcap: tracker.lastMcap,
            volume5m: marketActivity.volume5m || 0,
            volume1h: marketActivity.volume1h || 0,
            volume24h: marketActivity.volume24h || 0,
            holders: tracker.lastHolders,
            bondingProgress: tracker.bondingProgress,
            timestamp: now,
          });
        }
      } catch (err: any) {
        this.logger.debug(`[Sniper/Monitor] Token data fetch failed for ${pos.symbol}: ${err?.message}`);
      }


      if (now - tracker.lastCheckAt > 60_000) {
        tracker.lastCheckAt = now;
        try {
          const ixCheck = await this.checkBundleCluster(mint);

          const bundleMatch = ixCheck.reason.match(/bundle[=:]?([\d.]+)%/);
          const clusterMatch = ixCheck.reason.match(/cluster[=:]?([\d.]+)%/);
          if (bundleMatch) tracker.lastBundlePct = parseFloat(bundleMatch[1]);
          if (clusterMatch) tracker.lastClusterPct = parseFloat(clusterMatch[1]);


          if (tracker.lastBundlePct > 15) {
            tracker.exitSignals.push(`bundle_grew_${tracker.lastBundlePct.toFixed(0)}%`);
          }
          if (tracker.lastClusterPct > 40) {
            tracker.exitSignals.push(`cluster_high_${tracker.lastClusterPct.toFixed(0)}%`);
          }
        } catch {}
      }


      const CHART_ANALYSIS_INTERVAL = 30_000;
      if (this.llmFn && now - tracker.lastChartAnalysisAt > CHART_ANALYSIS_INTERVAL) {
        tracker.lastChartAnalysisAt = now;
        try {
          this.stats.llmCalls++;
          const chartResult = await this.postBuyChartAnalysis(tracker);
          tracker.lastChartVerdict = chartResult.reason;


          if (chartResult.newStopLoss !== tracker.dynamicStopLoss) {
            const oldSL = tracker.dynamicStopLoss;
            tracker.dynamicStopLoss = chartResult.newStopLoss;
            think.lines.push({
              icon: '🎚️',
              text: `  └ AI SL $${pos.symbol}: ${oldSL}% → ${chartResult.newStopLoss}% (${chartResult.reason})`,
              color: chartResult.newStopLoss < oldSL ? 'red' : 'green',
            });
          }


          if (chartResult.newTpLevels && JSON.stringify(chartResult.newTpLevels) !== JSON.stringify(tracker.dynamicTpLevels)) {
            tracker.dynamicTpLevels = chartResult.newTpLevels;
            const tpStr = chartResult.newTpLevels.map(l => `${l.at}x→${l.sellPercent}%`).join(' · ');
            think.lines.push({
              icon: '🎯',
              text: `  └ AI TP $${pos.symbol}: ${tpStr}`,
              color: 'cyan',
            });
          }


          if (chartResult.sellNow) {
            tracker.exitSignals.push(`ai_chart_sell: ${chartResult.reason}`);
            sellQueue.push({
              mint,
              percent: chartResult.sellPercent || 100,
              reason: `AI CHART SELL: ${chartResult.reason}`,
              urgency: 'high',
            });
            think.lines.push({
              icon: '🧠',
              text: `  └ AI SELL $${pos.symbol} ${chartResult.sellPercent}%: ${chartResult.reason}`,
              color: 'red',
            });
          }
        } catch (err: any) {
          this.logger.debug(`[Sniper/Chart] Post-buy analysis error for ${pos.symbol}: ${err?.message}`);
        }
      }


      const pnlPct = pos.unrealizedPnlPercent;
      const mcapMultiplier = pos.entryPrice > 0 ? pos.currentPrice / pos.entryPrice : 1;
      const drawdownFromPeak = tracker.peakMcap > 0
        ? ((tracker.peakMcap - tracker.lastMcap) / tracker.peakMcap) * 100
        : 0;
      const holderDrop = tracker.peakHolders > 0
        ? ((tracker.peakHolders - tracker.lastHolders) / tracker.peakHolders) * 100
        : 0;


      if ((tracker as any)._justBackfilled) {
        delete (tracker as any)._justBackfilled;

      }

      let effectiveSL = tracker.dynamicStopLoss || this.strategy.stopLossPercent;
      if (tracker.partialsSold > 0) {


        const tightenFactor = tracker.partialsSold >= 2 ? 0.4 : 0.6;
        const tightenedSL = Math.round(effectiveSL * tightenFactor);
        effectiveSL = Math.max(tightenedSL, 15);
      }
      if (pnlPct <= -effectiveSL) {
        tracker.exitSignals.push(`stop_loss_${pnlPct.toFixed(0)}%`);
        sellQueue.push({ mint, percent: 100, reason: `STOP LOSS ${pnlPct.toFixed(1)}% (limit -${effectiveSL}%)`, urgency: 'high' });
      }


      if (sellQueue.every(s => s.mint !== mint)) {
        const positionTp = tracker.dynamicTpLevels || this.strategy.takeProfitLevels;
        for (let i = tracker.partialsSold; i < positionTp.length; i++) {
          const tp = positionTp[i];
          if (mcapMultiplier >= tp.at) {
            tracker.exitSignals.push(`take_profit_${tp.at}x_sell_${tp.sellPercent}%`);
            sellQueue.push({
              mint,
              percent: tp.sellPercent,
              reason: `TAKE PROFIT ${mcapMultiplier.toFixed(1)}x ≥ ${tp.at}x → sell ${tp.sellPercent}%`,
              urgency: 'medium',
            });
            tracker.partialsSold = i + 1;
            break;
          }
        }
      }


      const mcapStagnant = Math.abs(pnlPct) < 5 && tracker.lastHolders <= (tracker.peakHolders * 0.8);
      const effectiveTimeout = mcapStagnant ? Math.min(10, this.strategy.timeoutMinutes) : this.strategy.timeoutMinutes;
      if (holdMinutes >= effectiveTimeout && pnlPct < 5 && sellQueue.every(s => s.mint !== mint)) {
        tracker.exitSignals.push(`timeout_${holdMinutes.toFixed(0)}min${mcapStagnant ? '_stagnant' : ''}`);
        sellQueue.push({ mint, percent: 100, reason: `TIMEOUT ${holdMinutes.toFixed(0)}min (limit ${effectiveTimeout}min${mcapStagnant ? ', stagnant' : ''}) with ${pnlPct.toFixed(1)}% P&L`, urgency: 'medium' });
      }


      const trailingPct = this.strategy.trailingStopPercent || 15;
      if (drawdownFromPeak >= trailingPct && pnlPct > 3 && sellQueue.every(s => s.mint !== mint)) {
        tracker.exitSignals.push(`trailing_stop_${drawdownFromPeak.toFixed(0)}%_from_peak`);
        sellQueue.push({ mint, percent: 100, reason: `TRAILING STOP -${drawdownFromPeak.toFixed(0)}% from peak (limit ${trailingPct}%)`, urgency: 'medium' });
      }


      if (holderDrop >= 25 && sellQueue.every(s => s.mint !== mint)) {
        tracker.exitSignals.push(`holder_exodus_${holderDrop.toFixed(0)}%`);

        const exodusSellPct = (tracker.lastHolders <= 2 || holderDrop >= 80) ? 100 : 80;
        sellQueue.push({ mint, percent: exodusSellPct, reason: `HOLDER EXODUS -${holderDrop.toFixed(0)}% from peak (${tracker.peakHolders}→${tracker.lastHolders})`, urgency: 'high' });
      }


      const PUMP_MCAP_FLOOR = 4000;
      if (tracker.lastMcap > 0 && tracker.lastMcap < PUMP_MCAP_FLOOR && tracker.lastHolders <= 2 && holdMinutes > 2 && sellQueue.every(s => s.mint !== mint)) {
        tracker.exitSignals.push(`dead_token_mcap=${(tracker.lastMcap/1000).toFixed(1)}k_holders=${tracker.lastHolders}`);
        sellQueue.push({ mint, percent: 100, reason: `DEAD TOKEN: mcap=${(tracker.lastMcap/1000).toFixed(1)}k (floor zone) + ${tracker.lastHolders} holders — no interest`, urgency: 'high' });
      }


      if (tracker.exitSignals.some(s => s.startsWith('bundle_grew') || s.startsWith('cluster_high')) && sellQueue.every(s => s.mint !== mint)) {
        sellQueue.push({ mint, percent: 100, reason: `DANGER: ${tracker.exitSignals.filter(s => s.startsWith('bundle') || s.startsWith('cluster')).join(', ')}`, urgency: 'high' });
      }


      const pnlColor = pnlPct >= 0 ? 'green' : 'red';
      const pnlIcon = pnlPct >= 0 ? '📈' : '📉';
      const posTpStr = (tracker.dynamicTpLevels || this.strategy.takeProfitLevels).map(l => `${l.at}x`).join('/');
      think.lines.push({
        icon: pnlIcon,
        text: `POSITION $${pos.symbol}: mcap=${tracker.lastMcap > 0 ? (tracker.lastMcap / 1000).toFixed(1) + 'k' : '?'} (${mcapMultiplier.toFixed(1)}x) | P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | holders=${tracker.lastHolders} (peak ${tracker.peakHolders}) | hold=${holdMinutes.toFixed(0)}min | SL=${effectiveSL}% TP=${posTpStr} | bond=${tracker.bondingProgress.toFixed(0)}%${tracker.graduated ? ' 🎓' : ''}`,
        color: pnlColor,
      });

      if (tracker.lastChartVerdict && tracker.lastChartVerdict !== 'initial') {
        think.lines.push({
          icon: '🧠',
          text: `  └ AI Chart: ${tracker.lastChartVerdict}`,
          color: 'cyan',
        });
      }

      if (tracker.lastBundlePct > 0 || tracker.lastClusterPct > 0) {
        think.lines.push({
          icon: '🔬',
          text: `  └ InsightX: bundle=${tracker.lastBundlePct.toFixed(1)}% cluster=${tracker.lastClusterPct.toFixed(1)}%`,
          color: tracker.lastBundlePct > 15 || tracker.lastClusterPct > 40 ? 'red' : undefined,
        });
      }

      if (tracker.exitSignals.length > 0) {
        think.lines.push({
          icon: '⚠️',
          text: `  └ EXIT SIGNALS: ${tracker.exitSignals.join(', ')}`,
          color: 'red',
        });
      }
    }


    const dedupedSells = new Map<string, typeof sellQueue[0]>();
    for (const sell of sellQueue) {
      const existing = dedupedSells.get(sell.mint);
      if (!existing || sell.percent > existing.percent || sell.urgency === 'high') {
        dedupedSells.set(sell.mint, sell);
      }
    }

    for (const sell of dedupedSells.values()) {
      try {
        this.stats.recentDecisions.push({ ts: now, action: 'SELL', mint: sell.mint, reason: sell.reason });
        if (this.stats.recentDecisions.length > 50) this.stats.recentDecisions.shift();

        const tracker = this.openPositions.get(sell.mint);
        const symbol = tracker?.position.symbol || sell.mint.slice(0, 8);

        think.lines.push({
          icon: '🔴',
          text: `${this.paperMode ? '📝 ' : ''}SELLING $${symbol} ${sell.percent}% — ${sell.reason}`,
          color: 'red',
        });

        if (this.paperMode) {

          if (tracker) {
            const pos = tracker.position;
            const sellFraction = sell.percent / 100;
            const returnSol = pos.amountSolInvested * sellFraction * (1 + pos.unrealizedPnlPercent / 100);
            const pnlSol = returnSol - (pos.amountSolInvested * sellFraction);
            this.paperPnlAccum += returnSol;
            this.paperTrades.push({
              mint: sell.mint, symbol, action: 'sell',
              amountSol: returnSol, price: pos.currentPrice, mcap: tracker.lastMcap,
              timestamp: now, reason: sell.reason,
              pnlPercent: pos.unrealizedPnlPercent, pnlSol,
            });
            this.paperStats.totalTrades++;
            if (pnlSol >= 0) { this.paperStats.wins++; } else { this.paperStats.losses++; }
            this.paperStats.totalPnl += pnlSol;
            if (pnlSol > this.paperStats.bestTrade) this.paperStats.bestTrade = pnlSol;
            if (pnlSol < this.paperStats.worstTrade) this.paperStats.worstTrade = pnlSol;
            this.addLearningEntry(pnlSol >= 0 ? 'pattern' : 'mistake',
              `${pnlSol >= 0 ? 'WIN' : 'LOSS'} $${symbol}: ${pos.unrealizedPnlPercent.toFixed(1)}% | ${sell.reason}`,
              `exit_type=${sell.urgency} mcap=${tracker.lastMcap}`);
            this.logger.info(`[Sniper/Paper] 📝 PAPER SELL ${symbol} ${sell.percent}% | P&L: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} vSOL`);


            if (sell.percent >= 100) {
              this.recordTradeOutcome(
                sell.mint, symbol, undefined,
                pnlSol, pos.unrealizedPnlPercent, now - pos.openedAt,
                this.candidates.get(sell.mint), tracker,
              );
            }


            if (sell.percent < 100) {
              pos.amountSolInvested *= (1 - sellFraction);
              pos.amountTokens *= (1 - sellFraction);
            }


            if (this.paperMinWinsForLive > 0 && this.paperStats.wins >= this.paperMinWinsForLive && this.paperStats.totalPnl > 0) {
              this.addLearningEntry('insight',
                `Reached threshold of ${this.paperMinWinsForLive} wins (${this.paperStats.wins}W/${this.paperStats.losses}L, P&L: +${this.paperStats.totalPnl.toFixed(4)}). Ready for LIVE.`,
                `Recommendation: switch to live trading via /api/sniper/paper?mode=live`);
              this.logger.info(`[Sniper/Paper] 🎓 READY FOR LIVE! ${this.paperStats.wins}W/${this.paperStats.losses}L | total P&L: +${this.paperStats.totalPnl.toFixed(4)} vSOL`);
            }
          }
          if (sell.percent >= 100) this.closePosition(sell.mint, sell.reason);
          this.savePaperState();
        } else {

          this.logger.trade(`[Sniper] EXIT: ${symbol} sell ${sell.percent}% — ${sell.reason}`);

          await this.tradeFn!('fast_sell', {
            mint: sell.mint,
            percent: sell.percent,
            slippage_bps: Math.min(this.strategy.slippageBps * 1.5, 5000),
            use_jito: true,
          });

          if (sell.percent >= 100) {
            this.closePosition(sell.mint, sell.reason);
          }
        }
      } catch (err: any) {
        this.stats.errors++;
        this.logger.error(`[Sniper] Sell failed for ${sell.mint.slice(0, 8)}: ${err?.message}`);
      }
    }
  }

private closePosition(mint: string, reason: string): void {
    const tracker = this.openPositions.get(mint);
    if (!tracker) return;


    this.stats.sells++;
    if (!tracker) return;

    const pos = tracker.position;
    const duration = Date.now() - pos.openedAt;
    const pnl = pos.unrealizedPnl;
    const pnlPercent = pos.unrealizedPnlPercent;

    this.eventBus.emit('position:closed', { mint, pnl, pnlPercent, duration });
    this.openPositions.delete(mint);

    this.logger.info(`[Sniper] Position closed: ${pos.symbol} | P&L: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL) | hold=${(duration / 60_000).toFixed(1)}min | reason=${reason}`);


    if (pnlPercent < 0) {
      this.stats.consecutiveLosses++;
      if (!this.paperMode && this.stats.consecutiveLosses >= this.COOLDOWN_LOSSES) {
        const extraMin = Math.min(3, this.stats.consecutiveLosses - this.COOLDOWN_LOSSES);
        const cooldownMs = this.COOLDOWN_BASE_MS + extraMin * 60_000;
        this.stats.cooldownUntil = Date.now() + cooldownMs;
        this.logger.warn(`[Sniper] Cooldown after ${this.stats.consecutiveLosses} losses → ${cooldownMs / 60000}min pause`);
      }
    } else {
      this.stats.consecutiveLosses = 0;
    }
  }

private async checkBundleCluster(mint: string): Promise<{ safe: boolean; reason: string; top10Holders?: string }> {
    if (!this.tradeFn) return { safe: true, reason: 'no tradeFn' };

    try {


      const [bundlerRes, clusterRes] = await Promise.all([
        Promise.race([
          this.tradeFn('insightx_bundlers', { mint }),
          new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
        ]).catch(() => null),
        Promise.race([
          this.tradeFn('insightx_clusters', { mint }),
          new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]).catch(() => null),
      ]);


      const hasBundlerData = bundlerRes && !bundlerRes.note;
      const bundlerPct = hasBundlerData ? (bundlerRes.total_bundlers_pct ?? 0) : -1;
      const clusterPct = clusterRes?.total_cluster_pct ?? 0;


      let top10Holders = bundlerRes?.top10Holders?.length
        ? bundlerRes.top10Holders.map((h: any) => `${h.address}(${h.pct}%)`).join(' ')
        : undefined;


      if (!top10Holders && this.tradeFn) {
        try {
          const holdersRes = await Promise.race([
            this.tradeFn('insightx_top_holders', { mint }),
            new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]).catch(() => null);
          if (holdersRes?.holders?.length) {
            top10Holders = holdersRes.holders
              .slice(0, 10)
              .map((h: any) => `${(h.address || '?').slice(0, 4)}..${(h.address || '?').slice(-4)}(${(h.pct ?? 0).toFixed(2)}%)`)
              .join(' ');
          }
        } catch {}
      }

      if (hasBundlerData && bundlerPct > 10) {
        return { safe: false, reason: `bundled ${bundlerPct.toFixed(1)}% (>${10}%)`, top10Holders };
      }
      if (clusterPct > 30) {
        return { safe: false, reason: `cluster ${clusterPct.toFixed(1)}% (>${30}%)`, top10Holders };
      }


      if (bundlerRes?.summary) {
        return { safe: true, reason: bundlerRes.summary, top10Holders };
      }

      const bundleStr = hasBundlerData ? `bundle=${bundlerPct.toFixed(1)}%` : 'bundle=⏳new';
      return { safe: true, reason: `${bundleStr} cluster=${clusterPct.toFixed(1)}%`, top10Holders };
    } catch (err: any) {
      this.logger.debug(`[Sniper] InsightX check failed: ${err?.message}`);

      return { safe: true, reason: 'insightx check failed, allowing' };
    }
  }


private async fetchCandles(mint: string, interval: string = '1m', limit: number = 30): Promise<any[] | null> {
    if (!this.tradeFn) return null;
    try {
      const result = await Promise.race([
        this.tradeFn('get_token_candles', { mint, interval, limit }),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
      if (result?.error) {
        this.logger.debug(`[Sniper/Chart] fetchCandles API error for ${mint.slice(0, 8)}: ${result.error}`);
        return null;
      }
      if (result?.candles && Array.isArray(result.candles) && result.candles.length > 0) {
        this.logger.debug(`[Sniper/Chart] Got ${result.candles.length} candles for ${mint.slice(0, 8)}`);
        return result.candles;
      }
      this.logger.debug(`[Sniper/Chart] Empty candles for ${mint.slice(0, 8)} (token too new?)`);
      return null;
    } catch (err: any) {
      this.logger.debug(`[Sniper/Chart] fetchCandles exception for ${mint.slice(0, 8)}: ${err?.message}`);
      return null;
    }
  }

private summarizeCandles(candles: any[]): string {
    if (!candles || candles.length === 0) return 'no chart data';

    const first = candles[0];
    const last = candles[candles.length - 1];
    const open = first.open ?? first.o ?? 0;
    const close = last.close ?? last.c ?? 0;
    const changePct = open > 0 ? ((close - open) / open) * 100 : 0;


    let high = 0, low = Infinity;
    let totalVol = 0;
    const volumes: number[] = [];
    const prices: number[] = [];

    for (const c of candles) {
      const h = c.high ?? c.h ?? 0;
      const l = c.low ?? c.l ?? (c.close ?? c.c ?? 0);
      const v = c.volume ?? c.v ?? 0;
      const cl = c.close ?? c.c ?? 0;
      if (h > high) high = h;
      if (l < low && l > 0) low = l;
      totalVol += v;
      volumes.push(v);
      prices.push(cl);
    }


    const half = Math.floor(volumes.length / 2);
    const vol1 = volumes.slice(0, half).reduce((a, b) => a + b, 0) / (half || 1);
    const vol2 = volumes.slice(half).reduce((a, b) => a + b, 0) / (volumes.length - half || 1);
    const volTrend = vol2 > vol1 * 1.3 ? 'rising' : vol2 < vol1 * 0.7 ? 'falling' : 'stable';


    const recent = prices.slice(-5);
    let ups = 0, downs = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) ups++;
      else if (recent[i] < recent[i - 1]) downs++;
    }
    const momentum = ups > downs + 1 ? 'bullish' : downs > ups + 1 ? 'bearish' : 'mixed';


    let bigWicks = 0;
    for (const c of candles) {
      const o = c.open ?? c.o ?? 0;
      const cl = c.close ?? c.c ?? 0;
      const h = c.high ?? c.h ?? 0;
      const l = c.low ?? c.l ?? cl;
      const body = Math.abs(cl - o);
      const totalRange = h - l;
      if (totalRange > 0 && body / totalRange < 0.3) bigWicks++;
    }
    const wickStr = bigWicks > candles.length * 0.4 ? 'high (manipulation risk)' : bigWicks > candles.length * 0.2 ? 'moderate' : 'normal';


    let peak = 0;
    let maxDrawdown = 0;
    for (const p of prices) {
      if (p > peak) peak = p;
      const dd = peak > 0 ? ((peak - p) / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    return `${candles.length} candles (${candles.length > 0 ? '1m' : '?'}): ` +
      `open=${this.fmtPrice(open)} close=${this.fmtPrice(close)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%) | ` +
      `high=${this.fmtPrice(high)} low=${this.fmtPrice(low)} | ` +
      `vol trend: ${volTrend} | momentum: ${momentum} | wicks: ${wickStr} | ` +
      `max drawdown from ATH: ${maxDrawdown.toFixed(0)}%`;
  }

  private fmtPrice(p: number): string {
    if (p === 0) return '0';
    if (p < 0.00001) return p.toExponential(2);
    if (p < 0.01) return p.toFixed(6);
    if (p < 1) return p.toFixed(4);
    return p.toFixed(2);
  }

private async preBuyChartCheck(
    mint: string,
    symbol: string,
    score: number,
    mcap: number,
    narrativeBonus?: number,
    description?: string,
  ): Promise<{ buy: boolean; stopLoss: number; tpLevels: Array<{ at: number; sellPercent: number }>; reason: string }> {
    const defaultTp = [...this.strategy.takeProfitLevels];
    if (!this.llmFn) return { buy: true, stopLoss: this.strategy.stopLossPercent, tpLevels: defaultTp, reason: 'no LLM — default' };

    const candles = await this.fetchCandles(mint, '1m', 30);
    if (!candles) return { buy: true, stopLoss: this.strategy.stopLossPercent, tpLevels: defaultTp, reason: 'token too new — no candles, buying on score' };

    const chartSummary = this.summarizeCandles(candles);


    const trendSnap = this.trendContext.getSnapshot();
    const hotNarratives = trendSnap.hotNarratives.slice(0, 8).join(', ') || 'none detected';
    const sentiment = trendSnap.sentiment?.trend || 'neutral';

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a pump.fun trade strategist. Evaluate a NEW token and set optimal SL + TP levels.

Respond ONLY with JSON (no markdown):
{
  "buy": true/false,
  "stop_loss": 15-60,
  "tp_levels": [
    { "at": 1.4, "sell_percent": 50 },
    { "at": 1.8, "sell_percent": 30 },
    { "at": 2.5, "sell_percent": 100 }
  ],
  "narrative_strength": "strong" | "medium" | "weak" | "none",
  "reason": "brief explanation"
}

RULES FOR SL/TP:
- TP MUST be proportional to SL. First TP >= 2× SL distance.
- STRONG narrative (trending topic, viral meme, celebrity): SL=25-35%, TP targets 2x-5x-10x (let it run!)
- MEDIUM narrative (known theme, some hype): SL=20-25%, TP targets 1.5x-2.5x-4x
- WEAK narrative (generic, no clear trend): SL=15-20%, TP targets 1.3x-1.8x-2.5x (quick flip)
- NO narrative (random token): SL=15%, TP targets 1.2x-1.5x (scalp only)
- RISKY chart (volatile, wicks, dump signs): tighter SL + faster TP exits
- HEALTHY chart (organic growth, rising volume): wider SL + higher TP targets
- sell_percent across all levels MUST sum to 100%
- 2-4 TP levels total. More levels for stronger narratives.
- Never set SL below 15% (pump.fun noise floor)
- Consider market sentiment: ${sentiment}

Current hot narratives: ${hotNarratives}${this.userInstructions.length > 0 ? '\n\nUSER INSTRUCTIONS:\n' + this.userInstructions.join('\n') : ''}`,
      },
      {
        role: 'user',
        content: `Token: $${symbol}${description ? ' — ' + description.slice(0, 100) : ''} | mcap: ${mcap > 0 ? (mcap / 1000).toFixed(1) + 'k' : '?'} | sniper score: ${score} | narrative bonus: ${narrativeBonus || 0}\nChart: ${chartSummary}`,
      },
    ];

    try {
      const resp = await Promise.race([
        this.llmFn(messages, []),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      const text = resp?.content || '';
      return this.parseChartVerdict(text, this.strategy.stopLossPercent);
    } catch (err: any) {
      this.logger.debug(`[Sniper/Chart] Pre-buy LLM error: ${err?.message}`);
      return { buy: true, stopLoss: this.strategy.stopLossPercent, tpLevels: defaultTp, reason: 'LLM error — default' };
    }
  }

private async postBuyChartAnalysis(
    tracker: SniperPositionTracker,
  ): Promise<{ sellNow: boolean; sellPercent: number; newStopLoss: number; newTpLevels: Array<{ at: number; sellPercent: number }>; reason: string }> {
    if (!this.llmFn) return { sellNow: false, sellPercent: 0, newStopLoss: tracker.dynamicStopLoss, newTpLevels: tracker.dynamicTpLevels, reason: 'no LLM' };

    const pos = tracker.position;
    const holdMinutes = (Date.now() - pos.openedAt) / 60_000;
    const candles = await this.fetchCandles(pos.mint, '1m', 30);
    if (!candles) {
      if (holdMinutes < 3) {
        return { sellNow: false, sellPercent: 0, newStopLoss: tracker.dynamicStopLoss, newTpLevels: tracker.dynamicTpLevels, reason: '⏳chart pending (<3min)' };
      }
      this.logger.warn(`[Sniper/Chart] Post-buy: no candle data for ${pos.symbol} after ${holdMinutes.toFixed(1)}min hold — API issue?`);
      return { sellNow: false, sellPercent: 0, newStopLoss: tracker.dynamicStopLoss, newTpLevels: tracker.dynamicTpLevels, reason: 'no chart data' };
    }

    const chartSummary = this.summarizeCandles(candles);
    const holdMin = ((Date.now() - pos.openedAt) / 60_000).toFixed(1);
    const pnl = pos.unrealizedPnlPercent.toFixed(1);
    const mcapX = pos.entryPrice > 0 ? (pos.currentPrice / pos.entryPrice).toFixed(2) : '?';
    const holderDrop = tracker.peakHolders > 0
      ? ((tracker.peakHolders - tracker.lastHolders) / tracker.peakHolders * 100).toFixed(0)
      : '0';

    const currentTpStr = tracker.dynamicTpLevels.map(l => `${l.at}x→${l.sellPercent}%`).join(', ');

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a pump.fun position manager. Analyze the chart of a HELD token and decide:
1. Should we SELL NOW (before stop-loss triggers)?
2. Adjust stop-loss and take-profit levels for current market conditions.

Respond ONLY with JSON (no markdown):
{
  "sell_now": true/false,
  "sell_percent": 0-100,
  "new_stop_loss": 15-60,
  "tp_levels": [
    { "at": 1.4, "sell_percent": 50 },
    { "at": 2.0, "sell_percent": 100 }
  ],
  "reason": "brief explanation"
}

RULES:
- sell_now=true if: clear dump, volume dying + price dropping, dev selling, sharp reversal
- sell_now=false if: healthy consolidation, rising volume, organic dips
- sell_percent: 100% for danger, 50-80% for risk reduction
- new_stop_loss: 15-60%, never below 15% (pump.fun noise)
- tp_levels: re-evaluate based on current momentum. If pumping hard → raise targets. If stalling → lower targets to secure profit.
- TP first level must be >= 2× SL distance from entry (positive EV)
- sell_percent across all TP levels must sum to 100%
- If token is in strong uptrend with volume → widen SL + raise TP targets
- If momentum fading → tighten everything for quick exit${this.userInstructions.length > 0 ? '\n\nUSER INSTRUCTIONS:\n' + this.userInstructions.join('\n') : ''}`,
      },
      {
        role: 'user',
        content: `POSITION: $${pos.symbol} | P&L: ${pnl}% | mcap: ${mcapX}x | hold: ${holdMin}min | holders: ${tracker.lastHolders} (peak ${tracker.peakHolders}, drop ${holderDrop}%) | current SL: ${tracker.dynamicStopLoss}% | current TP: ${currentTpStr} | partials sold: ${tracker.partialsSold} | bond: ${tracker.bondingProgress.toFixed(0)}%${tracker.graduated ? ' (graduated)' : ''}\nChart: ${chartSummary}${tracker.exitSignals.length > 0 ? '\nActive signals: ' + tracker.exitSignals.join(', ') : ''}`,
      },
    ];

    try {
      const resp = await Promise.race([
        this.llmFn(messages, []),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
      const text = resp?.content || '';
      return this.parsePositionVerdict(text, tracker.dynamicStopLoss, tracker.dynamicTpLevels);
    } catch (err: any) {
      this.logger.debug(`[Sniper/Chart] Post-buy LLM error: ${err?.message}`);
      return { sellNow: false, sellPercent: 0, newStopLoss: tracker.dynamicStopLoss, newTpLevels: tracker.dynamicTpLevels, reason: 'LLM error' };
    }
  }

  private parseChartVerdict(text: string, defaultSL: number): { buy: boolean; stopLoss: number; tpLevels: Array<{ at: number; sellPercent: number }>; reason: string } {
    const defaultTp = [...this.strategy.takeProfitLevels];
    try {
      let json = text.trim();
      const block = json.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (block) json = block[1];
      if (!json.startsWith('{')) {
        const m = json.match(/\{[\s\S]*\}/);
        if (m) json = m[0];
      }
      const parsed = JSON.parse(json);
      const sl = Math.min(60, Math.max(15, Number(parsed.stop_loss) || defaultSL));


      let tpLevels = defaultTp;
      if (Array.isArray(parsed.tp_levels) && parsed.tp_levels.length >= 2) {
        const aiTp = parsed.tp_levels
          .filter((l: any) => l && typeof l.at === 'number' && typeof l.sell_percent === 'number')
          .map((l: any) => ({
            at: Math.max(1.1, Math.min(20, l.at)),
            sellPercent: Math.max(5, Math.min(100, Math.round(l.sell_percent))),
          }))
          .sort((a: any, b: any) => a.at - b.at);

        if (aiTp.length >= 2) {

          const minFirstTp = 1 + (sl / 100) * 2;
          if (aiTp[0].at < minFirstTp) aiTp[0].at = +minFirstTp.toFixed(2);

          aiTp[aiTp.length - 1].sellPercent = 100;
          tpLevels = aiTp;
        }
      }

      return {
        buy: parsed.buy !== false,
        stopLoss: sl,
        tpLevels,
        reason: String(parsed.reason || '').slice(0, 200),
      };
    } catch {
      return { buy: true, stopLoss: defaultSL, tpLevels: defaultTp, reason: 'parse error — default' };
    }
  }

  private parsePositionVerdict(text: string, currentSL: number, currentTp: Array<{ at: number; sellPercent: number }>): { sellNow: boolean; sellPercent: number; newStopLoss: number; newTpLevels: Array<{ at: number; sellPercent: number }>; reason: string } {
    try {
      let json = text.trim();
      const block = json.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (block) json = block[1];
      if (!json.startsWith('{')) {
        const m = json.match(/\{[\s\S]*\}/);
        if (m) json = m[0];
      }
      const parsed = JSON.parse(json);
      const newSL = Math.min(60, Math.max(15, Number(parsed.new_stop_loss) || currentSL));


      let newTp = currentTp;
      if (Array.isArray(parsed.tp_levels) && parsed.tp_levels.length >= 2) {
        const aiTp = parsed.tp_levels
          .filter((l: any) => l && typeof l.at === 'number' && typeof l.sell_percent === 'number')
          .map((l: any) => ({
            at: Math.max(1.1, Math.min(20, l.at)),
            sellPercent: Math.max(5, Math.min(100, Math.round(l.sell_percent))),
          }))
          .sort((a: any, b: any) => a.at - b.at);

        if (aiTp.length >= 2) {
          const minFirstTp = 1 + (newSL / 100) * 2;
          if (aiTp[0].at < minFirstTp) aiTp[0].at = +minFirstTp.toFixed(2);
          aiTp[aiTp.length - 1].sellPercent = 100;
          newTp = aiTp;
        }
      }

      return {
        sellNow: parsed.sell_now === true,
        sellPercent: Math.min(100, Math.max(0, Number(parsed.sell_percent) || 100)),
        newStopLoss: newSL,
        newTpLevels: newTp,
        reason: String(parsed.reason || '').slice(0, 200),
      };
    } catch {
      return { sellNow: false, sellPercent: 0, newStopLoss: currentSL, newTpLevels: currentTp, reason: 'parse error' };
    }
  }

private broadcastThinking(think: SniperThinking): void {
    this.eventBus.emit('sniper:cycle' as any, {
      timestamp: Date.now(),
      decision: { action: 'wait' },
      candidatesEvaluated: 0,
      walletBalance: 0,
      openPositions: 0,
      cycleDurationMs: 0,
      usedLLM: false,
      thinking: think,
    });
  }


setPaperMode(enabled: boolean): void {
    if (this.paperMode === enabled) return;
    this.paperMode = enabled;
    if (enabled) {
      this.restorePaperState();
      this.logger.info(`[Sniper/Paper] 📝 PAPER MODE ON — virtual trades, real data`);
      this.addLearningEntry('insight', 'Paper trading mode ON — all trades virtual, data and amounts real');
    } else {
      this.logger.info(`[Sniper/Paper] 🔴 LIVE MODE — real trades!`);
      this.addLearningEntry('insight', `Switching to LIVE | Paper result: ${this.paperStats.wins}W/${this.paperStats.losses}L | P&L: ${this.paperStats.totalPnl >= 0 ? '+' : ''}${this.paperStats.totalPnl.toFixed(4)} vSOL`);

      for (const [mint] of this.openPositions) {
        this.closePosition(mint, 'switch to live');
      }
    }
  }

private getPaperBalance(): number {
    if (this.paperBalanceOverride !== null) return this.paperBalanceOverride + this.paperPnlAccum;
    return this.lastRealBalance + this.paperPnlAccum;
  }

setPaperBalance(balance: number): void {
    this.paperBalanceOverride = Math.max(0, balance);
    this.paperPnlAccum = 0;
    this.logger.info(`[Sniper/Paper] Balance set to ${balance.toFixed(4)} SOL`);
  }

adjustPaperBalance(delta: number): number {
    if (this.paperBalanceOverride !== null) {
      this.paperBalanceOverride = Math.max(0, this.paperBalanceOverride + delta);
    } else {

      this.paperBalanceOverride = Math.max(0, this.lastRealBalance + this.paperPnlAccum + delta);
      this.paperPnlAccum = 0;
    }
    const newBal = this.getPaperBalance();
    this.logger.info(`[Sniper/Paper] Balance adjusted by ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} → ${newBal.toFixed(4)} SOL`);
    return newBal;
  }

syncPaperWithReal(): void {
    this.paperBalanceOverride = null;
    this.paperPnlAccum = 0;
    this.logger.info(`[Sniper/Paper] Balance synced to real wallet (${this.lastRealBalance.toFixed(4)} SOL)`);
  }

getPaperStatus(): {
    enabled: boolean;
    balance: number;
    realBalance: number;
    balanceOverride: number | null;
    paperPnl: number;
    stats: any;
    recentTrades: any;
    readyForLive: boolean;
  } {
    return {
      enabled: this.paperMode,
      balance: this.getPaperBalance(),
      realBalance: this.lastRealBalance,
      balanceOverride: this.paperBalanceOverride,
      paperPnl: this.paperPnlAccum,
      stats: { ...this.paperStats },
      recentTrades: this.paperTrades.slice(-20),
      readyForLive: this.paperStats.wins >= this.paperMinWinsForLive && this.paperStats.totalPnl > 0,
    };
  }

getAllPaperTrades(): typeof this.paperTrades {
    return [...this.paperTrades];
  }

resetPaper(): void {
    this.paperStats = { totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, bestTrade: 0, worstTrade: 0 };
    this.paperTrades = [];
    this.paperPnlAccum = 0;
    this.tradedMints.clear();
    for (const [mint] of this.openPositions) {
      this.closePosition(mint, 'paper reset');
    }
    this.logger.info(`[Sniper/Paper] Stats reset | balance: ${this.getPaperBalance().toFixed(4)} SOL`);
  }

setPaperMinWins(wins: number): void {
    this.paperMinWinsForLive = Math.max(1, wins);
  }


async chatWithAI(userMessage: string): Promise<string> {
    if (!this.llmFn) return 'LLM not connected — cannot respond';

    this.chatHistory.push({ role: 'user', text: userMessage, ts: Date.now() });
    if (this.chatHistory.length > 50) this.chatHistory.shift();


    const isInstruction = /^!|remember|always|never|rule|instruction/i.test(userMessage);
    if (isInstruction) {
      const cleanInstruction = userMessage.replace(/^!\s*/, '').trim();
      this.userInstructions.push(cleanInstruction);
      this.addLearningEntry('user_instruction', cleanInstruction);

      if (this.userInstructions.length > 20) this.userInstructions.shift();
    }


    const positionsSummary = [...this.openPositions.values()].map(t => {
      const p = t.position;
      return `$${p.symbol}: P&L=${p.unrealizedPnlPercent.toFixed(1)}% | mcap=${t.lastMcap} | hold=${((Date.now() - p.openedAt) / 60000).toFixed(1)}min | SL=${t.dynamicStopLoss}%`;
    }).join('\n') || 'No open positions';

    const recentTradesSummary = this.stats.recentDecisions.slice(-10).map(d =>
      `${new Date(d.ts).toLocaleTimeString()} ${d.action} ${d.mint?.slice(0, 8) || ''} ${d.reason || ''}`
    ).join('\n') || 'No trades';

    const journalSummary = this.learningJournal.slice(-10).map(e =>
      `[${e.type}] ${e.text}`
    ).join('\n') || 'Log empty';

    const chatContext = this.chatHistory.slice(-10).map(m =>
      `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`
    ).join('\n');

    const instructionsBlock = this.userInstructions.length > 0
      ? `\n\nACTIVE USER INSTRUCTIONS (MUST follow):\n${this.userInstructions.map((ins, i) => `${i + 1}. ${ins}`).join('\n')}`
      : '';

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are WhiteOwl 🦉 — autonomous Solana degen sniper AI. You trade pump.fun tokens.
You are chatting with your operator (the user). Be concise, direct, and honest. Speak Russian unless user uses English.

CURRENT STATE:
- Mode: ${this.paperMode ? 'PAPER TRADING (demo)' : 'LIVE'}
- Running: ${this.running}
- Balance: ${this.paperMode ? this.getPaperBalance().toFixed(3) + ' SOL (paper)' : 'real wallet'}
- Cycles: ${this.stats.cycles} | Buys: ${this.stats.buys} | Sells: ${this.stats.sells} | Errors: ${this.stats.errors}
- Win Rate: ${(this.getWinRate() * 100).toFixed(0)}% | Consecutive Losses: ${this.stats.consecutiveLosses}
- Strategy: buy=${this.strategy.buyAmountSol.toFixed(4)} SOL | SL=${this.strategy.stopLossPercent}% | minScore=${this.strategy.minScore}

POSITIONS:
${positionsSummary}

RECENT TRADES:
${recentTradesSummary}

LEARNING JOURNAL:
${journalSummary}${instructionsBlock}

If the user gives you an instruction/rule to follow, acknowledge it and explain how you'll apply it.
If the user asks about a specific token, share what you know from recent cycles.
If the user asks you to change strategy, explain the change and confirm.
Keep answers under 300 words.`,
      },
      { role: 'user', content: chatContext ? `Previous conversation:\n${chatContext}\n\nNew message: ${userMessage}` : userMessage },
    ];

    try {
      this.stats.llmCalls++;
      const resp = await Promise.race([
        this.llmFn(messages, []),
        new Promise<any>((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
      ]);
      const aiText = resp?.content || 'Failed to get response';
      this.chatHistory.push({ role: 'assistant', text: aiText, ts: Date.now() });
      if (this.chatHistory.length > 50) this.chatHistory.shift();
      return aiText;
    } catch (err: any) {
      const errText = `LLM error: ${err?.message}`;
      this.chatHistory.push({ role: 'assistant', text: errText, ts: Date.now() });
      return errText;
    }
  }

getChatHistory(): typeof this.chatHistory {
    return [...this.chatHistory];
  }

getUserInstructions(): string[] {
    return [...this.userInstructions];
  }

addInstruction(instruction: string): void {
    this.userInstructions.push(instruction);
    this.addLearningEntry('user_instruction', instruction);
    if (this.userInstructions.length > 20) this.userInstructions.shift();
  }

removeInstruction(index: number): boolean {
    if (index >= 0 && index < this.userInstructions.length) {
      const removed = this.userInstructions.splice(index, 1);
      this.addLearningEntry('user_instruction', `REMOVED: ${removed[0]}`);
      return true;
    }
    return false;
  }


  private addLearningEntry(type: 'insight' | 'mistake' | 'pattern' | 'user_instruction', text: string, context?: string): void {
    this.learningJournal.push({ ts: Date.now(), type, text, context });
    if (this.learningJournal.length > 200) this.learningJournal.shift();
  }

addLearningEntryPublic(type: string, text: string, context?: string): void {
    const validType = (['insight', 'mistake', 'pattern', 'user_instruction'].includes(type) ? type : 'insight') as any;
    this.addLearningEntry(validType, text, context);
  }

getLearningJournal(): typeof this.learningJournal {
    return [...this.learningJournal];
  }

clearLearningJournal(): void {
    this.learningJournal = [];
  }

getLearningStats(): { total: number; insights: number; mistakes: number; patterns: number; instructions: number } {
    return {
      total: this.learningJournal.length,
      insights: this.learningJournal.filter(e => e.type === 'insight').length,
      mistakes: this.learningJournal.filter(e => e.type === 'mistake').length,
      patterns: this.learningJournal.filter(e => e.type === 'pattern').length,
      instructions: this.learningJournal.filter(e => e.type === 'user_instruction').length,
    };
  }


private storeEntryAnalysis(mint: string, candidate: SniperCandidate): void {
    if (!this.memory) return;
    try {
      const signals: string[] = [];
      if (candidate.hasSocials) signals.push('socials');
      if (candidate.bondingProgress > 0) signals.push(`bond_${Math.round(candidate.bondingProgress)}pct`);
      if (candidate.holders > 10) signals.push('holders_10plus');
      if (candidate.holders > 30) signals.push('holders_30plus');
      if (candidate.narrativeBonus > 0) signals.push('narrative_match');
      if (candidate.mcap > 5000) signals.push('mcap_5k_plus');
      if (candidate.mcap > 10000) signals.push('mcap_10k_plus');
      if ((candidate as any).dev) signals.push('dev_known');

      this.memory.storeAnalysis({
        mint,
        score: candidate.score,
        rugScore: 0,
        signals,
        recommendation: candidate.score >= 70 ? 'strong_buy' : 'buy',
        reasoning: `sniper score=${candidate.score} narr=${candidate.narrativeBonus}`,
        analyzedAt: Date.now(),
      });
    } catch (err: any) {
      this.logger.debug(`[Sniper] storeEntryAnalysis failed: ${err.message}`);
    }
  }

private recordTradeOutcome(
    mint: string, symbol: string, dev: string | undefined,
    pnlSol: number, pnlPercent: number, holdDurationMs: number,
    candidate: SniperCandidate | undefined,
    tracker: SniperPositionTracker,
  ): void {
    const isWin = pnlSol >= 0;
    const holdMin = holdDurationMs / 60_000;


    if (this.contextMemory && dev) {
      try {
        const isRug = pnlPercent < -80 || (holdMin < 3 && pnlPercent < -30);
        this.contextMemory.recordDevLaunch(dev, {
          isRug,
          lifetimeMin: holdMin,
          peakMcap: tracker.peakMcap,
        });
      } catch {  }
    }


    if (this.contextMemory) {
      try {
        this.contextMemory.recordHourlyOutcome(pnlSol, isWin);
      } catch {  }
    }


    if (this.contextMemory && symbol) {
      try {

        this.contextMemory.recordPattern(symbol.toLowerCase(), 'name', pnlPercent, isWin);

        const name = candidate?.name || symbol;
        for (const word of name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2)) {
          this.contextMemory.recordPattern(word, 'name_word', pnlPercent, isWin);
        }
      } catch {  }
    }


    if (this.contextMemory && candidate?.narrativeBonus && candidate.narrativeBonus > 0) {
      try {
        const narratives = this.trendContext.getActiveNarratives?.() || [];
        for (const narrative of narratives) {
          const nameL = (candidate.name || symbol).toLowerCase();
          if (narrative.keywords?.some((k: string) => nameL.includes(k.toLowerCase()))) {
            this.contextMemory.recordNarrativeOutcome(
              narrative.title || narrative.keywords?.join(','),
              narrative.keywords || [],
              1, isWin ? 1 : 0, isWin ? 0 : 1, pnlSol,
            );
            break;
          }
        }
      } catch {  }
    }


    if (this.memory) {
      try {
        const analysis = this.memory.getAnalysis(mint);
        if (analysis) {
          const outcome = pnlPercent > 5 ? 'win' as const
            : pnlPercent < -5 ? 'loss' as const
            : 'breakeven' as const;
          this.memory.recordLearningOutcome({
            mint,
            signals: analysis.signals,
            outcome,
            pnlSol,
            pnlPercent,
            pipelineScore: analysis.score,
            holdDurationMin: Math.round(holdMin),
          });
        }
      } catch {  }
    }

    this.logger.debug(`[Sniper/Learn] ${isWin ? 'WIN' : 'LOSS'} $${symbol}: ${pnlPercent.toFixed(1)}% recorded to all memory tables`);
  }


  private get paperDataPath(): string {
    return path.join(PROJECT_ROOT, 'data', 'paper-trades.json');
  }

savePaperState(): void {
    try {
      const data = {
        trades: this.paperTrades,
        stats: this.paperStats,
        pnlAccum: this.paperPnlAccum,
        tradedMints: [...this.tradedMints],
        balanceOverride: this.paperBalanceOverride,
        journal: this.learningJournal.slice(-100),
        savedAt: Date.now(),
      };
      fs.writeFileSync(this.paperDataPath, JSON.stringify(data, null, 2));
      this.logger.debug(`[Sniper] Paper state saved: ${this.paperTrades.length} trades, ${this.paperStats.wins}W/${this.paperStats.losses}L`);
    } catch (err: any) {
      this.logger.debug(`[Sniper] Paper state save failed: ${err.message}`);
    }
  }

restorePaperState(): boolean {
    try {
      if (!fs.existsSync(this.paperDataPath)) return false;
      const raw = fs.readFileSync(this.paperDataPath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data?.trades || !data?.stats) return false;


      if (data.savedAt && Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
        this.logger.info('[Sniper] Paper state too old (>24h), starting fresh');
        return false;
      }

      this.paperTrades = data.trades || [];
      this.paperStats = { ...this.paperStats, ...data.stats };
      this.paperPnlAccum = data.pnlAccum || 0;
      if (data.tradedMints) data.tradedMints.forEach((m: string) => this.tradedMints.add(m));
      if (data.balanceOverride != null) this.paperBalanceOverride = data.balanceOverride;
      if (data.journal) this.learningJournal = data.journal;

      this.logger.info(`[Sniper] Paper state restored: ${this.paperTrades.length} trades, ${this.paperStats.wins}W/${this.paperStats.losses}L, P&L: ${this.paperStats.totalPnl >= 0 ? '+' : ''}${this.paperStats.totalPnl.toFixed(4)} vSOL`);
      return true;
    } catch (err: any) {
      this.logger.debug(`[Sniper] Paper state restore failed: ${err.message}`);
      return false;
    }
  }

  private loadStrategy(): SniperStrategy {
    const defaults: SniperStrategy = {
      buyAmountSol: 0.05,
      slippageBps: 2000,
      priorityFeeSol: 0.01,
      maxConcurrentPositions: 5,
      maxPortfolioPercent: 20,
      minBalanceSol: 0.1,
      stopLossPercent: 20,
      takeProfitLevels: [
        { at: 1.4, sellPercent: 50 },
        { at: 1.8, sellPercent: 30 },
        { at: 2.2, sellPercent: 100 },
      ],
      trailingStopPercent: 15,
      timeoutMinutes: 30,
      minScore: 50,
      narrativeBoost: 20,
      newsBoost: 15,
      blacklistPatterns: ['test', 'rug', 'scam', 'airdrop'],
    };

    try {
      const yamlPath = path.join(PROJECT_ROOT, 'strategies', 'degen-sniper.yaml');
      const content = fs.readFileSync(yamlPath, 'utf-8');
      const parsed = yaml.parse(content);

      if (parsed?.entry?.buy?.amount_sol) defaults.buyAmountSol = parsed.entry.buy.amount_sol;
      if (parsed?.entry?.buy?.slippage_bps) defaults.slippageBps = parsed.entry.buy.slippage_bps;
      if (parsed?.entry?.buy?.priority_fee_sol) defaults.priorityFeeSol = parsed.entry.buy.priority_fee_sol;
      if (parsed?.exit?.stop_loss_percent) defaults.stopLossPercent = parsed.exit.stop_loss_percent;
      if (parsed?.exit?.timeout_minutes) defaults.timeoutMinutes = parsed.exit.timeout_minutes;
      if (parsed?.filters?.min_score) defaults.minScore = parsed.filters.min_score;
      if (parsed?.filters?.blacklist_patterns) defaults.blacklistPatterns = parsed.filters.blacklist_patterns;

      if (Array.isArray(parsed?.exit?.take_profit)) {
        defaults.takeProfitLevels = parsed.exit.take_profit.map((tp: any) => ({
          at: tp.at,
          sellPercent: tp.sell_percent,
        }));
      }


      if (parsed?.portfolio?.max_concurrent_positions) defaults.maxConcurrentPositions = parsed.portfolio.max_concurrent_positions;
      if (parsed?.portfolio?.max_portfolio_percent) defaults.maxPortfolioPercent = parsed.portfolio.max_portfolio_percent;
      if (parsed?.portfolio?.min_balance_sol) defaults.minBalanceSol = parsed.portfolio.min_balance_sol;
      if (parsed?.scoring?.narrative_boost) defaults.narrativeBoost = parsed.scoring.narrative_boost;
      if (parsed?.scoring?.news_boost) defaults.newsBoost = parsed.scoring.news_boost;
    } catch (err: any) {
      this.logger.warn(`[Sniper] Failed to load strategy YAML: ${err?.message}, using defaults`);
    }

    return defaults;
  }

  private createEmptyStats(): SniperStats {
    return {
      running: false,
      startedAt: 0,
      cycles: 0,
      buys: 0,
      sells: 0,
      skips: 0,
      llmCalls: 0,
      errors: 0,
      consecutiveLosses: 0,
      cooldownUntil: 0,
      lastCycle: null,
      recentDecisions: [],
      recentThinking: [],
      riskProfile: null,
    };
  }
}
