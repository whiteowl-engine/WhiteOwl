/**
 * Multi-Agent Coordinator — Phase 4
 *
 * Specialized agents communicate through a shared message bus:
 * - Scanner Agent: monitors new tokens, feeds alpha
 * - Risk Analyst Agent: evaluates exposure, recommends exits
 * - Sentiment Agent: processes social signals, KOL mentions
 * - Commander Agent: receives all agent intel, makes final decisions
 *
 * Agents publish typed messages on the event bus. The coordinator
 * manages agent lifecycles and routes inter-agent communication.
 */

import {
  AgentConfig, AgentState, EventBusInterface, LoggerInterface,
  LLMProvider, AutonomyLevel, ModelConfig,
} from '../types';
import { AgentRunner } from './agent-runner';
import { SkillLoader } from './skill-loader';
import { MarketStateBuilder } from './market-state';
import { getLLMProvider, getLLMProviderWithFallback } from '../llm';

// ----- Inter-agent message protocol -----

export interface AgentMessage {
  from: string;
  to: string | 'broadcast';
  type: 'intel' | 'alert' | 'request' | 'response' | 'directive';
  payload: Record<string, any>;
  timestamp: number;
  priority: 'low' | 'normal' | 'high' | 'critical';
}

export interface AgentRole {
  id: string;
  name: string;
  specialty: string;
  skills: string[];
  triggers: Array<{ event: string; action: string; filter?: Record<string, any> }>;
  systemPrompt: string;
}

// ----- Predefined agent roles -----

export const AGENT_ROLES: Record<string, AgentRole> = {
  scanner: {
    id: 'agent_scanner',
    name: 'Scanner Agent',
    specialty: 'Token discovery and alpha extraction',
    skills: ['pump-monitor', 'alpha-scanner', 'dex-screener', 'trend-sniper'],
    triggers: [
      { event: 'token:new', action: 'evaluate_token' },
      { event: 'narrative:hot', action: 'narrative_alert' },
    ],
    systemPrompt: `You are the Scanner Agent for WhiteOwl. Your job:
1. Monitor new pump.fun tokens and DexScreener trends
2. Extract alpha from social channels (Telegram, Twitter)
3. Identify narrative-matching tokens before others
4. Report promising finds to the Commander with confidence score
Always be concise. Report: token mint, name, why it's interesting, confidence (1-10).`,
  },

  risk: {
    id: 'agent_risk',
    name: 'Risk Analyst',
    specialty: 'Portfolio risk assessment and exposure management',
    skills: ['portfolio', 'token-analyzer', 'fast-sniper'],
    triggers: [
      { event: 'position:opened', action: 'assess_new_position' },
      { event: 'position:updated', action: 'check_risk' },
      { event: 'signal:rug', action: 'emergency_review' },
    ],
    systemPrompt: `You are the Risk Analyst for WhiteOwl. Your job:
1. Continuously evaluate portfolio exposure and concentration
2. Monitor open positions for red flags (rug signals, volume drops)
3. Recommend exits (stop-loss, take-profit) based on risk/reward
4. Alert Commander on high-risk situations immediately
Be conservative. Capital preservation > profit maximization.`,
  },

  sentiment: {
    id: 'agent_sentiment',
    name: 'Sentiment Analyst',
    specialty: 'Social sentiment and KOL signal processing',
    skills: ['social-monitor', 'alpha-scanner'],
    triggers: [
      { event: 'signal:buy', action: 'verify_sentiment' },
    ],
    systemPrompt: `You are the Sentiment Analyst for WhiteOwl. Your job:
1. Process KOL activity and social media mentions
2. Score sentiment around tokens (bullish/bearish/neutral)
3. Identify coordinated shill campaigns vs organic interest
4. Report sentiment changes to Commander
Focus on signal quality. KOL with history of good calls > random mentions.`,
  },

  commander: {
    id: 'agent_commander',
    name: 'Commander',
    specialty: 'Strategic decision making and agent coordination',
    skills: ['fast-sniper', 'portfolio', 'pump-trader', 'advanced-trader'],
    triggers: [
      { event: 'periodic', action: 'strategic_review', filter: { intervalMs: 10000 } },
    ],
    systemPrompt: `You are the Commander Agent for WhiteOwl — the strategic brain. Your job:
1. Receive intel from Scanner, Risk, and Sentiment agents
2. Make final buy/sell decisions based on aggregated intelligence
3. Adjust pipeline parameters (thresholds, weights) based on market conditions
4. Manage overall portfolio strategy (aggressive/defensive)
You see the big picture. Individual agents report to you. Only you execute trades.`,
  },
};

// ----- Multi-Agent Coordinator -----

export class MultiAgentCoordinator {
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private skillLoader: SkillLoader;
  private marketState: MarketStateBuilder;

  private agents = new Map<string, AgentRunner>();
  private messageLog: AgentMessage[] = [];
  private readonly MAX_LOG = 200;

  constructor(opts: {
    eventBus: EventBusInterface;
    logger: LoggerInterface;
    skillLoader: SkillLoader;
    marketState: MarketStateBuilder;
  }) {
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.skillLoader = opts.skillLoader;
    this.marketState = opts.marketState;
  }

  /**
   * Create and register a specialized sub-agent.
   */
  addAgent(role: AgentRole, model: ModelConfig, fallbackModels?: ModelConfig[], autonomy: AutonomyLevel = 'autopilot'): void {
    const config: AgentConfig = {
      id: role.id,
      name: role.name,
      role: role.systemPrompt,
      model,
      fallbackModels,
      skills: role.skills,
      autonomy,
      riskLimits: {
        maxPositionSol: role.id === 'agent_commander' ? 1 : 0.1,
        maxOpenPositions: role.id === 'agent_commander' ? 10 : 0,
        maxDailyLossSol: role.id === 'agent_commander' ? 5 : 0,
        maxDrawdownPercent: 30,
      },
      triggers: role.triggers.map(t => ({
        event: t.event,
        action: t.action,
        filter: t.filter,
      })),
    };

    const llm = fallbackModels?.length
      ? getLLMProviderWithFallback([model, ...fallbackModels])
      : getLLMProvider(model);

    const runner = new AgentRunner({
      config,
      llm,
      skills: this.skillLoader,
      eventBus: this.eventBus,
      logger: this.logger,
      marketState: this.marketState,
    });

    this.agents.set(role.id, runner);
    this.logger.info(`Multi-agent: registered ${role.name} (${role.specialty})`);
  }

  /**
   * Boot all predefined agents with a shared model config.
   */
  bootAll(model: ModelConfig, fallbackModels?: ModelConfig[]): void {
    for (const role of Object.values(AGENT_ROLES)) {
      this.addAgent(role, model, fallbackModels);
    }
    this.logger.info(`Multi-agent: ${this.agents.size} agents ready`);
  }

  /**
   * Send a typed message between agents.
   */
  sendMessage(msg: AgentMessage): void {
    this.messageLog.push(msg);
    if (this.messageLog.length > this.MAX_LOG) {
      this.messageLog = this.messageLog.slice(-this.MAX_LOG);
    }

    this.logger.debug(`Agent msg: ${msg.from} → ${msg.to} [${msg.type}] ${JSON.stringify(msg.payload).slice(0, 100)}`);

    // Route to target agent(s)
    if (msg.to === 'broadcast') {
      for (const [id, agent] of this.agents) {
        if (id !== msg.from) {
          agent.handleEvent(`agent_msg:${msg.type}`, msg.payload).catch(() => {});
        }
      }
    } else {
      const target = this.agents.get(msg.to);
      if (target) {
        target.handleEvent(`agent_msg:${msg.type}`, msg.payload).catch(() => {});
      }
    }
  }

  startAll(): void {
    for (const [, agent] of this.agents) {
      agent.start();
    }
    this.setupInterAgentRouting();
    this.logger.info('Multi-agent: all agents started');
  }

  stopAll(): void {
    for (const [, agent] of this.agents) {
      agent.stop();
    }
    this.logger.info('Multi-agent: all agents stopped');
  }

  getAgentStates(): AgentState[] {
    return Array.from(this.agents.values()).map(a => a.getState());
  }

  getMessageLog(limit: number = 50): AgentMessage[] {
    return this.messageLog.slice(-limit);
  }

  /**
   * Wire up automatic inter-agent communication:
   * - Scanner findings → Commander
   * - Risk alerts → Commander
   * - Sentiment scores → Commander
   */
  private setupInterAgentRouting(): void {
    // Scanner → broadcast intel on new signals
    this.eventBus.on('signal:buy', (data) => {
      this.sendMessage({
        from: 'agent_scanner',
        to: 'agent_commander',
        type: 'intel',
        payload: { signal: 'buy', mint: data.mint, score: data.score, reason: data.reason },
        timestamp: Date.now(),
        priority: data.score > 80 ? 'high' : 'normal',
      });
    });

    // Risk → alert commander on rug detection
    this.eventBus.on('signal:rug', (data) => {
      this.sendMessage({
        from: 'agent_risk',
        to: 'agent_commander',
        type: 'alert',
        payload: { signal: 'rug', mint: data.mint, indicators: data.indicators, confidence: data.confidence },
        timestamp: Date.now(),
        priority: data.confidence > 0.8 ? 'critical' : 'high',
      });
    });

    // Narrative → sentiment + commander
    this.eventBus.on('narrative:hot', (data) => {
      this.sendMessage({
        from: 'agent_scanner',
        to: 'broadcast',
        type: 'intel',
        payload: { signal: 'narrative', keywords: data.keywords },
        timestamp: Date.now(),
        priority: 'high',
      });
    });
  }
}
