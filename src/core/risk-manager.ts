import {
  AgentRiskLimits,
  TradeIntent,
  Position,
  LoggerInterface,
  EventBusInterface,
} from '../types.ts';

interface RiskState {
  openPositions: Position[];
  dailyLoss: number;
  dailyProfit: number;
  dayStart: number;
  totalExposure: number;
  consecutiveLosses: number;
  cooldownUntil: number;
  emergencyStopped: boolean;

  announcementTradesToday: number;
  announcementExposureSol: number;
  announcementDayStart: number;
}

export interface AnnouncementRiskLimits {
  maxAnnouncementTradesPerDay: number;
  maxAnnouncementExposureSol: number;
  announcementStopLossPercent: number;
}

const DEFAULT_ANNOUNCEMENT_LIMITS: AnnouncementRiskLimits = {
  maxAnnouncementTradesPerDay: 5,
  maxAnnouncementExposureSol: 2.0,
  announcementStopLossPercent: 30,
};

export class RiskManager {
  private globalLimits: AgentRiskLimits & { emergencyStopLossSol: number };
  private agentLimits = new Map<string, AgentRiskLimits>();
  private announcementLimits: AnnouncementRiskLimits = { ...DEFAULT_ANNOUNCEMENT_LIMITS };
  private announcementMints = new Set<string>();
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
      announcementTradesToday: 0,
      announcementExposureSol: 0,
      announcementDayStart: this.startOfDay(),
    };

    this.bindEvents();
  }

  setAgentLimits(agentId: string, limits: AgentRiskLimits): void {
    this.agentLimits.set(agentId, limits);
  }

  setAnnouncementLimits(limits: Partial<AnnouncementRiskLimits>): void {
    this.announcementLimits = { ...this.announcementLimits, ...limits };
    this.logger.info(
      `[Risk] Announcement limits: ${this.announcementLimits.maxAnnouncementTradesPerDay}/day, ` +
        `${this.announcementLimits.maxAnnouncementExposureSol} SOL exposure, ` +
        `${this.announcementLimits.announcementStopLossPercent}% SL`
    );
  }

  getAnnouncementLimits(): AnnouncementRiskLimits {
    return { ...this.announcementLimits };
  }

  getAnnouncementState(): { tradesToday: number; exposureSol: number; trackedMints: number } {
    this.resetAnnouncementDayIfNeeded();
    return {
      tradesToday: this.state.announcementTradesToday,
      exposureSol: this.state.announcementExposureSol,
      trackedMints: this.announcementMints.size,
    };
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


    return { approved: true };
  }

  private validateBuy(intent: TradeIntent): { approved: boolean; reason?: string } {
    const amount = intent.amountSol || 0;
    const limits = this.getEffectiveLimits(intent.agentId);

    const isAnnouncement =
      intent.origin === 'announcement' ||
      intent.agentId === 'announcement-sniper' ||
      (intent.tags || []).includes('announcement');
    if (isAnnouncement) {
      const annCheck = this.validateAnnouncementBuy(amount);
      if (!annCheck.approved) return annCheck;
    }


    if (amount > limits.maxPositionSol) {
      this.emitLimitHit('position_size', amount, limits.maxPositionSol);
      return {
        approved: false,
        reason: `Position ${amount} SOL exceeds max ${limits.maxPositionSol} SOL`,
      };
    }


    if (this.state.openPositions.length >= limits.maxOpenPositions) {
      this.emitLimitHit('open_positions', this.state.openPositions.length, limits.maxOpenPositions);
      return {
        approved: false,
        reason: `Max open positions (${limits.maxOpenPositions}) reached`,
      };
    }


    if (this.state.dailyLoss >= limits.maxDailyLossSol) {
      this.emitLimitHit('daily_loss', this.state.dailyLoss, limits.maxDailyLossSol);
      return {
        approved: false,
        reason: `Daily loss limit (${limits.maxDailyLossSol} SOL) reached`,
      };
    }


    const newExposure = this.state.totalExposure + amount;
    const maxExposure = limits.maxPositionSol * limits.maxOpenPositions;
    if (newExposure > maxExposure) {
      this.emitLimitHit('total_exposure', newExposure, maxExposure);
      return {
        approved: false,
        reason: `Total exposure ${newExposure} SOL exceeds limit ${maxExposure} SOL`,
      };
    }


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
    this.announcementMints.delete(mint);

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

  markMintAsAnnouncement(mint: string): void {
    this.announcementMints.add(mint);
  }

  isAnnouncementMint(mint: string): boolean {
    return this.announcementMints.has(mint);
  }

  getAnnouncementStopLossPercent(): number {
    return this.announcementLimits.announcementStopLossPercent;
  }

  private validateAnnouncementBuy(amount: number): { approved: boolean; reason?: string } {
    this.resetAnnouncementDayIfNeeded();
    const lim = this.announcementLimits;
    if (this.state.announcementTradesToday >= lim.maxAnnouncementTradesPerDay) {
      this.emitLimitHit(
        'announcement_daily_trades',
        this.state.announcementTradesToday,
        lim.maxAnnouncementTradesPerDay
      );
      return {
        approved: false,
        reason: `Announcement daily trade cap (${lim.maxAnnouncementTradesPerDay}) reached`,
      };
    }
    if (this.state.announcementExposureSol + amount > lim.maxAnnouncementExposureSol) {
      this.emitLimitHit(
        'announcement_exposure',
        this.state.announcementExposureSol + amount,
        lim.maxAnnouncementExposureSol
      );
      return {
        approved: false,
        reason: `Announcement exposure ${(this.state.announcementExposureSol + amount).toFixed(2)} SOL exceeds limit ${lim.maxAnnouncementExposureSol} SOL`,
      };
    }
    return { approved: true };
  }

  recordAnnouncementTrade(mint: string, amountSol: number): void {
    this.resetAnnouncementDayIfNeeded();
    this.announcementMints.add(mint);
    this.state.announcementTradesToday++;
    this.state.announcementExposureSol += amountSol;
  }

  private resetAnnouncementDayIfNeeded(): void {
    const today = this.startOfDay();
    if (today > this.state.announcementDayStart) {
      this.state.announcementDayStart = today;
      this.state.announcementTradesToday = 0;
    }
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
    this.state.announcementExposureSol = this.state.openPositions
      .filter(p => this.announcementMints.has(p.mint))
      .reduce((sum, p) => sum + p.amountSolInvested, 0);
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
    this.eventBus.on('announcement:detected' as any, (det: any) => {
      if (det?.mint && typeof det.mint === 'string' && det.score >= 85) {
        this.announcementMints.add(det.mint);
      }
    });
  }


  private positionStopLossPct = 50;
  private positionMaxHoldMinutes = 45;
  private positionMinGrowthPct = 5;

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

    if (pos.unrealizedPnlPercent <= -this.positionStopLossPct) {
      this.logger.warn(`Position SL: ${pos.symbol} at ${pos.unrealizedPnlPercent.toFixed(1)}% (limit: -${this.positionStopLossPct}%)`);
      this.eventBus.emit('signal:sell', {
        mint: pos.mint,
        reason: `Per-position stop-loss: ${pos.unrealizedPnlPercent.toFixed(1)}% loss`,
        urgency: 'high',
        agentId: 'risk-manager',
      });
    }


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
