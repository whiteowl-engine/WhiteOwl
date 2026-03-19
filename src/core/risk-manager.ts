import {
  AgentRiskLimits,
  TradeIntent,
  Position,
  LoggerInterface,
  EventBusInterface,
} from '../types';

interface RiskState {
  openPositions: Position[];
  dailyLoss: number;
  dailyProfit: number;
  dayStart: number;
  totalExposure: number;
  consecutiveLosses: number;
  cooldownUntil: number;
  emergencyStopped: boolean;
}

export class RiskManager {
  private globalLimits: AgentRiskLimits & { emergencyStopLossSol: number };
  private agentLimits = new Map<string, AgentRiskLimits>();
  private state: RiskState;
  private logger: LoggerInterface;
  private eventBus: EventBusInterface;

  constructor(
    globalLimits: AgentRiskLimits & { emergencyStopLossSol: number },
    eventBus: EventBusInterface,
    logger: LoggerInterface
  ) {
    this.globalLimits = globalLimits;
    this.eventBus = eventBus;
    this.logger = logger;

    this.state = {
      openPositions: [],
      dailyLoss: 0,
      dailyProfit: 0,
      dayStart: this.startOfDay(),
      totalExposure: 0,
      consecutiveLosses: 0,
      cooldownUntil: 0,
      emergencyStopped: false,
    };

    this.bindEvents();
  }

  setAgentLimits(agentId: string, limits: AgentRiskLimits): void {
    this.agentLimits.set(agentId, limits);
  }

  validateIntent(intent: TradeIntent): { approved: boolean; reason?: string } {
    this.resetDayIfNeeded();

    if (this.state.emergencyStopped) {
      return { approved: false, reason: 'Emergency stop active. Manual reset required.' };
    }

    if (this.state.cooldownUntil > Date.now()) {
      const remaining = Math.ceil((this.state.cooldownUntil - Date.now()) / 1000);
      return { approved: false, reason: `Cooldown active. ${remaining}s remaining.` };
    }

    if (intent.action === 'buy') {
      return this.validateBuy(intent);
    }

    // Sells are generally allowed (closing risk)
    return { approved: true };
  }

  private validateBuy(intent: TradeIntent): { approved: boolean; reason?: string } {
    const amount = intent.amountSol || 0;
    const limits = this.getEffectiveLimits(intent.agentId);

    // Position size check
    if (amount > limits.maxPositionSol) {
      this.emitLimitHit('position_size', amount, limits.maxPositionSol);
      return {
        approved: false,
        reason: `Position ${amount} SOL exceeds max ${limits.maxPositionSol} SOL`,
      };
    }

    // Open positions check
    if (this.state.openPositions.length >= limits.maxOpenPositions) {
      this.emitLimitHit('open_positions', this.state.openPositions.length, limits.maxOpenPositions);
      return {
        approved: false,
        reason: `Max open positions (${limits.maxOpenPositions}) reached`,
      };
    }

    // Daily loss check
    if (this.state.dailyLoss >= limits.maxDailyLossSol) {
      this.emitLimitHit('daily_loss', this.state.dailyLoss, limits.maxDailyLossSol);
      return {
        approved: false,
        reason: `Daily loss limit (${limits.maxDailyLossSol} SOL) reached`,
      };
    }

    // Total exposure check
    const newExposure = this.state.totalExposure + amount;
    const maxExposure = limits.maxPositionSol * limits.maxOpenPositions;
    if (newExposure > maxExposure) {
      this.emitLimitHit('total_exposure', newExposure, maxExposure);
      return {
        approved: false,
        reason: `Total exposure ${newExposure} SOL exceeds limit ${maxExposure} SOL`,
      };
    }

    // Emergency stop loss
    const totalLoss = this.state.dailyLoss;
    if (totalLoss >= this.globalLimits.emergencyStopLossSol) {
      this.state.emergencyStopped = true;
      this.eventBus.emit('risk:emergency', {
        reason: `Emergency stop: total loss ${totalLoss} SOL >= ${this.globalLimits.emergencyStopLossSol} SOL`,
      });
      return {
        approved: false,
        reason: 'Emergency stop loss triggered',
      };
    }

    return { approved: true };
  }

  updatePosition(position: Position): void {
    const idx = this.state.openPositions.findIndex(p => p.mint === position.mint);
    if (idx >= 0) {
      this.state.openPositions[idx] = position;
    } else {
      this.state.openPositions.push(position);
    }
    this.recalcExposure();
  }

  closePosition(mint: string, pnl: number): void {
    this.state.openPositions = this.state.openPositions.filter(p => p.mint !== mint);

    if (pnl < 0) {
      this.state.dailyLoss += Math.abs(pnl);
      this.state.consecutiveLosses++;

      const threshold = this.globalLimits.lossStreakThreshold ?? 3;
      const cooldown = this.globalLimits.cooldownAfterLossStreak ?? 300_000;

      if (this.state.consecutiveLosses >= threshold) {
        this.state.cooldownUntil = Date.now() + cooldown;
        this.logger.warn(`Loss streak ${this.state.consecutiveLosses} — cooldown ${cooldown / 1000}s`);
        this.eventBus.emit('risk:cooldown', {
          until: this.state.cooldownUntil,
          reason: `${this.state.consecutiveLosses} consecutive losses`,
        });
      }
    } else {
      this.state.dailyProfit += pnl;
      this.state.consecutiveLosses = 0;
    }

    this.recalcExposure();
  }

  getOpenPositions(): Position[] {
    return [...this.state.openPositions];
  }

  getExposure(): number {
    return this.state.totalExposure;
  }

  getDailyPnl(): { profit: number; loss: number; net: number } {
    return {
      profit: this.state.dailyProfit,
      loss: this.state.dailyLoss,
      net: this.state.dailyProfit - this.state.dailyLoss,
    };
  }

  isEmergencyStopped(): boolean {
    return this.state.emergencyStopped;
  }

  resetEmergencyStop(): void {
    this.state.emergencyStopped = false;
    this.state.consecutiveLosses = 0;
    this.state.cooldownUntil = 0;
    this.logger.info('Emergency stop reset');
  }

  private getEffectiveLimits(agentId: string): AgentRiskLimits {
    const agentLimits = this.agentLimits.get(agentId);
    if (!agentLimits) return this.globalLimits;

    return {
      maxPositionSol: Math.min(agentLimits.maxPositionSol, this.globalLimits.maxPositionSol),
      maxOpenPositions: Math.min(agentLimits.maxOpenPositions, this.globalLimits.maxOpenPositions),
      maxDailyLossSol: Math.min(agentLimits.maxDailyLossSol, this.globalLimits.maxDailyLossSol),
      maxDrawdownPercent: Math.min(agentLimits.maxDrawdownPercent, this.globalLimits.maxDrawdownPercent),
    };
  }

  private recalcExposure(): void {
    this.state.totalExposure = this.state.openPositions.reduce(
      (sum, p) => sum + p.amountSolInvested,
      0
    );
  }

  private emitLimitHit(type: string, current: number, max: number): void {
    this.logger.warn(`Risk limit: ${type} (${current} / ${max})`);
    this.eventBus.emit('risk:limit', { type, current, max });
  }

  private bindEvents(): void {
    this.eventBus.on('position:opened', (pos) => this.updatePosition(pos));
    this.eventBus.on('position:updated', (pos) => {
      this.updatePosition(pos);
      this.checkPositionStopLoss(pos);
    });
    this.eventBus.on('position:closed', ({ mint, pnl }) => this.closePosition(mint, pnl));
  }

  // =====================================================
  // Per-position stop-loss & time-based exit
  // =====================================================

  private positionStopLossPct = 50;      // -50% = hard stop
  private positionMaxHoldMinutes = 45;   // No growth in 45min = exit
  private positionMinGrowthPct = 5;      // Minimum growth to keep alive

  setPositionLimits(opts: {
    stopLossPct?: number;
    maxHoldMinutes?: number;
    minGrowthPct?: number;
  }): void {
    if (opts.stopLossPct !== undefined) this.positionStopLossPct = opts.stopLossPct;
    if (opts.maxHoldMinutes !== undefined) this.positionMaxHoldMinutes = opts.maxHoldMinutes;
    if (opts.minGrowthPct !== undefined) this.positionMinGrowthPct = opts.minGrowthPct;
  }

  private checkPositionStopLoss(pos: Position): void {
    // Per-position hard stop-loss
    if (pos.unrealizedPnlPercent <= -this.positionStopLossPct) {
      this.logger.warn(`Position SL: ${pos.symbol} at ${pos.unrealizedPnlPercent.toFixed(1)}% (limit: -${this.positionStopLossPct}%)`);
      this.eventBus.emit('signal:sell', {
        mint: pos.mint,
        reason: `Per-position stop-loss: ${pos.unrealizedPnlPercent.toFixed(1)}% loss`,
        urgency: 'high',
        agentId: 'risk-manager',
      });
    }

    // Time-based exit: position held too long without growth
    const holdMinutes = (Date.now() - pos.openedAt) / 60_000;
    if (holdMinutes >= this.positionMaxHoldMinutes && pos.unrealizedPnlPercent < this.positionMinGrowthPct) {
      this.logger.warn(`Position time decay: ${pos.symbol} held ${holdMinutes.toFixed(0)}min with ${pos.unrealizedPnlPercent.toFixed(1)}% growth`);
      this.eventBus.emit('signal:sell', {
        mint: pos.mint,
        reason: `Time decay: ${holdMinutes.toFixed(0)}min hold, only ${pos.unrealizedPnlPercent.toFixed(1)}% growth`,
        urgency: 'medium',
        agentId: 'risk-manager',
      });
    }
  }

  private resetDayIfNeeded(): void {
    const today = this.startOfDay();
    if (today !== this.state.dayStart) {
      this.state.dayStart = today;
      this.state.dailyLoss = 0;
      this.state.dailyProfit = 0;
    }
  }

  private startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
