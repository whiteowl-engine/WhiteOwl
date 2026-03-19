import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  AppConfig,
  ModelConfig,
  AgentConfig,
  TradingSession,
  AutonomyLevel,
  SessionStats,
  AgentState,
  Position,
  StrategyConfig,
} from './types';
import { EventBus } from './core/event-bus';
import { SkillLoader } from './core/skill-loader';
import { AgentRunner } from './core/agent-runner';
import { RiskManager } from './core/risk-manager';
import { StrategyEngine } from './core/strategy';
import { Scheduler } from './core/scheduler';
import { MarketStateBuilder } from './core/market-state';
import { getLLMProvider, getLLMProviderWithFallback } from './llm';
import { Memory, createDatabase, initDatabaseEngine, ContextualMemory } from './memory';
import { SolanaWallet } from './wallet/solana';
import { getAllSkills } from './skills';
import { Logger } from './logger';
import { MultiAgentCoordinator } from './core/multi-agent';
import { DecisionExplainer, DailyReportGenerator } from './core/decision-engine';
import { MetricsCollector, BackupManager } from './core/metrics';
import { PrivacyGuard, PrivacyConfig } from './core/privacy-guard';
import { AutoApproveManager, AutoApproveLevel } from './core/auto-approve';
import { OAuthManager } from './core/oauth-manager';
import { setOAuthManager } from './llm/providers';
import { BrowserService } from './core/browser';

export class Runtime {
  private config: AppConfig;
  private logger: Logger;
  private eventBus: EventBus;
  private skillLoader: SkillLoader;
  private agents = new Map<string, AgentRunner>();
  private riskManager: RiskManager;
  private strategyEngine: StrategyEngine;
  private scheduler: Scheduler;
  private memory: Memory;
  private wallet: SolanaWallet;
  private marketState: MarketStateBuilder;
  private session: TradingSession | null = null;
  private startTime = 0;
  private ready = false;
  private multiAgent: MultiAgentCoordinator | null = null;
  private contextMemory!: ContextualMemory;
  private decisionExplainer!: DecisionExplainer;
  private dailyReport!: DailyReportGenerator;
  private metricsCollector!: MetricsCollector;
  private backupManager!: BackupManager;
  private privacyGuard!: PrivacyGuard;
  private autoApprove!: AutoApproveManager;
  private oauthManager: OAuthManager;
  private browserService: BrowserService;
  private agentCreationLock = false;
  private apiKeysPath: string;
  private modelConfigPath: string;
  private encryptionKey: Buffer;

  constructor(config: AppConfig) {
    this.config = config;
    this.logger = new Logger();
    this.eventBus = new EventBus();
    this.skillLoader = new SkillLoader(this.logger);
    this.riskManager = new RiskManager(config.risk, this.eventBus, this.logger);
    this.strategyEngine = new StrategyEngine(this.logger);
    this.scheduler = new Scheduler(this.logger);

    const db = createDatabase(config.memory.dbPath);
    this.memory = new Memory(db);
    this.wallet = new SolanaWallet(config.rpc.solana, this.logger, process.env.WALLET_PRIVATE_KEY);
    this.marketState = new MarketStateBuilder({ eventBus: this.eventBus, memory: this.memory, logger: this.logger });
    this.contextMemory = new ContextualMemory(this.memory.getDb());
    this.decisionExplainer = new DecisionExplainer({
      eventBus: this.eventBus, logger: this.logger,
      memory: this.memory, contextMemory: this.contextMemory,
    });
    this.dailyReport = new DailyReportGenerator({
      memory: this.memory, contextMemory: this.contextMemory,
      explainer: this.decisionExplainer, logger: this.logger,
    });
    this.metricsCollector = new MetricsCollector(this.eventBus, this.logger, this.memory);
    this.backupManager = new BackupManager(config.memory.dbPath, config.memory.dbPath + '.backups', this.logger);
    this.autoApprove = new AutoApproveManager(this.eventBus, this.logger, config.autoApproveLevel || 'off');

    // OAuth manager — reuse if already initialized (e.g. by index.ts for config detection)
    this.oauthManager = new OAuthManager('./data', this.logger);
    setOAuthManager(this.oauthManager);

    // Browser service for headless web browsing (Twitter login, page scraping)
    this.browserService = new BrowserService('./data', this.logger);

    // Encrypted API key storage
    const os = require('os');
    const machineId = (os.hostname() || 'axiom') + ':' + (os.userInfo().username || 'user');
    this.encryptionKey = crypto.createHash('sha256').update(machineId).digest();
    this.apiKeysPath = path.join('./data', 'api-keys.enc');
    this.modelConfigPath = path.join('./data', 'model-config.json');
    this.loadApiKeysFromDisk();
  }


  async boot(): Promise<void> {
    this.startTime = Date.now();
    this.logger.info('Booting WhiteOwl...');

    // Register all skills
    const skills = getAllSkills();
    for (const skill of skills) {
      this.skillLoader.register(skill);
    }

    // Initialize skills with context
    await this.skillLoader.initializeAll({
      eventBus: this.eventBus,
      memory: this.memory,
      logger: this.logger,
      config: this.config as any,
      wallet: this.wallet,
      browser: this.browserService,
    });

    // Privacy guard configuration
    const privacyConfig: Partial<PrivacyConfig> = this.config.privacy || {};
    this.privacyGuard = new PrivacyGuard(
      getLLMProvider(this.config.agents[0]?.model || { provider: 'openai', model: 'gpt-4o' } as any),
      privacyConfig,
      this.logger,
    );
    // Register our own wallet for consistent masking
    if (this.wallet.hasWallet()) {
      this.privacyGuard.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
    }

    // Connect auto-approve with risk manager
    this.autoApprove.setRiskChecker((intent) => this.riskManager.validateIntent(intent));

    // Create agents from config — wrap LLM with PrivacyGuard
    // Load saved model config from disk (persisted via Settings)
    try {
      if (fs.existsSync(this.modelConfigPath)) {
        const saved = JSON.parse(fs.readFileSync(this.modelConfigPath, 'utf-8'));
        if (saved.provider && saved.model) {
          const savedMc: ModelConfig = { provider: saved.provider as any, model: saved.model };
          const providerEnvMap: Record<string, string> = {
            openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
            groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
            mistral: 'MISTRAL_API_KEY', openrouter: 'OPENROUTER_API_KEY',
            google: 'GOOGLE_API_KEY', xai: 'XAI_API_KEY', cursor: 'CURSOR_API_KEY',
          };
          const envKey = providerEnvMap[savedMc.provider];
          if (envKey && process.env[envKey]) savedMc.apiKey = process.env[envKey];
          if (savedMc.provider === 'ollama') savedMc.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
          if (savedMc.provider === 'google-oauth') savedMc.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
          for (const agentConfig of this.config.agents) {
            agentConfig.model = savedMc;
          }
          this.logger.info(`Loaded saved model config: ${savedMc.provider}/${savedMc.model}`);
        }
      }
    } catch (err: any) {
      this.logger.warn('Failed to load saved model config: ' + err.message);
    }

    for (const agentConfig of this.config.agents) {
      const baseLlm = agentConfig.fallbackModels?.length
        ? getLLMProviderWithFallback([agentConfig.model, ...agentConfig.fallbackModels])
        : getLLMProvider(agentConfig.model);
      const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
      if (this.wallet.hasWallet()) {
        llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
      }
      const runner = new AgentRunner({
        config: agentConfig,
        llm,
        skills: this.skillLoader,
        eventBus: this.eventBus,
        logger: this.logger,
        marketState: this.marketState,
      });

      this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
      this.agents.set(agentConfig.id, runner);
    }

    // Restore custom agents from disk
    this.restoreCustomAgents();

    // Start decision explainer (generates explanations for every trade intent)
    this.decisionExplainer.start();

    // Start metrics collection
    this.metricsCollector.start();

    // Give daily report generator access to LLM from first agent
    const firstAgentConfig = this.config.agents[0];
    if (firstAgentConfig) {
      const reportLLM = firstAgentConfig.fallbackModels?.length
        ? getLLMProviderWithFallback([firstAgentConfig.model, ...firstAgentConfig.fallbackModels])
        : getLLMProvider(firstAgentConfig.model);
      this.dailyReport.setLLM(reportLLM);
    }

    // Wire up the trade pipeline: intent -> auto-approve / risk check -> approve/reject
    this.eventBus.on('trade:intent', async (intent) => {
      // Step 1: Try auto-approve (includes risk check if configured)
      const autoResult = await this.autoApprove.evaluate(intent);
      if (autoResult.autoApproved) {
        // Already approved and event emitted by AutoApproveManager
        return;
      }

      // Step 2: If not auto-rejected, go through manual risk check
      if (autoResult.requiresManual) {
        const result = this.riskManager.validateIntent(intent);
        if (result.approved) {
          this.eventBus.emit('trade:approved', { intentId: intent.id });
          this.logger.trade(`APPROVED: ${intent.action} ${intent.amountSol} SOL → ${intent.mint.slice(0, 8)}...`);
        } else {
          this.eventBus.emit('trade:rejected', { intentId: intent.id, reason: result.reason || 'Risk check failed' });
          this.logger.warn(`REJECTED: ${result.reason}`);
        }
      } else {
        // Auto-rejected (e.g., security check failed)
        this.eventBus.emit('trade:rejected', { intentId: intent.id, reason: autoResult.reason });
        this.logger.warn(`AUTO-REJECTED: ${autoResult.reason}`);
      }
    });

    // Schedule recurring tasks
    this.registerScheduledTasks();

    this.ready = true;

    // Restore learned pipeline weights from previous sessions
    const savedWeights = this.memory.loadPipelineWeights();
    if (savedWeights) {
      this.logger.info(`Restored pipeline weights from DB: ${JSON.stringify(savedWeights)}`);
      // Will be picked up when pipeline starts via event
      this.eventBus.once('system:ready', () => {
        // Deferred so pipeline can subscribe first
        const stats = this.memory.getLearningStats(7);
        if (stats.totalTrades >= 5) {
          this.eventBus.emit('pipeline:learn', {
            winSignals: stats.winSignals,
            loseSignals: stats.loseSignals,
            winRate: stats.winRate,
            totalTrades: stats.totalTrades,
          });
        }
      });
    }

    this.eventBus.emit('system:ready', { timestamp: Date.now() });
    this.logger.info(`WhiteOwl ready | Wallet: ${this.wallet.hasWallet() ? this.wallet.getAddress() : 'NOT CONFIGURED'} | Agents: ${this.agents.size} | Skills: ${this.skillLoader.getAllManifests().length}`);
  }

  async startSession(opts: {
    mode: AutonomyLevel;
    strategy?: string;
    durationMinutes?: number;
    reportIntervalMinutes?: number;
  }): Promise<TradingSession> {
    if (this.session && this.session.status === 'running') {
      await this.stopSession();
    }

    const sessionId = `s_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;

    this.session = {
      id: sessionId,
      mode: opts.mode,
      strategy: opts.strategy,
      agents: Array.from(this.agents.keys()),
      startedAt: Date.now(),
      endsAt: opts.durationMinutes ? Date.now() + opts.durationMinutes * 60_000 : undefined,
      status: 'running',
      reportInterval: (opts.reportIntervalMinutes || 30) * 60_000,
      stats: {
        tokensScanned: 0,
        signalsGenerated: 0,
        tradesExecuted: 0,
        tradesWon: 0,
        tradesLost: 0,
        totalPnlSol: 0,
        peakPnlSol: 0,
        worstDrawdownSol: 0,
      },
    };

    // Activate strategy if set
    if (opts.strategy) {
      this.strategyEngine.setActive(opts.strategy);
    }

    // Start all agents with the configured autonomy level
    for (const [id, agent] of this.agents) {
      agent.start();
    }

    // Schedule session reports
    this.scheduler.register('session-report', 'Session Report', async () => {
      if (this.session?.status !== 'running') return;
      const stats = this.getSessionStats();
      const report = this.formatReport(stats);

      this.eventBus.emit('session:report', {
        sessionId: this.session.id,
        report,
        stats,
      });

      this.logger.info(`=== SESSION REPORT ===\n${report}`);
    }, this.session.reportInterval);
    this.scheduler.start('session-report');

    // Schedule session expiry check
    if (this.session.endsAt) {
      this.scheduler.register('session-expiry', 'Session Expiry Check', async () => {
        if (this.session && this.session.endsAt && Date.now() >= this.session.endsAt) {
          this.logger.info('Session duration expired');
          await this.stopSession();
        }
      }, 60_000);
      this.scheduler.start('session-expiry');
    }

    // Track stats from events
    this.eventBus.on('token:new', () => {
      if (this.session) this.session.stats.tokensScanned++;
    });
    this.eventBus.on('signal:buy', () => {
      if (this.session) this.session.stats.signalsGenerated++;
    });
    this.eventBus.on('trade:executed', (result) => {
      if (!this.session) return;
      if (result.success) this.session.stats.tradesExecuted++;
    });
    this.eventBus.on('position:closed', (data) => {
      if (!this.session) return;
      if (data.pnl > 0) this.session.stats.tradesWon++;
      else this.session.stats.tradesLost++;
      this.session.stats.totalPnlSol += data.pnl;
      this.session.stats.peakPnlSol = Math.max(this.session.stats.peakPnlSol, this.session.stats.totalPnlSol);
      this.session.stats.worstDrawdownSol = Math.min(this.session.stats.worstDrawdownSol, this.session.stats.totalPnlSol);
    });

    // Record trade outcomes for pipeline self-learning
    this.eventBus.on('position:closed', (data) => {
      const analysis = this.memory.getAnalysis(data.mint);
      if (!analysis) return;

      const outcome = data.pnlPercent > 5 ? 'win' as const
        : data.pnlPercent < -5 ? 'loss' as const
        : 'breakeven' as const;

      this.memory.recordLearningOutcome({
        mint: data.mint,
        signals: analysis.signals,
        outcome,
        pnlSol: data.pnl,
        pnlPercent: data.pnlPercent,
        pipelineScore: analysis.score,
        holdDurationMin: Math.round(data.duration / 60_000),
      });
    });

    this.memory.saveSession({
      id: this.session.id,
      mode: this.session.mode,
      strategy: this.session.strategy,
      startedAt: this.session.startedAt,
      status: 'running',
      stats: this.session.stats,
    });

    this.eventBus.emit('session:started', { sessionId, mode: opts.mode });
    this.logger.info(`Session started: ${sessionId} | Mode: ${opts.mode} | Strategy: ${opts.strategy || 'none'}`);

    return this.session;
  }

  async stopSession(): Promise<TradingSession | null> {
    if (!this.session) return null;

    this.session.status = 'stopped';
    const stats = this.getSessionStats();
    this.session.stats = stats;

    for (const [, agent] of this.agents) {
      agent.stop();
    }

    this.scheduler.cancel('session-report');
    this.scheduler.cancel('session-expiry');

    this.memory.saveSession({
      id: this.session.id,
      mode: this.session.mode,
      strategy: this.session.strategy,
      startedAt: this.session.startedAt,
      endedAt: Date.now(),
      status: 'stopped',
      stats,
    });

    this.eventBus.emit('session:stopped', { sessionId: this.session.id, stats });
    this.logger.info(`Session stopped: ${this.session.id}`);

    const result = { ...this.session };
    this.session = null;
    return result;
  }

  pauseSession(): void {
    if (!this.session || this.session.status !== 'running') return;
    this.session.status = 'paused';
    for (const [, agent] of this.agents) {
      agent.pause();
    }
    this.eventBus.emit('session:paused', { sessionId: this.session.id });
    this.logger.info('Session paused');
  }

  resumeSession(): void {
    if (!this.session || this.session.status !== 'paused') return;
    this.session.status = 'running';
    for (const [, agent] of this.agents) {
      agent.resume();
    }
    this.logger.info('Session resumed');
  }

  async chat(agentId: string, message: string, image?: string): Promise<string> {
    // Auto-create agents if OAuth became available after boot
    if (this.agents.size === 0) {
      await this.ensureAgents();
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      // Try first available agent as fallback
      const firstAgent = this.agents.values().next().value;
      if (firstAgent) {
        return firstAgent.chat(message, image);
      }
      return 'No AI agents available. Please connect an LLM provider via Settings → OAuth / Free AI, or set an API key in your .env file.';
    }
    return agent.chat(message, image);
  }

  /**
   * Dynamically create agents if OAuth tokens are now available but
   * agents weren't created at boot (because no LLM keys existed then).
   */
  async ensureAgents(): Promise<boolean> {
    if (this.agents.size > 0) return true;
    if (this.agentCreationLock) return false;
    this.agentCreationLock = true;

    try {
      // Re-read config to pick up OAuth tokens that were added after boot
      const { loadConfig } = await import('./config');
      const freshConfig = loadConfig();

      if (freshConfig.agents.length === 0) return false;

      this.logger.info(`Creating ${freshConfig.agents.length} agents (LLM now available via OAuth/API key)...`);

      const privacyConfig: Partial<PrivacyConfig> = this.config.privacy || {};

      for (const agentConfig of freshConfig.agents) {
        if (this.agents.has(agentConfig.id)) continue;
        try {
          const baseLlm = agentConfig.fallbackModels?.length
            ? getLLMProviderWithFallback([agentConfig.model, ...agentConfig.fallbackModels])
            : getLLMProvider(agentConfig.model);
          const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
          llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
          const runner = new AgentRunner({
            config: agentConfig,
            llm,
            skills: this.skillLoader,
            eventBus: this.eventBus,
            logger: this.logger,
            marketState: this.marketState,
          });
          this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
          this.agents.set(agentConfig.id, runner);
          this.logger.info(`Agent "${agentConfig.name}" (${agentConfig.id}) created`);
        } catch (err: any) {
          this.logger.warn(`Failed to create agent ${agentConfig.id}: ${err.message}`);
        }
      }

      // Give daily report generator access to LLM if we now have agents
      if (freshConfig.agents.length > 0 && this.dailyReport) {
        const firstCfg = freshConfig.agents[0];
        const reportLLM = firstCfg.fallbackModels?.length
          ? getLLMProviderWithFallback([firstCfg.model, ...firstCfg.fallbackModels])
          : getLLMProvider(firstCfg.model);
        this.dailyReport.setLLM(reportLLM);
      }

      return this.agents.size > 0;
    } finally {
      this.agentCreationLock = false;
    }
  }

  getAvailableAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  getAgentModels(): Record<string, { provider: string; model: string }> {
    const result: Record<string, { provider: string; model: string }> = {};
    for (const agentConfig of this.config.agents) {
      result[agentConfig.id] = { provider: agentConfig.model.provider, model: agentConfig.model.model };
    }
    for (const custom of this.loadCustomAgentConfigs()) {
      result[custom.id] = { provider: custom.model.provider, model: custom.model.model };
    }
    return result;
  }

  getAgentCapabilities(): Record<string, { skills: string[]; tools: string[] }> {
    const result: Record<string, { skills: string[]; tools: string[] }> = {};
    const allConfigs = [...this.config.agents, ...this.loadCustomAgentConfigs()];
    for (const cfg of allConfigs) {
      const tools = this.skillLoader.getToolsForSkills(cfg.skills).map(t => t.name);
      result[cfg.id] = { skills: cfg.skills, tools };
    }
    return result;
  }

  // ======= Custom Agent Management =======
  private get customAgentsPath() { return path.join('./data', 'custom-agents.json'); }

  private loadCustomAgentConfigs(): AgentConfig[] {
    try {
      if (fs.existsSync(this.customAgentsPath)) {
        return JSON.parse(fs.readFileSync(this.customAgentsPath, 'utf-8'));
      }
    } catch {}
    return [];
  }

  private saveCustomAgentConfigs(configs: AgentConfig[]): void {
    const dir = path.dirname(this.customAgentsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.customAgentsPath, JSON.stringify(configs, null, 2), 'utf-8');
  }

  addAgent(agentConfig: AgentConfig): { ok: boolean; error?: string } {
    if (this.agents.has(agentConfig.id)) {
      return { ok: false, error: 'Agent with this ID already exists' };
    }
    try {
      const privacyConfig: Partial<PrivacyConfig> = this.config.privacy || {};
      const baseLlm = agentConfig.fallbackModels?.length
        ? getLLMProviderWithFallback([agentConfig.model, ...agentConfig.fallbackModels])
        : getLLMProvider(agentConfig.model);
      const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
      if (this.wallet.hasWallet()) {
        llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
      }
      const runner = new AgentRunner({
        config: agentConfig,
        llm,
        skills: this.skillLoader,
        eventBus: this.eventBus,
        logger: this.logger,
        marketState: this.marketState,
      });
      this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
      this.agents.set(agentConfig.id, runner);

      // Persist to custom agents file
      const saved = this.loadCustomAgentConfigs();
      saved.push(agentConfig);
      this.saveCustomAgentConfigs(saved);

      this.logger.info(`Custom agent created: ${agentConfig.name} (${agentConfig.id})`);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  removeAgent(agentId: string): { ok: boolean; error?: string } {
    const runner = this.agents.get(agentId);
    if (!runner) return { ok: false, error: 'Agent not found' };
    try { runner.stop(); } catch {}
    this.agents.delete(agentId);

    // Remove from custom agents persistence
    const saved = this.loadCustomAgentConfigs();
    const filtered = saved.filter(a => a.id !== agentId);
    this.saveCustomAgentConfigs(filtered);

    this.logger.info(`Agent removed: ${agentId}`);
    return { ok: true };
  }

  updateAgent(agentConfig: AgentConfig): { ok: boolean; error?: string } {
    const existing = this.agents.get(agentConfig.id);
    if (!existing) return { ok: false, error: 'Agent not found' };
    try {
      try { existing.stop(); } catch {}
      this.agents.delete(agentConfig.id);

      const privacyConfig: Partial<PrivacyConfig> = this.config.privacy || {};
      const baseLlm = agentConfig.fallbackModels?.length
        ? getLLMProviderWithFallback([agentConfig.model, ...agentConfig.fallbackModels])
        : getLLMProvider(agentConfig.model);
      const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
      if (this.wallet.hasWallet()) {
        llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
      }
      const runner = new AgentRunner({
        config: agentConfig, llm, skills: this.skillLoader,
        eventBus: this.eventBus, logger: this.logger, marketState: this.marketState,
      });
      this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
      this.agents.set(agentConfig.id, runner);

      // Update persistence
      const saved = this.loadCustomAgentConfigs();
      const idx = saved.findIndex(a => a.id === agentConfig.id);
      if (idx >= 0) saved[idx] = agentConfig; else saved.push(agentConfig);
      this.saveCustomAgentConfigs(saved);

      this.logger.info(`Agent updated: ${agentConfig.name} (${agentConfig.id})`);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /** Restore custom agents from disk on boot */
  restoreCustomAgents(): void {
    const configs = this.loadCustomAgentConfigs();
    for (const cfg of configs) {
      if (this.agents.has(cfg.id)) continue;
      try {
        const privacyConfig: Partial<PrivacyConfig> = this.config.privacy || {};
        const baseLlm = cfg.fallbackModels?.length
          ? getLLMProviderWithFallback([cfg.model, ...cfg.fallbackModels])
          : getLLMProvider(cfg.model);
        const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
        if (this.wallet.hasWallet()) {
          llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
        }
        const runner = new AgentRunner({
          config: cfg, llm, skills: this.skillLoader,
          eventBus: this.eventBus, logger: this.logger, marketState: this.marketState,
        });
        this.riskManager.setAgentLimits(cfg.id, cfg.riskLimits);
        this.agents.set(cfg.id, runner);
      } catch {}
    }
    if (configs.length > 0) this.logger.info(`Restored ${configs.length} custom agent(s) from disk`);
  }

  registerStrategy(strategy: StrategyConfig): void {
    this.strategyEngine.register(strategy);
  }

  getStatus(): {
    ready: boolean;
    uptime: number;
    wallet: string;
    balance?: number;
    session: TradingSession | null;
    agents: AgentState[];
    skills: string[];
  } {
    return {
      ready: this.ready,
      uptime: Date.now() - this.startTime,
      wallet: this.wallet.hasWallet() ? this.wallet.getAddress() : '',
      session: this.session,
      agents: Array.from(this.agents.values()).map(a => a.getState()),
      skills: this.skillLoader.getAllManifests().map(m => m.name),
    };
  }

  getSessionStats(): SessionStats {
    if (!this.session) {
      return this.memory.getStats('24h');
    }
    return { ...this.session.stats };
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getMemory(): Memory {
    return this.memory;
  }

  getWallet(): SolanaWallet {
    return this.wallet;
  }

  getStrategyEngine(): StrategyEngine {
    return this.strategyEngine;
  }

  getSkillLoader(): SkillLoader {
    return this.skillLoader;
  }

  getContextMemory(): ContextualMemory {
    return this.contextMemory;
  }

  getDecisionExplainer(): DecisionExplainer {
    return this.decisionExplainer;
  }

  getDailyReportGenerator(): DailyReportGenerator {
    return this.dailyReport;
  }

  getMultiAgentCoordinator(): MultiAgentCoordinator | null {
    return this.multiAgent;
  }

  getMetrics(): MetricsCollector {
    return this.metricsCollector;
  }

  getBackupManager(): BackupManager {
    return this.backupManager;
  }

  getAutoApprove(): AutoApproveManager {
    return this.autoApprove;
  }

  setAutoApproveLevel(level: AutoApproveLevel): void {
    this.autoApprove.setLevel(level);
  }

  setPrivacyConfig(config: Partial<PrivacyConfig>): void {
    this.privacyGuard.updateConfig(config);
  }

  getPrivacyStats(): any {
    return this.privacyGuard.getStats();
  }

  getRpcConfig(): { solana: string; helius?: string; heliusApiKey?: string } {
    return { ...this.config.rpc };
  }

  setRpcConfig(rpc: { solana?: string; helius?: string }): void {
    if (rpc.solana) this.config.rpc.solana = rpc.solana;
    if (rpc.helius !== undefined) {
      this.config.rpc.helius = rpc.helius || undefined;
      // Extract API key from Helius URL
      const keyMatch = rpc.helius?.match(/api-key=([^&]+)/);
      this.config.rpc.heliusApiKey = keyMatch ? keyMatch[1] : undefined;
    }

    const newSolanaRpc = this.config.rpc.solana;
    const newHeliusKey = this.config.rpc.heliusApiKey || '';
    const newHeliusRpc = newHeliusKey ? `https://mainnet.helius-rpc.com/?api-key=${newHeliusKey}` : '';

    // Hot-reload ALL skills that use RPC
    const rpcSkills = ['token-analyzer', 'token-security', 'curve-analyzer', 'holder-intelligence', 'wallet-tracker'];
    for (const skillName of rpcSkills) {
      const skill = this.skillLoader.getSkill(skillName);
      if (skill) {
        (skill as any).solanaRpc = newSolanaRpc;
        (skill as any).heliusKey = newHeliusKey;
      }
    }

    // Update blockchain skill
    const blockchain = this.skillLoader.getSkill('blockchain');
    if (blockchain && (blockchain as any).updateRpc) {
      (blockchain as any).updateRpc(newSolanaRpc, newHeliusRpc);
    }

    // Update wallet connection
    this.wallet.updateRpc(newSolanaRpc);

    this.logger.info(`RPC config updated: solana=${newSolanaRpc.substring(0, 40)}...`);
  }

  getModelConfig(): Record<string, { provider: string; model: string }> {
    const result: Record<string, { provider: string; model: string }> = {};
    for (const [id, runner] of this.agents) {
      result[id] = runner.getModelConfig();
    }
    return result;
  }

  setModelConfig(modelConfig: { provider: string; model: string }): void {
    const mc: ModelConfig = {
      provider: modelConfig.provider as any,
      model: modelConfig.model,
    };

    // Add provider-specific fields
    const providerEnvMap: Record<string, string> = {
      openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
      groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
      mistral: 'MISTRAL_API_KEY', openrouter: 'OPENROUTER_API_KEY',
      google: 'GOOGLE_API_KEY', xai: 'XAI_API_KEY', cursor: 'CURSOR_API_KEY',
      cerebras: 'CEREBRAS_API_KEY', together: 'TOGETHER_API_KEY',
      fireworks: 'FIREWORKS_API_KEY', sambanova: 'SAMBANOVA_API_KEY',
    };
    const envKey = providerEnvMap[mc.provider];
    if (envKey && process.env[envKey]) {
      mc.apiKey = process.env[envKey];
    }
    if (mc.provider === 'ollama') {
      mc.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }
    if (mc.provider === 'google-oauth') {
      mc.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
    }

    // Create new LLM provider and hot-swap on all agents
    const privacyConfig = this.config.privacy || {};
    for (const [id, runner] of this.agents) {
      try {
        const baseLlm = getLLMProvider(mc);
        const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
        llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
        runner.setLLM(llm);

        // Update config on the agent
        const agentCfg = this.config.agents.find(a => a.id === id);
        if (agentCfg) agentCfg.model = mc;

        this.logger.info(`Agent "${id}" model updated: ${mc.provider}/${mc.model}`);
      } catch (err: any) {
        this.logger.warn(`Failed to update model for agent ${id}: ${err.message}`);
      }
    }

    // Persist model config to disk
    try {
      fs.mkdirSync(path.dirname(this.modelConfigPath), { recursive: true });
      fs.writeFileSync(this.modelConfigPath, JSON.stringify({ provider: mc.provider, model: mc.model }, null, 2), 'utf-8');
      this.logger.info('Model config saved to disk');
    } catch (err: any) {
      this.logger.warn('Failed to save model config: ' + err.message);
    }
  }

  // =====================================================
  // API Key Management (encrypted persistent storage)
  // =====================================================

  // Provider name → env variable mapping
  private static readonly PROVIDER_ENV_MAP: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
    groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    xai: 'XAI_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    together: 'TOGETHER_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    sambanova: 'SAMBANOVA_API_KEY',
    ollama: 'OLLAMA_BASE_URL',
    cursor: 'CURSOR_API_KEY',
    cursor_repository_url: 'CURSOR_REPOSITORY_URL',
  };

  getApiKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [provider, envKey] of Object.entries(Runtime.PROVIDER_ENV_MAP)) {
      const val = process.env[envKey];
      if (val) {
        // Mask API keys, show Ollama URL as-is
        result[provider] = (provider === 'ollama' || provider === 'cursor_repository_url') ? val : '***configured***';
      }
    }
    return result;
  }

  setApiKeys(keys: Record<string, string>): void {
    for (const [provider, value] of Object.entries(keys)) {
      const envKey = Runtime.PROVIDER_ENV_MAP[provider];
      if (!envKey) continue;

      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed && trimmed !== '***configured***') {
        process.env[envKey] = trimmed;
        this.logger.info(`API key set for ${provider}`);
      } else if (trimmed === '') {
        // Empty string = remove key
        delete process.env[envKey];
        this.logger.info(`API key removed for ${provider}`);
      }
      // '***configured***' = no change (user didn't modify)
    }
    this.saveApiKeysToDisk();
  }

  private loadApiKeysFromDisk(): void {
    try {
      if (!fs.existsSync(this.apiKeysPath)) return;
      const encrypted = fs.readFileSync(this.apiKeysPath, 'utf-8');
      const decrypted = this.decryptData(encrypted);
      const keys = JSON.parse(decrypted) as Record<string, string>;
      for (const [provider, value] of Object.entries(keys)) {
        // Restore Twitter cookies
        if (provider === '_twitter_cookies') {
          if (value && !process.env.TWITTER_COOKIES) process.env.TWITTER_COOKIES = value;
          continue;
        }
        const envKey = Runtime.PROVIDER_ENV_MAP[provider];
        if (envKey && value && !process.env[envKey]) {
          // Only set if not already in .env (env takes precedence)
          process.env[envKey] = value;
        }
      }
      this.logger.debug(`Loaded ${Object.keys(keys).length} API key(s) from disk`);
    } catch {
      // Corrupted or missing, ignore
    }
  }

  private saveApiKeysToDisk(): void {
    try {
      const dir = path.dirname(this.apiKeysPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const keys: Record<string, string> = {};
      for (const [provider, envKey] of Object.entries(Runtime.PROVIDER_ENV_MAP)) {
        const val = process.env[envKey];
        if (val) keys[provider] = val;
      }
      // Include Twitter cookies
      if (process.env.TWITTER_COOKIES) keys['_twitter_cookies'] = process.env.TWITTER_COOKIES;
      const json = JSON.stringify(keys);
      const encrypted = this.encryptData(json);
      fs.writeFileSync(this.apiKeysPath, encrypted, 'utf-8');
    } catch (err: any) {
      this.logger.error(`Failed to save API keys: ${err.message}`);
    }
  }

  private encryptData(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  private decryptData(text: string): string {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts.slice(1).join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  getOAuthManager(): OAuthManager {
    return this.oauthManager;
  }

  getBrowser(): BrowserService {
    return this.browserService;
  }

  // =====================================================
  // Twitter Cookies (for authenticated profile scraping)
  // =====================================================

  getTwitterCookies(): string {
    return process.env.TWITTER_COOKIES || '';
  }

  setTwitterCookies(cookies: string): void {
    const trimmed = (cookies || '').trim();
    if (trimmed) {
      process.env.TWITTER_COOKIES = trimmed;
      this.logger.info('Twitter cookies configured');
    } else {
      delete process.env.TWITTER_COOKIES;
      this.logger.info('Twitter cookies removed');
    }
    this.saveApiKeysToDisk();
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down...');

    if (this.session) {
      await this.stopSession();
    }

    this.scheduler.stopAll();
    await this.skillLoader.shutdownAll();
    await this.browserService.shutdown();
    this.eventBus.removeAllListeners();
    this.memory.close();

    this.logger.info('Shutdown complete');
  }

  private registerScheduledTasks(): void {
    // Health check every 2 minutes
    this.scheduler.register('health-check', 'System Health Check', async () => {
      const agents = Array.from(this.agents.values()).map(a => a.getState());
      this.eventBus.emit('system:health', {
        uptime: Date.now() - this.startTime,
        agents,
        positions: [],
      });
    }, 120_000);

    // Snapshot cleanup daily
    this.scheduler.register('snapshot-cleanup', 'Snapshot Cleanup', async () => {
      const removed = this.memory.cleanOldSnapshots();
      if (removed > 0) {
        this.logger.debug(`Cleaned ${removed} old snapshots`);
      }
    }, 86_400_000);

    // Wallet balance check every 5 minutes
    this.scheduler.register('balance-check', 'Balance Check', async () => {
      try {
        if (!this.wallet.hasWallet()) return;
        const balance = await this.wallet.getBalance();
        this.marketState.updateBalance(balance);
        this.logger.debug(`Wallet balance: ${balance.toFixed(4)} SOL`);
      } catch {}
    }, 300_000);

    // Pipeline self-learning every 30 minutes
    this.scheduler.register('pipeline-learning', 'Pipeline Self-Learning', async () => {
      const stats = this.memory.getLearningStats(7);
      if (stats.totalTrades < 5) return; // Need minimum data

      // Emit to pipeline so it can adjust weights
      this.eventBus.emit('pipeline:learn', {
        winSignals: stats.winSignals,
        loseSignals: stats.loseSignals,
        winRate: stats.winRate,
        totalTrades: stats.totalTrades,
      });

      this.logger.info(
        `Pipeline learning: ${stats.totalTrades} trades, ` +
        `${(stats.winRate * 100).toFixed(0)}% win rate, ` +
        `reinforce=[${stats.winSignals.join(',')}], ` +
        `penalize=[${stats.loseSignals.join(',')}]`
      );
    }, 30 * 60_000);

    // Daily strategic report every 24 hours
    this.scheduler.register('daily-report', 'Daily Strategic Report', async () => {
      try {
        const report = await this.dailyReport.generateReport();
        this.logger.info(`=== DAILY REPORT ===\n${report}`);
        this.eventBus.emit('session:report', {
          sessionId: this.session?.id || 'daily',
          report,
          stats: this.memory.getStats('24h'),
        });
      } catch (err: any) {
        this.logger.error('Daily report generation failed', err);
      }
    }, 24 * 60 * 60_000);

    // Database backup every 6 hours
    this.scheduler.register('db-backup', 'Database Backup', async () => {
      try {
        this.backupManager.backup();
      } catch (err: any) {
        this.logger.error('Backup failed', err);
      }
    }, 6 * 60 * 60_000);

    this.scheduler.startAll();
  }

  private formatReport(stats: SessionStats): string {
    const duration = this.session
      ? Math.round((Date.now() - this.session.startedAt) / 60_000)
      : 0;

    const winRate = stats.tradesExecuted > 0
      ? ((stats.tradesWon / stats.tradesExecuted) * 100).toFixed(1)
      : '0';

    return [
      `Duration: ${duration} minutes`,
      `Tokens Scanned: ${stats.tokensScanned}`,
      `Signals: ${stats.signalsGenerated}`,
      `Trades: ${stats.tradesExecuted} (${stats.tradesWon}W / ${stats.tradesLost}L)`,
      `Win Rate: ${winRate}%`,
      `P&L: ${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(4)} SOL`,
      `Peak P&L: ${stats.peakPnlSol.toFixed(4)} SOL`,
      `Max Drawdown: ${stats.worstDrawdownSol.toFixed(4)} SOL`,
    ].join('\n');
  }
}
