import {
  EventBusInterface, MemoryInterface, LoggerInterface,
  TokenInfo, Position, SessionStats, TokenAnalysis, NewsItem,
} from '../types.ts';
import { NewsStore } from '../memory/news-store.ts';

interface RecentToken {
  mint: string;
  symbol: string;
  name: string;
  dev: string;
  hasSocials: boolean;
  bondingProgress: number;
  mcap: number;
  pipelineScore?: number;
  pipelineSignals?: string[];
  receivedAt: number;
}

interface PipelineSnapshot {
  enabled: boolean;
  tokensPerSec: number;
  totalReceived: number;
  passRate: string;
  stage0Kill: number;
  stage1Kill: number;
  stage2Kill: number;
  approved: number;
  tradesEmitted: number;
  workerUtilization: string;
  cacheHitRate: string;
}

export interface MarketState {
  timestamp: number;
  recentTokens: RecentToken[];
  pipelineStats: PipelineSnapshot | null;
  positions: Array<{
    mint: string;
    symbol: string;
    pnlPercent: number;
    pnlSol: number;
    holdMinutes: number;
    amountSolInvested: number;
  }>;
  sessionStats: SessionStats | null;
  recentTrades: Array<{
    action: string;
    mint: string;
    symbol: string;
    amountSol: number;
    success: boolean;
    timestamp: number;
  }>;
  recentSignals: Array<{
    type: string;
    mint: string;
    score?: number;
    reason: string;
    timestamp: number;
  }>;
  walletBalance: number;
  trendingPatterns: string[];
}

export class MarketStateBuilder {
  private eventBus: EventBusInterface;
  private memory: MemoryInterface;
  private logger: LoggerInterface;

  private recentTokens: RecentToken[] = [];
  private recentTrades: MarketState['recentTrades'] = [];
  private recentSignals: MarketState['recentSignals'] = [];
  private positions = new Map<string, Position>();
  private walletBalance = 0;
  private pipelineStats: PipelineSnapshot | null = null;
  private sessionStats: SessionStats | null = null;
  private trendingTickers: string[] = [];
  private newsStore: NewsStore | null = null;

  private readonly MAX_RECENT_TOKENS = 50;
  private readonly MAX_RECENT_TRADES = 20;
  private readonly MAX_RECENT_SIGNALS = 30;
  private readonly TOKEN_TTL_MS = 60_000;

  constructor(opts: {
    eventBus: EventBusInterface;
    memory: MemoryInterface;
    logger: LoggerInterface;
  }) {
    this.eventBus = opts.eventBus;
    this.memory = opts.memory;
    this.logger = opts.logger;
    this.bind();
  }

  setNewsStore(store: NewsStore): void {
    this.newsStore = store;
  }

  private bind(): void {

    this.eventBus.on('token:new', (data) => {
      const token = this.memory.getToken(data.mint);
      this.recentTokens.push({
        mint: data.mint,
        symbol: data.symbol || token?.symbol || '???',
        name: data.name || token?.name || 'Unknown',
        dev: data.dev,
        hasSocials: !!(token?.twitter || token?.telegram || token?.website),
        bondingProgress: token?.bondingCurveProgress ?? 0,
        mcap: token?.marketCap ?? 0,
        receivedAt: Date.now(),
      });

      if (this.recentTokens.length > this.MAX_RECENT_TOKENS) {
        this.recentTokens = this.recentTokens.slice(-this.MAX_RECENT_TOKENS);
      }
    });

    this.eventBus.on('trade:executed', (result) => {

      const intentHistory = this.eventBus.history('trade:intent', 20);
      const intent = intentHistory.find(e => e.data?.id === result.intentId);

      this.recentTrades.push({
        action: intent?.data?.action || 'unknown',
        mint: intent?.data?.mint || '',
        symbol: intent?.data?.symbol || '???',
        amountSol: result.amountSol || intent?.data?.amountSol || 0,
        success: result.success,
        timestamp: Date.now(),
      });

      if (this.recentTrades.length > this.MAX_RECENT_TRADES) {
        this.recentTrades = this.recentTrades.slice(-this.MAX_RECENT_TRADES);
      }
    });

    this.eventBus.on('signal:buy', (data) => {
      this.recentSignals.push({
        type: 'buy', mint: data.mint, score: data.score,
        reason: data.reason, timestamp: Date.now(),
      });
      this.trimSignals();
    });

    this.eventBus.on('signal:rug', (data) => {
      this.recentSignals.push({
        type: 'rug', mint: data.mint, score: data.confidence,
        reason: data.indicators.join(', '), timestamp: Date.now(),
      });
      this.trimSignals();
    });

    this.eventBus.on('position:opened', (pos) => this.positions.set(pos.mint, pos));
    this.eventBus.on('position:updated', (pos) => this.positions.set(pos.mint, pos));
    this.eventBus.on('position:closed', ({ mint }) => this.positions.delete(mint));
  }

  updateBalance(sol: number): void {
    this.walletBalance = sol;
  }

  updatePipelineStats(stats: PipelineSnapshot): void {
    this.pipelineStats = stats;
  }

  updateSessionStats(stats: SessionStats): void {
    this.sessionStats = stats;
  }

  getState(): MarketState {
    const now = Date.now();

    this.recentTokens = this.recentTokens.filter(t => now - t.receivedAt < this.TOKEN_TTL_MS);

    const posArray = Array.from(this.positions.values()).map(p => {
      const pnlPercent = p.entryPrice > 0
        ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
        : 0;
      return {
        mint: p.mint,
        symbol: p.symbol,
        pnlPercent,
        pnlSol: p.unrealizedPnl,
        holdMinutes: Math.round((now - p.openedAt) / 60_000),
        amountSolInvested: p.amountSolInvested,
      };
    });

    return {
      timestamp: now,
      recentTokens: this.recentTokens,
      pipelineStats: this.pipelineStats,
      positions: posArray,
      sessionStats: this.sessionStats,
      recentTrades: this.recentTrades.slice(-10),
      recentSignals: this.recentSignals.slice(-10),
      walletBalance: this.walletBalance,
      trendingPatterns: this.trendingTickers,
    };
  }

  buildPromptContext(): string {
    const state = this.getState();
    const parts: string[] = [];

    parts.push(`[MARKET STATE ${new Date(state.timestamp).toISOString()}]`);
    parts.push(`Wallet: ${state.walletBalance.toFixed(3)} SOL`);


    if (state.pipelineStats?.enabled) {
      const p = state.pipelineStats;
      parts.push(`Pipeline: ${p.tokensPerSec.toFixed(1)} tkn/s | received=${p.totalReceived} | pass=${p.passRate} | trades=${p.tradesEmitted} | workers=${p.workerUtilization} | cache=${p.cacheHitRate}`);
    }


    if (state.sessionStats) {
      const s = state.sessionStats;
      parts.push(`Session: ${s.tradesExecuted} trades (${s.tradesWon}W/${s.tradesLost}L) | P&L: ${s.totalPnlSol >= 0 ? '+' : ''}${s.totalPnlSol.toFixed(3)} SOL | scanned: ${s.tokensScanned}`);
    }


    if (state.positions.length > 0) {
      parts.push(`\n[POSITIONS (${state.positions.length})]`);
      for (const p of state.positions) {
        const sign = p.pnlPercent >= 0 ? '+' : '';
        parts.push(`  ${p.symbol} | ${sign}${p.pnlPercent.toFixed(1)}% (${sign}${p.pnlSol.toFixed(3)} SOL) | ${p.holdMinutes}min | invested=${p.amountSolInvested.toFixed(2)}`);
      }
    }


    const recentTokens = state.recentTokens
      .filter(t => Date.now() - t.receivedAt < 30_000)
      .slice(-15);
    if (recentTokens.length > 0) {
      parts.push(`\n[NEW TOKENS (last 30s: ${recentTokens.length})]`);
      for (const t of recentTokens) {
        const socials = t.hasSocials ? 'social' : 'no_social';
        const age = Math.round((Date.now() - t.receivedAt) / 1000);
        const score = t.pipelineScore !== undefined ? ` score=${t.pipelineScore}` : '';
        parts.push(`  ${t.symbol} (${t.name.slice(0, 20)}) | ${socials} | bc=${t.bondingProgress.toFixed(0)}% | mc=${t.mcap.toFixed(0)} | ${age}s ago${score}`);
      }
    }


    if (state.recentSignals.length > 0) {
      parts.push(`\n[SIGNALS (${state.recentSignals.length})]`);
      for (const s of state.recentSignals.slice(-5)) {
        parts.push(`  ${s.type.toUpperCase()}: ${s.mint.slice(0, 8)} score=${s.score || '?'} — ${s.reason.slice(0, 80)}`);
      }
    }


    if (state.recentTrades.length > 0) {
      parts.push(`\n[RECENT TRADES (${state.recentTrades.length})]`);
      for (const t of state.recentTrades.slice(-5)) {
        parts.push(`  ${t.action.toUpperCase()} ${t.symbol} ${t.amountSol.toFixed(2)} SOL — ${t.success ? 'OK' : 'FAIL'}`);
      }
    }


    if (this.newsStore) {
      try {
        const headlines = this.newsStore.getTopByPriority(5, 3_600_000);
        if (headlines.length > 0) {
          parts.push(`\n[NEWS HEADLINES (${headlines.length})]`);
          for (const h of headlines) {
            const ageMin = Math.round((Date.now() - h.published_at) / 60_000);
            const tokens = h.mentioned_tokens.length > 0 ? ` | ${h.mentioned_tokens.join(',')}` : '';
            parts.push(`  [${h.sentiment.toUpperCase()}] ${h.title.slice(0, 80)} (${h.source}, ${ageMin}m ago${tokens})`);
          }

          const sentiment = this.newsStore.getSentimentSummary();
          parts.push(`  Sentiment: ${sentiment.bullish}🟢 ${sentiment.bearish}🔴 ${sentiment.neutral}⚪ | trend=${sentiment.trend}`);
        }
      } catch {}
    }

    return parts.join('\n');
  }

getExposureSummary(maxConcurrent: number = 5, maxPortfolioPercent: number = 20): {
    totalInvestedSol: number;
    openPositions: number;
    availableBalance: number;
    maxNewPosition: number;
    canOpenNew: boolean;
    positions: Array<{ mint: string; symbol: string; pnlPercent: number; holdMinutes: number; invested: number }>;
    consecutiveLosses: number;
  } {
    const now = Date.now();
    const totalInvested = Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.amountSolInvested, 0);

    const available = Math.max(0, this.walletBalance - totalInvested);
    const maxByPercent = this.walletBalance * (maxPortfolioPercent / 100);
    const maxNew = Math.min(maxByPercent, available);


    let consecutiveLosses = 0;
    const trades = [...this.recentTrades].reverse();
    for (const t of trades) {
      if (!t.success || t.action === 'sell') break;
      if (t.action === 'buy' && !t.success) consecutiveLosses++;
      else break;
    }

    const posArray = Array.from(this.positions.values()).map(p => ({
      mint: p.mint,
      symbol: p.symbol,
      pnlPercent: p.entryPrice > 0 ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0,
      holdMinutes: Math.round((now - p.openedAt) / 60_000),
      invested: p.amountSolInvested,
    }));

    return {
      totalInvestedSol: totalInvested,
      openPositions: this.positions.size,
      availableBalance: available,
      maxNewPosition: maxNew,
      canOpenNew: this.positions.size < maxConcurrent && maxNew > 0.005,
      positions: posArray,
      consecutiveLosses,
    };
  }

  private trimSignals(): void {
    if (this.recentSignals.length > this.MAX_RECENT_SIGNALS) {
      this.recentSignals = this.recentSignals.slice(-this.MAX_RECENT_SIGNALS);
    }
  }
}
