import {
  TradeIntent,
  EventBusInterface,
  LoggerInterface,
  AgentRiskLimits,
} from '../types';

// =====================================================
// AutoApprove — Configurable auto-approval for trade intents
// =====================================================
//
// Like Copilot's auto-approve for tool calls:
// - "off"         → Every trade needs manual approval
// - "conservative"→ Auto-approve only reads + sells (profit-taking)
// - "moderate"    → Auto-approve buys within safe thresholds
// - "aggressive"  → Auto-approve everything within risk limits
// - "full"        → Auto-approve ALL (like autopilot, no RiskManager gate)
//
// Each level has configurable thresholds. The system integrates with
// RiskManager: AutoApprove decides WHETHER to auto-approve, then
// RiskManager still validates limits (position size, daily loss, etc.)

export type AutoApproveLevel = 'off' | 'conservative' | 'moderate' | 'aggressive' | 'full';

export interface AutoApproveRule {
  action: 'buy' | 'sell' | '*';
  maxAmountSol?: number;          // Max SOL per auto-approved trade
  maxSlippageBps?: number;        // Max slippage to auto-approve
  requireRiskCheck: boolean;      // Still run through RiskManager?
  requireSecurityCheck?: boolean; // Require token-security audit pass?
  maxOpenPositions?: number;      // Don't auto-approve if >= N open
  cooldownMs?: number;            // Min time between auto-approvals
  allowedAgents?: string[];       // Only auto-approve from these agents
  blockedMints?: string[];        // Never auto-approve these tokens
}

export interface AutoApproveConfig {
  level: AutoApproveLevel;
  rules: AutoApproveRule[];
  globalMaxDailyAutoApproved: number;  // Max auto-approved trades per day
  globalMaxAutoApprovedSol: number;    // Max total SOL auto-approved per day
  notifyOnAutoApprove: boolean;        // Emit notification events
  logAll: boolean;                     // Log every decision to audit trail
}

interface AutoApproveState {
  dailyAutoApproved: number;
  dailyAutoApprovedSol: number;
  lastAutoApproveAt: number;
  dayStart: number;
  auditTrail: AuditEntry[];
}

interface AuditEntry {
  timestamp: number;
  intentId: string;
  action: 'buy' | 'sell';
  mint: string;
  amountSol: number;
  decision: 'auto_approved' | 'pending_manual' | 'auto_rejected';
  reason: string;
  level: AutoApproveLevel;
}

// =====================================================
// Preset configurations for each auto-approve level
// =====================================================

const PRESETS: Record<AutoApproveLevel, AutoApproveConfig> = {
  off: {
    level: 'off',
    rules: [],
    globalMaxDailyAutoApproved: 0,
    globalMaxAutoApprovedSol: 0,
    notifyOnAutoApprove: false,
    logAll: true,
  },

  conservative: {
    level: 'conservative',
    rules: [
      {
        action: 'sell',
        requireRiskCheck: true,
        maxSlippageBps: 500,
      },
    ],
    globalMaxDailyAutoApproved: 50,
    globalMaxAutoApprovedSol: 100,
    notifyOnAutoApprove: true,
    logAll: true,
  },

  moderate: {
    level: 'moderate',
    rules: [
      {
        action: 'sell',
        requireRiskCheck: true,
      },
      {
        action: 'buy',
        maxAmountSol: 0.1,
        maxSlippageBps: 300,
        requireRiskCheck: true,
        requireSecurityCheck: true,
        maxOpenPositions: 5,
        cooldownMs: 30_000,
      },
    ],
    globalMaxDailyAutoApproved: 30,
    globalMaxAutoApprovedSol: 5,
    notifyOnAutoApprove: true,
    logAll: true,
  },

  aggressive: {
    level: 'aggressive',
    rules: [
      {
        action: '*',
        maxAmountSol: 0.5,
        maxSlippageBps: 500,
        requireRiskCheck: true,
        cooldownMs: 10_000,
      },
    ],
    globalMaxDailyAutoApproved: 100,
    globalMaxAutoApprovedSol: 20,
    notifyOnAutoApprove: true,
    logAll: true,
  },

  full: {
    level: 'full',
    rules: [
      {
        action: '*',
        requireRiskCheck: true,  // Still validate risk limits
      },
    ],
    globalMaxDailyAutoApproved: 999,
    globalMaxAutoApprovedSol: 999,
    notifyOnAutoApprove: false,
    logAll: true,
  },
};

export class AutoApproveManager {
  private config: AutoApproveConfig;
  private state: AutoApproveState;
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private openPositionCount = 0;

  // Pluggable security check callback
  private securityChecker?: (mint: string) => Promise<{ passed: boolean; score: number }>;

  // Pluggable risk check callback (from RiskManager)
  private riskChecker?: (intent: TradeIntent) => { approved: boolean; reason?: string };

  constructor(
    eventBus: EventBusInterface,
    logger: LoggerInterface,
    level: AutoApproveLevel = 'off',
  ) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.config = { ...PRESETS[level] };
    this.state = {
      dailyAutoApproved: 0,
      dailyAutoApprovedSol: 0,
      lastAutoApproveAt: 0,
      dayStart: this.startOfDay(),
      auditTrail: [],
    };

    this.bindEvents();
  }

  // =====================================================
  // Core: evaluate trade intent
  // =====================================================

  async evaluate(intent: TradeIntent): Promise<{
    autoApproved: boolean;
    requiresManual: boolean;
    reason: string;
  }> {
    this.resetDayIfNeeded();

    // Level: off → always manual
    if (this.config.level === 'off') {
      this.audit(intent, 'pending_manual', 'Auto-approve is OFF');
      return { autoApproved: false, requiresManual: true, reason: 'Auto-approve disabled' };
    }

    // Global daily limits
    if (this.state.dailyAutoApproved >= this.config.globalMaxDailyAutoApproved) {
      this.audit(intent, 'pending_manual', 'Daily auto-approve count limit reached');
      return { autoApproved: false, requiresManual: true, reason: 'Daily auto-approve limit reached' };
    }

    const amount = intent.amountSol || 0;
    if (this.state.dailyAutoApprovedSol + amount > this.config.globalMaxAutoApprovedSol) {
      this.audit(intent, 'pending_manual', 'Daily auto-approve SOL limit');
      return { autoApproved: false, requiresManual: true, reason: 'Daily SOL auto-approve limit' };
    }

    // Find matching rule
    const rule = this.config.rules.find(r =>
      r.action === '*' || r.action === intent.action
    );

    if (!rule) {
      this.audit(intent, 'pending_manual', 'No matching auto-approve rule');
      return { autoApproved: false, requiresManual: true, reason: 'No matching rule' };
    }

    // Rule checks
    if (rule.maxAmountSol !== undefined && amount > rule.maxAmountSol) {
      this.audit(intent, 'pending_manual', `Amount ${amount} > max ${rule.maxAmountSol}`);
      return { autoApproved: false, requiresManual: true, reason: `Amount exceeds auto-approve limit (${rule.maxAmountSol} SOL)` };
    }

    if (rule.maxSlippageBps !== undefined && intent.slippageBps > rule.maxSlippageBps) {
      this.audit(intent, 'pending_manual', `Slippage ${intent.slippageBps} > max ${rule.maxSlippageBps}`);
      return { autoApproved: false, requiresManual: true, reason: `Slippage exceeds auto-approve limit` };
    }

    if (rule.maxOpenPositions !== undefined && this.openPositionCount >= rule.maxOpenPositions) {
      this.audit(intent, 'pending_manual', `Open positions ${this.openPositionCount} >= max ${rule.maxOpenPositions}`);
      return { autoApproved: false, requiresManual: true, reason: 'Too many open positions for auto-approve' };
    }

    if (rule.cooldownMs !== undefined) {
      const elapsed = Date.now() - this.state.lastAutoApproveAt;
      if (elapsed < rule.cooldownMs) {
        this.audit(intent, 'pending_manual', `Cooldown: ${elapsed}ms < ${rule.cooldownMs}ms`);
        return { autoApproved: false, requiresManual: true, reason: 'Auto-approve cooldown active' };
      }
    }

    if (rule.allowedAgents && !rule.allowedAgents.includes(intent.agentId)) {
      this.audit(intent, 'pending_manual', `Agent ${intent.agentId} not in allowed list`);
      return { autoApproved: false, requiresManual: true, reason: 'Agent not authorized for auto-approve' };
    }

    if (rule.blockedMints?.includes(intent.mint)) {
      this.audit(intent, 'auto_rejected', `Mint ${intent.mint.slice(0, 8)} is blocked`);
      return { autoApproved: false, requiresManual: false, reason: 'Token is blocked from auto-approve' };
    }

    // Security check (if required and checker is available)
    if (rule.requireSecurityCheck && this.securityChecker && intent.action === 'buy') {
      const security = await this.securityChecker(intent.mint);
      if (!security.passed) {
        this.audit(intent, 'auto_rejected', `Security check failed: score ${security.score}`);
        return { autoApproved: false, requiresManual: false, reason: `Token failed security check (score: ${security.score})` };
      }
    }

    // Risk check (still validates position size, daily loss, etc.)
    if (rule.requireRiskCheck && this.riskChecker) {
      const riskResult = this.riskChecker(intent);
      if (!riskResult.approved) {
        this.audit(intent, 'auto_rejected', `Risk check failed: ${riskResult.reason}`);
        return { autoApproved: false, requiresManual: false, reason: riskResult.reason || 'Risk check failed' };
      }
    }

    // All checks passed → auto-approve
    this.state.dailyAutoApproved++;
    this.state.dailyAutoApprovedSol += amount;
    this.state.lastAutoApproveAt = Date.now();

    this.audit(intent, 'auto_approved', `Level: ${this.config.level}`);

    if (this.config.notifyOnAutoApprove) {
      this.eventBus.emit('trade:approved', { intentId: intent.id });
      this.logger.trade(`AUTO-APPROVED [${this.config.level}]: ${intent.action} ${amount} SOL → ${intent.mint.slice(0, 8)}... | ${intent.reason}`);
    }

    return { autoApproved: true, requiresManual: false, reason: `Auto-approved (${this.config.level})` };
  }

  // =====================================================
  // Configuration
  // =====================================================

  setLevel(level: AutoApproveLevel): void {
    this.config = { ...PRESETS[level] };
    this.logger.info(`Auto-approve level set to: ${level}`);
  }

  getLevel(): AutoApproveLevel {
    return this.config.level;
  }

  setCustomConfig(config: Partial<AutoApproveConfig>): void {
    Object.assign(this.config, config);
  }

  setCustomRules(rules: AutoApproveRule[]): void {
    this.config.rules = rules;
  }

  setSecurityChecker(checker: (mint: string) => Promise<{ passed: boolean; score: number }>): void {
    this.securityChecker = checker;
  }

  setRiskChecker(checker: (intent: TradeIntent) => { approved: boolean; reason?: string }): void {
    this.riskChecker = checker;
  }

  // =====================================================
  // Status & audit
  // =====================================================

  getStatus(): {
    level: AutoApproveLevel;
    dailyAutoApproved: number;
    dailyAutoApprovedSol: number;
    dailyLimit: number;
    dailySolLimit: number;
    lastAutoApproveAt: number;
    openPositions: number;
    recentAudit: AuditEntry[];
  } {
    return {
      level: this.config.level,
      dailyAutoApproved: this.state.dailyAutoApproved,
      dailyAutoApprovedSol: this.state.dailyAutoApprovedSol,
      dailyLimit: this.config.globalMaxDailyAutoApproved,
      dailySolLimit: this.config.globalMaxAutoApprovedSol,
      lastAutoApproveAt: this.state.lastAutoApproveAt,
      openPositions: this.openPositionCount,
      recentAudit: this.state.auditTrail.slice(-20),
    };
  }

  getAuditTrail(limit = 50): AuditEntry[] {
    return this.state.auditTrail.slice(-limit);
  }

  // =====================================================
  // Internal
  // =====================================================

  private bindEvents(): void {
    this.eventBus.on('position:opened', () => { this.openPositionCount++; });
    this.eventBus.on('position:closed', () => { this.openPositionCount = Math.max(0, this.openPositionCount - 1); });
  }

  private audit(intent: TradeIntent, decision: AuditEntry['decision'], reason: string): void {
    const entry: AuditEntry = {
      timestamp: Date.now(),
      intentId: intent.id,
      action: intent.action,
      mint: intent.mint,
      amountSol: intent.amountSol || 0,
      decision,
      reason,
      level: this.config.level,
    };

    this.state.auditTrail.push(entry);

    // Keep audit trail bounded
    if (this.state.auditTrail.length > 500) {
      this.state.auditTrail = this.state.auditTrail.slice(-300);
    }

    if (this.config.logAll && this.logger) {
      this.logger.debug(`AutoApprove [${decision}]: ${intent.action} ${intent.amountSol || 0} SOL → ${intent.mint.slice(0, 8)}... | ${reason}`);
    }
  }

  private resetDayIfNeeded(): void {
    const todayStart = this.startOfDay();
    if (todayStart > this.state.dayStart) {
      this.state.dailyAutoApproved = 0;
      this.state.dailyAutoApprovedSol = 0;
      this.state.dayStart = todayStart;
    }
  }

  private startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
