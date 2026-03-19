import { Skill, SkillManifest, SkillContext, EventBusInterface, LoggerInterface, MemoryInterface, Position } from '../types';

// =====================================================
// Exit Optimizer — AI-Powered Sell Strategy
//
// The bot buys well but sells poorly. This skill fixes that.
// Monitors open positions and decides WHEN to exit:
//
// - Volume decay: dropping volume → dying token → exit
// - Momentum reversal: price peaked and turning → partial exit
// - Holder exodus: holders decreasing → smart money leaving
// - Dev selling: dev dumped → instant exit
// - Partial profit taking: +100% → sell 50%, +200% → sell 25%
// - Time-based decay: >30min no growth on memecoin = dead
// - Trailing peak: sell when price drops X% from ATH
// =====================================================

interface PositionMonitor {
  mint: string;
  symbol: string;
  entryPrice: number;
  peakPrice: number;        // All-time high since entry
  entryTime: number;
  lastPrice: number;
  lastHolders: number;
  lastVolume: number;
  priceHistory: { price: number; ts: number }[];
  volumeHistory: { volume: number; ts: number }[];
  holderHistory: { holders: number; ts: number }[];
  partialsSold: number;     // How many partial exits done (0, 1, 2)
  exitSignals: string[];    // Active exit signals
}

interface ExitConfig {
  // Profit-taking thresholds
  partialTake1Pct: number;      // First partial at +X% (default 100 = 2x)
  partialTake1SellPct: number;  // Sell X% of position (default 50)
  partialTake2Pct: number;      // Second partial at +X% (default 300 = 4x)
  partialTake2SellPct: number;  // Sell X% of remaining (default 50)

  // Stop loss
  stopLossPct: number;          // Hard stop at -X% (default 50)
  trailingStopPct: number;      // Trailing from peak -X% (default 30)

  // Time decay
  maxHoldMinutes: number;       // Force exit after X min without growth (default 30)
  growthThreshold: number;      // Min growth to reset timer (default 5%)

  // Volume decay
  volumeDecayCandles: number;   // Consecutive declining volume candles (default 3)

  // Holder exit
  holderDropPct: number;        // Exit if holders drop X% from peak (default 20)

  // Dev dump
  devDumpExitEnabled: boolean;  // Exit if dev sells (default true)
}

const DEFAULT_CONFIG: ExitConfig = {
  partialTake1Pct: 100,
  partialTake1SellPct: 50,
  partialTake2Pct: 300,
  partialTake2SellPct: 50,
  stopLossPct: 50,
  trailingStopPct: 30,
  maxHoldMinutes: 30,
  growthThreshold: 5,
  volumeDecayCandles: 3,
  holderDropPct: 20,
  devDumpExitEnabled: true,
};

export class ExitOptimizerSkill implements Skill {
  manifest: SkillManifest = {
    name: 'exit-optimizer',
    version: '1.0.0',
    description: 'AI exit strategy: profit-taking, trailing stops, volume decay, holder exodus, dev dumps, time decay',
    tools: [
      {
        name: 'exit_config',
        description: 'Configure exit strategy parameters',
        parameters: {
          type: 'object',
          properties: {
            partialTake1Pct: { type: 'number', description: 'First partial take-profit at +X% (default 100)' },
            partialTake1SellPct: { type: 'number', description: '% of position to sell at first take (default 50)' },
            partialTake2Pct: { type: 'number', description: 'Second partial take-profit at +X% (default 300)' },
            partialTake2SellPct: { type: 'number', description: '% of remaining to sell at second take (default 50)' },
            stopLossPct: { type: 'number', description: 'Hard stop-loss at -X% (default 50)' },
            trailingStopPct: { type: 'number', description: 'Trailing stop from peak at -X% (default 30)' },
            maxHoldMinutes: { type: 'number', description: 'Force exit after X min without growth (default 30)' },
            volumeDecayCandles: { type: 'number', description: 'Exit after X declining volume candles (default 3)' },
            holderDropPct: { type: 'number', description: 'Exit if holders drop X% from peak (default 20)' },
            devDumpExitEnabled: { type: 'boolean', description: 'Exit if dev sells (default true)' },
          },
        },
        riskLevel: 'write',
      },
      {
        name: 'exit_status',
        description: 'Get exit monitoring status for all positions',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'exit_analyze',
        description: 'Analyze exit signals for a specific position',
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
        name: 'exit_enable',
        description: 'Enable automatic exit optimization',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'write',
      },
      {
        name: 'exit_disable',
        description: 'Disable automatic exit optimization (manual sells only)',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'write',
      },
      {
        name: 'exit_force',
        description: 'Force immediate exit for a position',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            reason: { type: 'string', description: 'Reason for forced exit' },
          },
          required: ['mint'],
        },
        riskLevel: 'financial',
        requiresApproval: true,
      },
      {
        name: 'exit_stats',
        description: 'Get exit optimizer statistics',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private eventBus!: EventBusInterface;
  private logger!: LoggerInterface;
  private memory!: MemoryInterface;
  private config: ExitConfig = { ...DEFAULT_CONFIG };
  private monitors = new Map<string, PositionMonitor>();
  private enabled = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private readonly CHECK_INTERVAL = 5_000; // Check every 5s

  private stats = {
    totalExits: 0,
    profitTakes: 0,
    stopLosses: 0,
    trailingStops: 0,
    timeDecays: 0,
    volumeDecays: 0,
    holderExoduses: 0,
    devDumps: 0,
    avgHoldMinutes: 0,
    totalPnlFromExits: 0,
  };

  async initialize(ctx: SkillContext): Promise<void> {
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
    this.memory = ctx.memory;

    // Track new positions
    this.eventBus.on('position:opened', (pos) => this.startMonitoring(pos));
    this.eventBus.on('position:updated', (pos) => this.updatePosition(pos));
    this.eventBus.on('position:closed', ({ mint }) => this.stopMonitoring(mint));
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'exit_config': return this.updateConfig(params as Partial<ExitConfig>);
      case 'exit_status': return this.getAllStatus();
      case 'exit_analyze': return this.analyzePosition(params.mint);
      case 'exit_enable': return this.enable();
      case 'exit_disable': return this.disable();
      case 'exit_force': return this.forceExit(params.mint, params.reason || 'manual');
      case 'exit_stats': return { ...this.stats };
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.disable();
    this.monitors.clear();
  }

  // =====================================================
  // Position monitoring
  // =====================================================

  private startMonitoring(pos: Position): void {
    if (this.monitors.has(pos.mint)) return;

    const monitor: PositionMonitor = {
      mint: pos.mint,
      symbol: pos.symbol,
      entryPrice: pos.entryPrice,
      peakPrice: pos.currentPrice,
      entryTime: pos.openedAt || Date.now(),
      lastPrice: pos.currentPrice,
      lastHolders: 0,
      lastVolume: 0,
      priceHistory: [{ price: pos.currentPrice, ts: Date.now() }],
      volumeHistory: [],
      holderHistory: [],
      partialsSold: 0,
      exitSignals: [],
    };

    this.monitors.set(pos.mint, monitor);
    this.logger.debug(`Exit optimizer monitoring: ${pos.symbol}`);
  }

  private updatePosition(pos: Position): void {
    const monitor = this.monitors.get(pos.mint);
    if (!monitor) {
      this.startMonitoring(pos);
      return;
    }

    monitor.lastPrice = pos.currentPrice;
    if (pos.currentPrice > monitor.peakPrice) {
      monitor.peakPrice = pos.currentPrice;
    }

    monitor.priceHistory.push({ price: pos.currentPrice, ts: Date.now() });

    // Keep last 100 entries
    if (monitor.priceHistory.length > 100) {
      monitor.priceHistory = monitor.priceHistory.slice(-100);
    }
  }

  private stopMonitoring(mint: string): void {
    this.monitors.delete(mint);
  }

  // =====================================================
  // Exit check engine (runs every 5s)
  // =====================================================

  private enable(): { status: string } {
    this.enabled = true;
    if (!this.checkTimer) {
      this.checkTimer = setInterval(() => this.checkAllPositions(), this.CHECK_INTERVAL);
    }
    this.logger.info('Exit optimizer ENABLED');
    return { status: 'enabled' };
  }

  private disable(): { status: string } {
    this.enabled = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.logger.info('Exit optimizer DISABLED');
    return { status: 'disabled' };
  }

  private async checkAllPositions(): Promise<void> {
    if (!this.enabled) return;

    for (const [mint, monitor] of this.monitors) {
      const signals = this.evaluateExitSignals(monitor);
      monitor.exitSignals = signals;

      if (signals.length > 0) {
        const urgency = this.classifyUrgency(signals);
        const sellPct = this.determineSellPercent(signals, monitor);

        if (sellPct > 0) {
          this.emitSellSignal(mint, monitor, signals, urgency, sellPct);
        }
      }
    }
  }

  private evaluateExitSignals(monitor: PositionMonitor): string[] {
    const signals: string[] = [];
    const now = Date.now();
    const holdMinutes = (now - monitor.entryTime) / 60_000;

    if (monitor.lastPrice <= 0 || monitor.entryPrice <= 0) return signals;

    const pnlPct = ((monitor.lastPrice - monitor.entryPrice) / monitor.entryPrice) * 100;
    const drawdownFromPeak = monitor.peakPrice > 0
      ? ((monitor.peakPrice - monitor.lastPrice) / monitor.peakPrice) * 100
      : 0;

    // 1. Hard stop-loss
    if (pnlPct <= -this.config.stopLossPct) {
      signals.push(`stop_loss_${pnlPct.toFixed(0)}%`);
    }

    // 2. Trailing stop from peak
    if (drawdownFromPeak >= this.config.trailingStopPct && pnlPct > 0) {
      signals.push(`trailing_stop_${drawdownFromPeak.toFixed(0)}%_from_peak`);
    }

    // 3. Partial profit-taking #1
    if (monitor.partialsSold === 0 && pnlPct >= this.config.partialTake1Pct) {
      signals.push(`partial_take_1_${pnlPct.toFixed(0)}%`);
    }

    // 4. Partial profit-taking #2
    if (monitor.partialsSold === 1 && pnlPct >= this.config.partialTake2Pct) {
      signals.push(`partial_take_2_${pnlPct.toFixed(0)}%`);
    }

    // 5. Time decay — no growth after X minutes
    if (holdMinutes >= this.config.maxHoldMinutes) {
      // Check if price has grown since entry
      const growth = pnlPct;
      if (growth < this.config.growthThreshold) {
        signals.push(`time_decay_${holdMinutes.toFixed(0)}min`);
      }
    }

    // 6. Volume decay — consecutive declining volume
    if (monitor.volumeHistory.length >= this.config.volumeDecayCandles) {
      const recent = monitor.volumeHistory.slice(-this.config.volumeDecayCandles);
      let declining = true;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i].volume >= recent[i - 1].volume) {
          declining = false;
          break;
        }
      }
      if (declining) {
        signals.push('volume_decay');
      }
    }

    // 7. Holder exodus
    if (monitor.holderHistory.length >= 2) {
      const peakHolders = Math.max(...monitor.holderHistory.map(h => h.holders));
      const currentHolders = monitor.holderHistory[monitor.holderHistory.length - 1].holders;
      if (peakHolders > 0) {
        const holderDrop = ((peakHolders - currentHolders) / peakHolders) * 100;
        if (holderDrop >= this.config.holderDropPct) {
          signals.push(`holder_exodus_${holderDrop.toFixed(0)}%`);
        }
      }
    }

    // 8. Momentum reversal — price peaked and dropping for 3+ consecutive reads
    if (monitor.priceHistory.length >= 4) {
      const last4 = monitor.priceHistory.slice(-4);
      let consecutive = 0;
      for (let i = 1; i < last4.length; i++) {
        if (last4[i].price < last4[i - 1].price) consecutive++;
        else consecutive = 0;
      }
      if (consecutive >= 3 && pnlPct > 10) {
        signals.push('momentum_reversal');
      }
    }

    return signals;
  }

  private classifyUrgency(signals: string[]): 'low' | 'medium' | 'high' {
    if (signals.some(s => s.startsWith('stop_loss') || s.startsWith('dev_dump'))) return 'high';
    if (signals.some(s => s.startsWith('trailing_stop') || s.startsWith('holder_exodus'))) return 'medium';
    return 'low';
  }

  private determineSellPercent(signals: string[], monitor: PositionMonitor): number {
    // Hard stop = sell everything
    if (signals.some(s => s.startsWith('stop_loss') || s.startsWith('dev_dump'))) return 100;

    // Trailing stop = sell everything remaining
    if (signals.some(s => s.startsWith('trailing_stop'))) return 100;

    // Partial take #1
    if (signals.some(s => s.startsWith('partial_take_1'))) {
      monitor.partialsSold = 1;
      return this.config.partialTake1SellPct;
    }

    // Partial take #2
    if (signals.some(s => s.startsWith('partial_take_2'))) {
      monitor.partialsSold = 2;
      return this.config.partialTake2SellPct;
    }

    // Time decay = sell remaining
    if (signals.some(s => s.startsWith('time_decay'))) return 100;

    // Holder exodus = sell most
    if (signals.some(s => s.startsWith('holder_exodus'))) return 80;

    // Volume decay = sell half
    if (signals.includes('volume_decay')) return 50;

    // Momentum reversal = sell partial
    if (signals.includes('momentum_reversal')) return 30;

    return 0;
  }

  private emitSellSignal(mint: string, monitor: PositionMonitor, signals: string[], urgency: 'low' | 'medium' | 'high', sellPct: number): void {
    const reason = `Exit optimizer: [${signals.join(', ')}]`;

    this.logger.trade(`EXIT SIGNAL: ${monitor.symbol} sell ${sellPct}% — ${signals.join(', ')}`);

    // Update stats
    this.stats.totalExits++;
    if (signals.some(s => s.startsWith('partial_take'))) this.stats.profitTakes++;
    if (signals.some(s => s.startsWith('stop_loss'))) this.stats.stopLosses++;
    if (signals.some(s => s.startsWith('trailing_stop'))) this.stats.trailingStops++;
    if (signals.some(s => s.startsWith('time_decay'))) this.stats.timeDecays++;
    if (signals.includes('volume_decay')) this.stats.volumeDecays++;
    if (signals.some(s => s.startsWith('holder_exodus'))) this.stats.holderExoduses++;

    const holdMin = (Date.now() - monitor.entryTime) / 60_000;
    this.stats.avgHoldMinutes =
      (this.stats.avgHoldMinutes * (this.stats.totalExits - 1) + holdMin) / this.stats.totalExits;

    // Emit signal:sell for the trading system
    this.eventBus.emit('signal:sell', {
      mint,
      reason,
      urgency,
      agentId: 'exit-optimizer',
    });

    // For high urgency, also emit a trade:intent directly
    if (urgency === 'high') {
      this.eventBus.emit('trade:intent', {
        id: `exit_${Date.now()}_${mint.slice(0, 8)}`,
        agentId: 'exit-optimizer',
        action: 'sell',
        mint,
        symbol: monitor.symbol,
        amountPercent: sellPct,
        slippageBps: 3000, // Higher slippage for urgent exits
        priorityFeeSol: 0.01,
        reason,
        timestamp: Date.now(),
      });
    }
  }

  private forceExit(mint: string, reason: string): { status: string } {
    const monitor = this.monitors.get(mint);
    if (!monitor) return { status: 'not_monitoring' };

    this.eventBus.emit('trade:intent', {
      id: `force_exit_${Date.now()}_${mint.slice(0, 8)}`,
      agentId: 'exit-optimizer',
      action: 'sell',
      mint,
      symbol: monitor.symbol,
      amountPercent: 100,
      slippageBps: 5000,
      priorityFeeSol: 0.02,
      reason: `FORCE EXIT: ${reason}`,
      timestamp: Date.now(),
    });

    return { status: 'exit_initiated' };
  }

  // =====================================================
  // Public API — for external data feeds
  // =====================================================

  /**
   * Feed volume data from external source (dex-screener, pump-monitor).
   */
  feedVolume(mint: string, volume: number): void {
    const monitor = this.monitors.get(mint);
    if (!monitor) return;
    monitor.lastVolume = volume;
    monitor.volumeHistory.push({ volume, ts: Date.now() });
    if (monitor.volumeHistory.length > 50) monitor.volumeHistory = monitor.volumeHistory.slice(-50);
  }

  /**
   * Feed holder count from external source (token-analyzer, holder-intelligence).
   */
  feedHolders(mint: string, holders: number): void {
    const monitor = this.monitors.get(mint);
    if (!monitor) return;
    monitor.lastHolders = holders;
    monitor.holderHistory.push({ holders, ts: Date.now() });
    if (monitor.holderHistory.length > 50) monitor.holderHistory = monitor.holderHistory.slice(-50);
  }

  /**
   * Signal that dev is selling (from holder-intelligence or wallet-tracker).
   */
  signalDevSelling(mint: string): void {
    if (!this.config.devDumpExitEnabled) return;
    const monitor = this.monitors.get(mint);
    if (!monitor) return;

    this.stats.devDumps++;
    this.emitSellSignal(mint, monitor, ['dev_dump'], 'high', 100);
  }

  // =====================================================
  // Status / config
  // =====================================================

  private updateConfig(updates: Partial<ExitConfig>): ExitConfig {
    Object.assign(this.config, updates);
    return { ...this.config };
  }

  private getAllStatus(): {
    enabled: boolean;
    positions: Array<{
      mint: string;
      symbol: string;
      holdMinutes: number;
      pnlPct: number;
      peakPnlPct: number;
      partialsSold: number;
      exitSignals: string[];
    }>;
  } {
    const positions = Array.from(this.monitors.values()).map(m => ({
      mint: m.mint,
      symbol: m.symbol,
      holdMinutes: Math.round((Date.now() - m.entryTime) / 60_000),
      pnlPct: m.entryPrice > 0 ? ((m.lastPrice - m.entryPrice) / m.entryPrice) * 100 : 0,
      peakPnlPct: m.entryPrice > 0 ? ((m.peakPrice - m.entryPrice) / m.entryPrice) * 100 : 0,
      partialsSold: m.partialsSold,
      exitSignals: m.exitSignals,
    }));

    return { enabled: this.enabled, positions };
  }

  private analyzePosition(mint: string): any {
    const monitor = this.monitors.get(mint);
    if (!monitor) return { error: 'Position not monitored' };

    const signals = this.evaluateExitSignals(monitor);
    const pnlPct = monitor.entryPrice > 0
      ? ((monitor.lastPrice - monitor.entryPrice) / monitor.entryPrice) * 100
      : 0;
    const drawdown = monitor.peakPrice > 0
      ? ((monitor.peakPrice - monitor.lastPrice) / monitor.peakPrice) * 100
      : 0;

    return {
      mint: monitor.mint,
      symbol: monitor.symbol,
      entryPrice: monitor.entryPrice,
      currentPrice: monitor.lastPrice,
      peakPrice: monitor.peakPrice,
      pnlPct: Math.round(pnlPct * 100) / 100,
      drawdownFromPeak: Math.round(drawdown * 100) / 100,
      holdMinutes: Math.round((Date.now() - monitor.entryTime) / 60_000),
      partialsSold: monitor.partialsSold,
      exitSignals: signals,
      recommendation: signals.length > 0
        ? `SELL ${this.determineSellPercent(signals, monitor)}% — ${signals.join(', ')}`
        : 'HOLD',
    };
  }
}
