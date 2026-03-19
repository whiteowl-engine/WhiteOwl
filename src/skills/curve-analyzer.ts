import { Skill, SkillManifest, SkillContext, EventBusInterface, LoggerInterface, MemoryInterface } from '../types';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  OnlinePumpSdk,
  bondingCurvePda,
  bondingCurveMarketCap,
  type BondingCurve,
  type Global,
} from '@pump-fun/pump-sdk';

// =====================================================
// Bonding Curve Analyzer
//
// Real-time monitoring of pump.fun bonding curve state:
// - Current progress (SOL in curve / 85 SOL target)
// - Velocity (SOL/min inflow rate)
// - Graduation prediction (ETA to 85 SOL)
// - Buy/sell pressure ratio
// - Optimal entry zone detection (15-45% sweet spot)
// - Graduation alerts for instant pump.fun AMM snipe
//
// This is THE key skill for pump.fun trading —
// without curve analysis, the bot is trading blind.
// =====================================================

interface CurveState {
  mint: string;
  symbol: string;
  solInCurve: number;         // Current SOL locked in bonding curve
  progressPct: number;        // % towards graduation (solInCurve / 85 * 100)
  velocity1m: number;         // SOL/min inflow over last 1 min
  velocity5m: number;         // SOL/min inflow over last 5 min
  buys1m: number;             // Buy count in last 1 min
  sells1m: number;            // Sell count in last 1 min
  buyPressure: number;        // buy/(buy+sell) ratio, 0-1
  netFlow1m: number;          // Net SOL flow in last 1 min (positive = inflow)
  estimatedGradMinutes: number; // Predicted minutes until graduation (0 = unknown)
  entryZone: 'early' | 'sweet' | 'late' | 'danger' | 'graduated';
  lastUpdated: number;
  // On-chain data from pump SDK
  virtualSolReserves?: number;   // Virtual SOL reserves (SOL)
  virtualTokenReserves?: number; // Virtual token reserves
  realSolReserves?: number;      // Real SOL in curve
  realTokenReserves?: number;    // Real tokens left in curve
  marketCapLamports?: number;    // Market cap in lamports (from SDK)
  creator?: string;              // Token creator address
  complete?: boolean;            // Graduated on-chain flag
}

interface TradeEvent {
  mint: string;
  type: 'buy' | 'sell';
  solAmount: number;
  timestamp: number;
}

interface CurveTracker {
  state: CurveState;
  trades: TradeEvent[];    // Rolling window of recent trades
  snapshots: { sol: number; ts: number }[]; // SOL-in-curve snapshots
}

export class CurveAnalyzerSkill implements Skill {
  manifest: SkillManifest = {
    name: 'curve-analyzer',
    version: '2.0.0',
    description: 'Real-time bonding curve analysis via official pump SDK: on-chain state, velocity, graduation prediction, buy/sell pressure, optimal entry detection',
    tools: [
      {
        name: 'curve_watch',
        description: 'Start monitoring a token\'s bonding curve in real-time',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            symbol: { type: 'string', description: 'Token symbol (optional)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'curve_unwatch',
        description: 'Stop monitoring a token\'s bonding curve',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'curve_state',
        description: 'Get current bonding curve state for a specific token',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'curve_analyze',
        description: 'Fetch and analyze bonding curve state from on-chain data',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'curve_hot',
        description: 'List tokens with fastest-filling bonding curves right now',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (default 10)' },
            minVelocity: { type: 'number', description: 'Minimum SOL/min velocity filter' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'curve_graduating',
        description: 'List tokens predicted to graduate within N minutes',
        parameters: {
          type: 'object',
          properties: {
            withinMinutes: { type: 'number', description: 'Predict graduation within X minutes (default 10)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'curve_auto_watch',
        description: 'Enable/disable automatic curve watching for all new tokens from pipeline',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Enable auto-watch' },
            maxTracked: { type: 'number', description: 'Max simultaneous tokens to track (default 100)' },
          },
          required: ['enabled'],
        },
        riskLevel: 'read',
      },
      {
        name: 'curve_stats',
        description: 'Get curve analyzer statistics',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private eventBus!: EventBusInterface;
  private logger!: LoggerInterface;
  private memory!: MemoryInterface;
  private solanaRpc = '';
  private pumpSdk!: OnlinePumpSdk;

  private trackers = new Map<string, CurveTracker>();
  private autoWatch = false;
  private maxTracked = 100;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL = 10_000; // 10s
  private readonly TRADE_WINDOW = 5 * 60_000; // 5 min rolling window
  private readonly SNAPSHOT_WINDOW = 10 * 60_000; // 10 min
  private readonly GRADUATION_SOL = 85;

  private stats = {
    totalTracked: 0,
    graduationsDetected: 0,
    sweetSpotAlerts: 0,
    avgVelocity: 0,
  };

  async initialize(ctx: SkillContext): Promise<void> {
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
    this.memory = ctx.memory;
    this.solanaRpc = ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

    // Initialize pump SDK for on-chain reads
    const connection = new Connection(this.solanaRpc, 'confirmed');
    this.pumpSdk = new OnlinePumpSdk(connection);
    this.logger.info('Curve analyzer: pump SDK initialized');

    // Listen for token:new to auto-watch
    this.eventBus.on('token:new', (data) => {
      if (this.autoWatch && this.trackers.size < this.maxTracked) {
        this.startTracking(data.mint, data.symbol);
      }
    });

    // Listen for position:closed to stop tracking sold tokens
    this.eventBus.on('position:closed', ({ mint }) => {
      this.stopTracking(mint);
    });
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'curve_watch': return this.startTracking(params.mint, params.symbol);
      case 'curve_unwatch': return this.stopTracking(params.mint);
      case 'curve_state': return this.getState(params.mint);
      case 'curve_analyze': return this.analyzeFromChain(params.mint);
      case 'curve_hot': return this.getHotCurves(params.limit || 10, params.minVelocity || 0);
      case 'curve_graduating': return this.getGraduating(params.withinMinutes || 10);
      case 'curve_auto_watch': return this.setAutoWatch(params.enabled, params.maxTracked);
      case 'curve_stats': return this.getStats();
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.trackers.clear();
  }

  // =====================================================
  // Public API for Pipeline integration
  // =====================================================

  /**
   * Get curve analysis for a token. Used by Pipeline.
   */
  getCurveState(mint: string): CurveState | null {
    const tracker = this.trackers.get(mint);
    return tracker ? { ...tracker.state } : null;
  }

  /**
   * Record a trade event (buy/sell) for curve tracking.
   * Called from pump-monitor when it receives trade events.
   */
  recordTrade(mint: string, type: 'buy' | 'sell', solAmount: number): void {
    const tracker = this.trackers.get(mint);
    if (!tracker) return;

    tracker.trades.push({ mint, type, solAmount, timestamp: Date.now() });

    // Update state inline
    if (type === 'buy') {
      tracker.state.solInCurve += solAmount;
    } else {
      tracker.state.solInCurve = Math.max(0, tracker.state.solInCurve - solAmount);
    }

    tracker.state.progressPct = (tracker.state.solInCurve / this.GRADUATION_SOL) * 100;
    tracker.snapshots.push({ sol: tracker.state.solInCurve, ts: Date.now() });

    this.recalcMetrics(tracker);

    // Graduation detection
    if (tracker.state.progressPct >= 99 && tracker.state.entryZone !== 'graduated') {
      tracker.state.entryZone = 'graduated';
      this.stats.graduationsDetected++;
      this.logger.trade(`GRADUATION: ${tracker.state.symbol || mint.slice(0, 8)} reached ${tracker.state.progressPct.toFixed(1)}%`);
      this.eventBus.emit('token:graduated', {
        mint,
        dex: 'pump_amm',
        timestamp: Date.now(),
      });
    }
  }

  // =====================================================
  // Core tracking logic
  // =====================================================

  private startTracking(mint: string, symbol?: string): { status: string; tracked: number } {
    if (this.trackers.has(mint)) {
      return { status: 'already_tracking', tracked: this.trackers.size };
    }

    // Evict oldest if over limit
    if (this.trackers.size >= this.maxTracked) {
      this.evictOldest();
    }

    const token = this.memory.getToken(mint);

    const state: CurveState = {
      mint,
      symbol: symbol || token?.symbol || '???',
      solInCurve: 0,
      progressPct: token?.bondingCurveProgress || 0,
      velocity1m: 0,
      velocity5m: 0,
      buys1m: 0,
      sells1m: 0,
      buyPressure: 0.5,
      netFlow1m: 0,
      estimatedGradMinutes: 0,
      entryZone: 'early',
      lastUpdated: Date.now(),
    };

    // Estimate initial SOL from progress
    if (token?.bondingCurveProgress) {
      state.solInCurve = (token.bondingCurveProgress / 100) * this.GRADUATION_SOL;
    }

    state.entryZone = this.classifyZone(state.progressPct);

    this.trackers.set(mint, {
      state,
      trades: [],
      snapshots: [{ sol: state.solInCurve, ts: Date.now() }],
    });

    this.stats.totalTracked++;

    // Start polling if not already running
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.pollAll(), this.POLL_INTERVAL);
    }

    return { status: 'tracking', tracked: this.trackers.size };
  }

  private stopTracking(mint: string): { status: string } {
    this.trackers.delete(mint);

    if (this.trackers.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    return { status: 'stopped' };
  }

  private getState(mint: string): CurveState | { error: string } {
    const tracker = this.trackers.get(mint);
    if (!tracker) return { error: 'Not tracking this token. Use curve_watch first.' };
    return { ...tracker.state };
  }

  private async analyzeFromChain(mint: string): Promise<CurveState> {
    // Fetch real on-chain bonding curve state via official pump SDK
    try {
      const mintPk = new PublicKey(mint);
      const bc = await this.pumpSdk.fetchBondingCurve(mintPk);

      const virtualSolReserves = bc.virtualSolReserves.toNumber() / 1e9;
      const virtualTokenReserves = bc.virtualTokenReserves.toNumber() / 1e6;
      const realSolReserves = bc.realSolReserves.toNumber() / 1e9;
      const realTokenReserves = bc.realTokenReserves.toNumber() / 1e6;
      const solInCurve = realSolReserves;
      const progressPct = bc.complete ? 100 : Math.min((solInCurve / this.GRADUATION_SOL) * 100, 100);

      // Calculate market cap via SDK math
      const mcapLamports = bondingCurveMarketCap({
        mintSupply: bc.tokenTotalSupply,
        virtualSolReserves: bc.virtualSolReserves,
        virtualTokenReserves: bc.virtualTokenReserves,
      }).toNumber();

      // If we have a tracker, update it
      const tracker = this.trackers.get(mint);
      if (tracker) {
        tracker.state.solInCurve = solInCurve;
        tracker.state.progressPct = progressPct;
        tracker.state.entryZone = bc.complete ? 'graduated' : this.classifyZone(progressPct);
        tracker.state.lastUpdated = Date.now();
        tracker.state.virtualSolReserves = virtualSolReserves;
        tracker.state.virtualTokenReserves = virtualTokenReserves;
        tracker.state.realSolReserves = realSolReserves;
        tracker.state.realTokenReserves = realTokenReserves;
        tracker.state.marketCapLamports = mcapLamports;
        tracker.state.creator = bc.creator.toBase58();
        tracker.state.complete = bc.complete;
        tracker.snapshots.push({ sol: solInCurve, ts: Date.now() });
        this.recalcMetrics(tracker);
        return { ...tracker.state };
      }

      const token = this.memory.getToken(mint);
      const state: CurveState = {
        mint,
        symbol: token?.symbol || '???',
        solInCurve,
        progressPct,
        velocity1m: 0,
        velocity5m: 0,
        buys1m: 0,
        sells1m: 0,
        buyPressure: 0.5,
        netFlow1m: 0,
        estimatedGradMinutes: 0,
        entryZone: bc.complete ? 'graduated' : this.classifyZone(progressPct),
        lastUpdated: Date.now(),
        virtualSolReserves,
        virtualTokenReserves,
        realSolReserves,
        realTokenReserves,
        marketCapLamports: mcapLamports,
        creator: bc.creator.toBase58(),
        complete: bc.complete,
      };

      return state;
    } catch (err: any) {
      this.logger.debug(`SDK fetchBondingCurve failed for ${mint.slice(0, 8)}: ${err.message}`);
    }

    // Fallback: use memory data
    const token = this.memory.getToken(mint);
    return {
      mint,
      symbol: token?.symbol || '???',
      solInCurve: token ? (token.bondingCurveProgress / 100) * this.GRADUATION_SOL : 0,
      progressPct: token?.bondingCurveProgress || 0,
      velocity1m: 0, velocity5m: 0, buys1m: 0, sells1m: 0,
      buyPressure: 0.5, netFlow1m: 0, estimatedGradMinutes: 0,
      entryZone: this.classifyZone(token?.bondingCurveProgress || 0),
      lastUpdated: Date.now(),
    };
  }

  private getHotCurves(limit: number, minVelocity: number): CurveState[] {
    const states: CurveState[] = [];
    for (const tracker of this.trackers.values()) {
      if (tracker.state.velocity5m >= minVelocity && tracker.state.entryZone !== 'graduated') {
        states.push({ ...tracker.state });
      }
    }
    return states
      .sort((a, b) => b.velocity5m - a.velocity5m)
      .slice(0, limit);
  }

  private getGraduating(withinMinutes: number): CurveState[] {
    const states: CurveState[] = [];
    for (const tracker of this.trackers.values()) {
      if (
        tracker.state.estimatedGradMinutes > 0 &&
        tracker.state.estimatedGradMinutes <= withinMinutes &&
        tracker.state.entryZone !== 'graduated'
      ) {
        states.push({ ...tracker.state });
      }
    }
    return states.sort((a, b) => a.estimatedGradMinutes - b.estimatedGradMinutes);
  }

  private setAutoWatch(enabled: boolean, maxTracked?: number): { status: string; autoWatch: boolean; maxTracked: number } {
    this.autoWatch = enabled;
    if (maxTracked) this.maxTracked = maxTracked;
    return { status: enabled ? 'auto_watch_enabled' : 'auto_watch_disabled', autoWatch: this.autoWatch, maxTracked: this.maxTracked };
  }

  private getStats() {
    const velocities: number[] = [];
    for (const tracker of this.trackers.values()) {
      if (tracker.state.velocity5m > 0) velocities.push(tracker.state.velocity5m);
    }

    return {
      ...this.stats,
      currentlyTracking: this.trackers.size,
      autoWatch: this.autoWatch,
      avgVelocity: velocities.length > 0 ? velocities.reduce((a, b) => a + b, 0) / velocities.length : 0,
      hotTokens: velocities.filter(v => v > 0.5).length,
    };
  }

  // =====================================================
  // Internal logic
  // =====================================================

  private recalcMetrics(tracker: CurveTracker): void {
    const now = Date.now();
    const cutoff1m = now - 60_000;
    const cutoff5m = now - 5 * 60_000;

    // Clean old trades
    tracker.trades = tracker.trades.filter(t => t.timestamp > now - this.TRADE_WINDOW);
    tracker.snapshots = tracker.snapshots.filter(s => s.ts > now - this.SNAPSHOT_WINDOW);

    // 1-minute metrics
    const trades1m = tracker.trades.filter(t => t.timestamp > cutoff1m);
    const buys1m = trades1m.filter(t => t.type === 'buy');
    const sells1m = trades1m.filter(t => t.type === 'sell');

    tracker.state.buys1m = buys1m.length;
    tracker.state.sells1m = sells1m.length;

    const totalTrades1m = buys1m.length + sells1m.length;
    tracker.state.buyPressure = totalTrades1m > 0 ? buys1m.length / totalTrades1m : 0.5;

    const buyFlow1m = buys1m.reduce((s, t) => s + t.solAmount, 0);
    const sellFlow1m = sells1m.reduce((s, t) => s + t.solAmount, 0);
    tracker.state.netFlow1m = buyFlow1m - sellFlow1m;
    tracker.state.velocity1m = buyFlow1m - sellFlow1m; // Net SOL/min

    // 5-minute velocity
    const trades5m = tracker.trades.filter(t => t.timestamp > cutoff5m);
    const buyFlow5m = trades5m.filter(t => t.type === 'buy').reduce((s, t) => s + t.solAmount, 0);
    const sellFlow5m = trades5m.filter(t => t.type === 'sell').reduce((s, t) => s + t.solAmount, 0);
    const elapsed5m = Math.min(5, (now - (tracker.snapshots[0]?.ts || now)) / 60_000);
    tracker.state.velocity5m = elapsed5m > 0 ? (buyFlow5m - sellFlow5m) / elapsed5m : 0;

    // Graduation prediction
    if (tracker.state.velocity5m > 0) {
      const remaining = this.GRADUATION_SOL - tracker.state.solInCurve;
      tracker.state.estimatedGradMinutes = remaining / tracker.state.velocity5m;
    } else {
      tracker.state.estimatedGradMinutes = 0;
    }

    // Entry zone classification
    tracker.state.entryZone = this.classifyZone(tracker.state.progressPct);
    tracker.state.lastUpdated = now;

    // Alert on sweet spot entry
    if (tracker.state.entryZone === 'sweet' && tracker.state.velocity5m > 0.3) {
      this.stats.sweetSpotAlerts++;
    }
  }

  private classifyZone(progressPct: number): CurveState['entryZone'] {
    if (progressPct >= 99) return 'graduated';
    if (progressPct >= 75) return 'danger';
    if (progressPct >= 45) return 'late';
    if (progressPct >= 15) return 'sweet';
    return 'early';
  }

  private async pollAll(): Promise<void> {
    // Clean stale trackers (no updates in 30 min)
    const staleThreshold = Date.now() - 30 * 60_000;
    for (const [mint, tracker] of this.trackers) {
      if (tracker.state.lastUpdated < staleThreshold) {
        this.trackers.delete(mint);
      }
    }

    // Poll on-chain state for active trackers (batch)
    const mints = Array.from(this.trackers.keys());
    if (mints.length === 0) return;

    // Poll in batches of 10
    for (let i = 0; i < mints.length; i += 10) {
      const batch = mints.slice(i, i + 10);
      await Promise.allSettled(
        batch.map(mint => this.pollCurveState(mint))
      );
    }
  }

  private async pollCurveState(mint: string): Promise<void> {
    const tracker = this.trackers.get(mint);
    if (!tracker) return;

    try {
      // Use official pump SDK for on-chain bonding curve reads
      const mintPk = new PublicKey(mint);
      const bc = await this.pumpSdk.fetchBondingCurve(mintPk);

      const realSolReserves = bc.realSolReserves.toNumber() / 1e9;
      const solInCurve = realSolReserves;
      const progressPct = bc.complete ? 100 : Math.min((solInCurve / this.GRADUATION_SOL) * 100, 100);

      // Update tracker with on-chain data
      tracker.state.solInCurve = solInCurve;
      tracker.state.progressPct = progressPct;
      tracker.state.virtualSolReserves = bc.virtualSolReserves.toNumber() / 1e9;
      tracker.state.virtualTokenReserves = bc.virtualTokenReserves.toNumber() / 1e6;
      tracker.state.realSolReserves = realSolReserves;
      tracker.state.realTokenReserves = bc.realTokenReserves.toNumber() / 1e6;
      tracker.state.complete = bc.complete;
      tracker.state.creator = bc.creator.toBase58();
      tracker.snapshots.push({ sol: solInCurve, ts: Date.now() });

      this.recalcMetrics(tracker);

      // Check graduation via on-chain complete flag (most reliable)
      if (bc.complete && tracker.state.entryZone !== 'graduated') {
        tracker.state.entryZone = 'graduated';
        this.stats.graduationsDetected++;
        this.logger.trade(`GRADUATION DETECTED: ${tracker.state.symbol} at ${progressPct.toFixed(1)}%`);
        this.eventBus.emit('token:graduated', { mint, dex: 'pump_amm', timestamp: Date.now() });
      }
    } catch {
      // Non-critical, retry on next poll
    }
  }

  private evictOldest(): void {
    let oldestMint: string | null = null;
    let oldestTime = Infinity;

    for (const [mint, tracker] of this.trackers) {
      if (tracker.state.lastUpdated < oldestTime) {
        oldestTime = tracker.state.lastUpdated;
        oldestMint = mint;
      }
    }

    if (oldestMint) this.trackers.delete(oldestMint);
  }
}
