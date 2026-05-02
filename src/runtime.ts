import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
  LLMMessage,
} from './types.ts';
import { EventBus } from './core/event-bus.ts';
import { SkillLoader } from './core/skill-loader.ts';
import { AgentRunner } from './core/agent-runner.ts';
import { RiskManager } from './core/risk-manager.ts';
import { StrategyEngine } from './core/strategy.ts';
import { Scheduler } from './core/scheduler.ts';
import { MarketStateBuilder } from './core/market-state.ts';
import { getLLMProvider, getLLMProviderWithFallback } from './llm/index.ts';
import { Memory, createDatabase, initDatabaseEngine, ContextualMemory } from './memory/index.ts';
import { SolanaWallet } from './wallet/solana.ts';
import { getAllSkills } from './skills/index.ts';
import { Logger } from './logger.ts';
import { MultiAgentCoordinator } from './core/multi-agent.ts';
import { DecisionExplainer, DailyReportGenerator } from './core/decision-engine.ts';
import { MetricsCollector, BackupManager } from './core/metrics.ts';
import { PrivacyGuard, PrivacyConfig } from './core/privacy-guard.ts';
import { AutoApproveManager, AutoApproveLevel } from './core/auto-approve.ts';
import { OAuthManager } from './core/oauth-manager.ts';
import { setOAuthManager } from './llm/providers.ts';
import { BrowserService } from './core/browser.ts';
import { MCPManager } from './core/mcp-client.ts';
import { JobManager } from './core/job-manager.ts';

export class Runtime {
  private config: AppConfig;
  private logger: Logger;
  private eventBus: EventBus;
  private skillLoader: SkillLoader;
  private agents = new Map<string, AgentRunner>();

  private chatSessions = new Map<string, { runner: AgentRunner; agentId: string; lastUsed: number }>();
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
  private jobManager!: JobManager;
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

    this.jobManager = new JobManager(this.logger, this.eventBus, path.join(process.cwd(), 'data'));

    try {
      const savedApprovePath = path.join(process.cwd(), 'data', 'auto-approve.json');
      if (fs.existsSync(savedApprovePath)) {
        const saved = JSON.parse(fs.readFileSync(savedApprovePath, 'utf-8'));
        if (saved.level && ['off', 'conservative', 'moderate', 'aggressive', 'full'].includes(saved.level)) {
          this.autoApprove.setLevel(saved.level);
        }
      }
    } catch {  }

    this.oauthManager = new OAuthManager('./data', this.logger);
    setOAuthManager(this.oauthManager);

    this.browserService = new BrowserService('./data', this.logger);

    const machineId = (os.hostname() || 'axiom') + ':' + (os.userInfo().username || 'user');
    this.encryptionKey = crypto.createHash('sha256').update(machineId).digest();
    this.apiKeysPath = path.join('./data', 'api-keys.enc');
    this.modelConfigPath = path.join('./data', 'model-config.json');
    this.loadApiKeysFromDisk();
  }

  async boot(): Promise<void> {
    this.startTime = Date.now();
    this.logger.info('Booting WhiteOwl...');

    const skills = getAllSkills();
    for (const skill of skills) {
      this.skillLoader.register(skill);
    }

    await this.skillLoader.initializeAll({
      eventBus: this.eventBus,
      memory: this.memory,
      logger: this.logger,
      config: this.config as any,
      wallet: this.wallet,
      browser: this.browserService,
    });

    const skillsMdDir = path.join(process.cwd(), 'skills');
    const mdLoaded = this.skillLoader.loadMarkdownSkills(skillsMdDir);
    if (mdLoaded > 0) this.logger.info(`Loaded ${mdLoaded} SKILL.md skill(s) from ${skillsMdDir}`);
    this.skillLoader.watchSkillsDir(skillsMdDir);


    const mcpManager = new MCPManager(this.logger);
    const mcpSkills = mcpManager.loadConfig();
    for (const mcpSkill of mcpSkills) {
      this.skillLoader.register(mcpSkill);
    }


    const privacyConfig: Partial<PrivacyConfig> = this.config.privacy || {};
    this.privacyGuard = new PrivacyGuard(
      getLLMProvider(this.config.agents[0]?.model || { provider: 'openai', model: 'gpt-4o' } as any),
      privacyConfig,
      this.logger,
    );

    if (this.wallet.hasWallet()) {
      this.privacyGuard.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
    }


    this.autoApprove.setRiskChecker((intent) => this.riskManager.validateIntent(intent));


    try {
      if (fs.existsSync(this.modelConfigPath)) {
        const saved = JSON.parse(fs.readFileSync(this.modelConfigPath, 'utf-8'));
        if (saved.provider && saved.model) {
          const savedMc: ModelConfig = { provider: saved.provider as any, model: saved.model };

          if (String(savedMc.provider) === 'cursor') {
            savedMc.provider = 'copilot' as any;
            if (!savedMc.model || savedMc.model === 'default') savedMc.model = 'gpt-4o';
            this.logger.warn(`cursor provider migrated to copilot.`);
            try {
              fs.writeFileSync(this.modelConfigPath, JSON.stringify({ provider: savedMc.provider, model: savedMc.model }, null, 2), 'utf-8');
            } catch {  }
          }

          if (String(savedMc.provider) === 'vscode-bridge') {
            savedMc.provider = 'copilot' as any;
            if (!savedMc.model || savedMc.model === 'default') savedMc.model = 'gpt-4o';
            this.logger.warn(`vscode-bridge provider migrated to copilot.`);
            try {
              fs.writeFileSync(this.modelConfigPath, JSON.stringify({ provider: savedMc.provider, model: savedMc.model }, null, 2), 'utf-8');
            } catch {  }
          }

          const geminiModelMigrations: Record<string, string> = {
            'gemini-2.5-pro-preview-06-05': 'gemini-2.5-pro',
            'gemini-2.5-flash-preview-05-20': 'gemini-2.5-flash',
            'gemini-2.5-pro-preview-03-25': 'gemini-2.5-pro',
            'gemini-2.0-flash': 'gemini-2.5-flash',
            'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
            'gemini-1.5-pro': 'gemini-2.5-pro',
            'gemini-1.5-flash': 'gemini-2.5-flash',
            'gemini-3-pro': 'gemini-3.1-pro-preview',
            'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
          };
          if ((savedMc.provider === 'google' || savedMc.provider === 'google-oauth' || savedMc.provider === 'copilot') && geminiModelMigrations[savedMc.model]) {
            const newModel = geminiModelMigrations[savedMc.model];
            this.logger.warn(`Migrated Gemini model: ${savedMc.model} → ${newModel}`);
            savedMc.model = newModel;
            try {
              fs.writeFileSync(this.modelConfigPath, JSON.stringify({ provider: savedMc.provider, model: newModel }, null, 2), 'utf-8');
            } catch {  }
          }

          const envKey = Runtime.PROVIDER_ENV_MAP[savedMc.provider];
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
        wallet: this.wallet,
      });
      runner.setAutoApproveLevel(this.autoApprove.getLevel() as any);

      this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
      this.agents.set(agentConfig.id, runner);
    }


    this.restoreCustomAgents();


    for (const [id, agent] of this.agents) {
      try { agent.loadSession(); } catch {}
    }


    this.decisionExplainer.start();


    this.metricsCollector.start();


    const firstAgentConfig = this.config.agents[0];
    if (firstAgentConfig) {
      const reportLLM = firstAgentConfig.fallbackModels?.length
        ? getLLMProviderWithFallback([firstAgentConfig.model, ...firstAgentConfig.fallbackModels])
        : getLLMProvider(firstAgentConfig.model);
      this.dailyReport.setLLM(reportLLM);
    }


    this.eventBus.on('trade:intent', async (intent) => {

      const autoResult = await this.autoApprove.evaluate(intent);
      if (autoResult.autoApproved) {

        return;
      }


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

        this.eventBus.emit('trade:rejected', { intentId: intent.id, reason: autoResult.reason });
        this.logger.warn(`AUTO-REJECTED: ${autoResult.reason}`);
      }
    });


    this.registerScheduledTasks();


    this.jobManager.setChatFunction((agentId, message, jobId, freshSession) => {
      let sessionId: string;
      if (freshSession && jobId) {

        sessionId = `_job_${jobId}_summary_${Date.now()}`;
        this.logger.info(`[Jobs] Fresh session for summary: ${sessionId}`);
      } else {
        sessionId = jobId ? `_job_${jobId}` : `_job_${agentId}_${Date.now()}`;
      }
      const allowedSkills = jobId ? this.jobManager.getJobAllowedSkills(jobId) : undefined;
      return this.sessionChat(sessionId, message, agentId, undefined, allowedSkills ?? undefined);
    });


    this.jobManager.setSummaryFunction(async (prompt: string, jobId: string) => {
      const agentConfig = this.config.agents[0];
      if (!agentConfig) throw new Error('No agent config available for summary');

      const baseLlm = agentConfig.fallbackModels?.length
        ? getLLMProviderWithFallback([agentConfig.model, ...agentConfig.fallbackModels])
        : getLLMProvider(agentConfig.model);

      const messages: import('./types.ts').LLMMessage[] = [
        {
          role: 'system',
          content: 'You are a concise reporting assistant. Summarize monitoring data into structured reports. Write in Russian. Do NOT call any tools — just write the report from the data provided.',
        },
        { role: 'user', content: prompt },
      ];

      this.logger.info(`[Jobs] Direct LLM summary call for ${jobId} (~${prompt.length} chars, no tools)`);
      const response = await baseLlm.chat(messages, []);
      this.logger.info(`[Jobs] Summary done: ${response.usage?.promptTokens || '?'}pt / ${response.usage?.completionTokens || '?'}ct`);


      this.eventBus.emit('agent:llm_response' as any, {
        agentId: `_job_${jobId}_summary`,
        content: response.content.slice(0, 500),
        toolCallsCount: 0,
        round: 0,
        usage: response.usage,
      });

      return response.content;
    });

    const jobsSkill = this.skillLoader.getSkill('background-jobs') as any;
    if (jobsSkill?.setJobManager) jobsSkill.setJobManager(this.jobManager);
    this.jobManager.start();


    setInterval(() => this.cleanupIdleSessions(), 15 * 60 * 1000);


    try {
      const { NewsStore } = await import('./memory/news-store.ts');
      const { NewsProcessor } = await import('./core/news-processor.ts');
      const { NewsScheduler } = await import('./core/news-scheduler.ts');
      const { NewsSignals } = await import('./core/news-signals.ts');

      const newsStore = new NewsStore(this.memory.getDb());
      const newsProcessor = new NewsProcessor({
        store: newsStore,
        eventBus: this.eventBus,
        logger: this.logger,
        portfolioMints: () => [],
      });

      const newsScheduler = new NewsScheduler({
        logger: this.logger,
        eventBus: this.eventBus,
        store: newsStore,
        processor: newsProcessor,
      });

      newsScheduler.start();


      (this as any)._newsScheduler = newsScheduler;
      (this as any)._newsStore = newsStore;


      this.marketState.setNewsStore(newsStore);


      const newsSignals = new NewsSignals({
        logger: this.logger,
        eventBus: this.eventBus,
        getActiveMints: () => [],
      });

      this.logger.info('[News] Feed system initialized');


      try {
        const { TrendContext } = await import('./core/trend-context.ts');
        const { SniperJob } = await import('./core/sniper-job.ts');

        const trendContext = new TrendContext({
          eventBus: this.eventBus,
          logger: this.logger,
        });
        trendContext.setNewsStore(newsStore);


        const pumpMon = this.skillLoader.getSkill('pump-monitor') as any;
        if (pumpMon?.setTrendContext) {
          pumpMon.setTrendContext(trendContext);
        }

        const sniperJob = new SniperJob({
          eventBus: this.eventBus,
          logger: this.logger,
          trendContext,
          marketState: this.marketState,
          memory: this.memory,
          contextMemory: this.contextMemory,
        });


        const firstAgent = this.config.agents?.[0];
        if (firstAgent) {
          const sniperLLM = firstAgent.fallbackModels?.length
            ? getLLMProviderWithFallback([firstAgent.model, ...firstAgent.fallbackModels])
            : getLLMProvider(firstAgent.model);
          sniperJob.setLLMFunction(async (messages, _tools) => {
            const resp = await sniperLLM.chat(messages, undefined, { maxTokens: 200 });
            return resp;
          });


          trendContext.setLLMFunction(async (messages) => {
            return sniperLLM.chat(messages, undefined, { maxTokens: 800 });
          });
        }


        sniperJob.setTradeFunction(async (toolName, params) => {
          return this.skillLoader.executeTool(toolName, params);
        });


        sniperJob.setBalanceFunction(async () => {
          return this.wallet.getBalance();
        });


        if (this.browserService) {
          sniperJob.setBrowserService(this.browserService);

          try {
            const cdpResult = await this.browserService.connectMainBrowser();
            if (cdpResult.success) {
              this.logger.info(`[Boot] Auto-connected Chrome CDP — Axiom ✓ GMGN ✓`);
            } else {
              this.logger.warn(`[Boot] Chrome CDP auto-connect failed: ${cdpResult.message}`);
            }
          } catch (e: any) {
            this.logger.warn(`[Boot] Chrome CDP auto-connect error: ${e.message}`);
          }
        }

        (this as any)._trendContext = trendContext;
        (this as any)._sniperJob = sniperJob;


        const shitTraderSkill = this.skillLoader.getSkill('shit-trader') as any;
        if (shitTraderSkill?.setSniperJob) {
          shitTraderSkill.setSniperJob(sniperJob);
          this.logger.info('[Sniper] Wired into shit-trader skill');
        }

        this.logger.info('[Sniper] Degen Sniper ready (use /api/sniper/start to activate)');
      } catch (err: any) {
        this.logger.warn(`[Sniper] Init failed: ${err.message}`);
      }
    } catch (err: any) {
      this.logger.warn(`[News] Feed system init failed: ${err.message}`);
    }

    this.ready = true;

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


    if (opts.strategy) {
      this.strategyEngine.setActive(opts.strategy);
    }


    for (const [id, agent] of this.agents) {
      agent.start();
    }


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


    if (this.session.endsAt) {
      this.scheduler.register('session-expiry', 'Session Expiry Check', async () => {
        if (this.session && this.session.endsAt && Date.now() >= this.session.endsAt) {
          this.logger.info('Session duration expired');
          await this.stopSession();
        }
      }, 60_000);
      this.scheduler.start('session-expiry');
    }


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

    if (this.agents.size === 0) {
      await this.ensureAgents();
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      const firstAgent = this.agents.values().next().value;
      if (firstAgent) {
        return firstAgent.chat(message, image);
      }
      return 'No AI agents available. Please connect an LLM provider via Settings → OAuth / Free AI, or set an API key in your .env file.';
    }
    return agent.chat(message, image);
  }

async quickLlm(prompt: string, image?: string): Promise<string> {
    const modelConfig = this.config.agents[0]?.model;
    if (!modelConfig) return 'No AI model configured.';
    try {
      const llm = getLLMProvider(modelConfig);
      const msg: LLMMessage = { role: 'user', content: prompt };
      if (image) msg.image = image;
      const resp = await llm.chat([msg], [], { maxTokens: 2000, temperature: 0.1 });
      return resp.content || '';
    } catch (err: any) {
      this.logger.error('quickLlm error:', err.message);
      return `Error: ${err.message}`;
    }
  }

cancelChat(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {

      const firstAgent = this.agents.values().next().value;
      if (firstAgent) { firstAgent.requestCancel(); return true; }
      return false;
    }
    agent.requestCancel();
    return true;
  }

async compactChat(agentId: string): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      const firstAgent = this.agents.values().next().value;
      if (firstAgent) return firstAgent.compactNow();
      return 'No agents available.';
    }
    return agent.compactNow();
  }

newChat(agentId: string): string {

    for (const [, agent] of this.agents) {
      try { agent.clearSession(); } catch {}
    }
    return '✅ New session started. All agent contexts cleared.';
  }

saveAllSessions(): void {
    for (const [, agent] of this.agents) {
      try { agent.saveSession(); } catch {}
    }

    for (const [, entry] of this.chatSessions) {
      try { entry.runner.saveSession(); } catch {}
    }
  }

getCheckpoints(agentId: string): Array<{ id: number; timestamp: number; messageCount: number; preview: string }> {
    const agent = this.agents.get(agentId) || this.agents.values().next().value;
    if (!agent) return [];
    return agent.getCheckpoints();
  }

restoreCheckpoint(agentId: string, checkpointId: number): { ok: boolean; messageCount: number; removedMessages: number } {
    const agent = this.agents.get(agentId) || this.agents.values().next().value;
    if (!agent) return { ok: false, messageCount: 0, removedMessages: 0 };
    return agent.restoreCheckpoint(checkpointId);
  }


createIsolatedRunner(sessionId: string, agentId?: string, skillFilter?: string[]): AgentRunner | null {
    const templateAgentId = agentId || 'commander';
    const agentConfig = this.config.agents.find(a => a.id === templateAgentId) || this.config.agents[0];
    if (!agentConfig) return null;

    try {
      const privacyConfig: Partial<PrivacyConfig> = this.config.privacy || {};
      const baseLlm = agentConfig.fallbackModels?.length
        ? getLLMProviderWithFallback([agentConfig.model, ...agentConfig.fallbackModels])
        : getLLMProvider(agentConfig.model);
      const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
      llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');


      let sessionConfig = { ...agentConfig, id: sessionId };


      if (skillFilter && skillFilter.length > 0) {
        const restricted = agentConfig.skills.filter((s: string) => skillFilter.includes(s));
        if (restricted.length > 0) {
          sessionConfig = { ...sessionConfig, skills: restricted };
          this.logger.info(`[Sessions] Skill filter applied: ${restricted.length}/${agentConfig.skills.length} skills for ${sessionId}`);
        }
      }

      const runner = new AgentRunner({
        config: sessionConfig,
        llm,
        skills: this.skillLoader,
        eventBus: this.eventBus,
        logger: this.logger,
        marketState: this.marketState,
        wallet: this.wallet,
      });

      return runner;
    } catch (err: any) {
      this.logger.error(`Failed to create isolated runner for session "${sessionId}": ${err.message}`);
      return null;
    }
  }

async sessionChat(sessionId: string, message: string, agentId?: string, image?: string, skillFilter?: string[]): Promise<string> {
    if (!sessionId) return this.chat(agentId || 'commander', message, image);


    if (this.agents.size === 0) await this.ensureAgents();

    let entry = this.chatSessions.get(sessionId);
    if (!entry) {
      const runner = this.createIsolatedRunner(sessionId, agentId, skillFilter);
      if (!runner) {
        return 'No AI agents available. Please connect an LLM provider via Settings.';
      }

      runner.loadSession();
      entry = { runner, agentId: agentId || 'commander', lastUsed: Date.now() };
      this.chatSessions.set(sessionId, entry);
      this.logger.info(`[Sessions] Created chat session: ${sessionId} (agent: ${entry.agentId})`);
    }

    entry.lastUsed = Date.now();
    return entry.runner.chat(message, image);
  }

sessionCancel(sessionId: string): boolean {
    const entry = this.chatSessions.get(sessionId);
    if (entry) { entry.runner.requestCancel(); return true; }
    return this.cancelChat('commander');
  }

sessionNew(sessionId: string): string {
    const entry = this.chatSessions.get(sessionId);
    if (entry) {
      entry.runner.clearSession();
      return 'Session cleared.';
    }
    return 'Session cleared.';
  }

deleteSession(sessionId: string): boolean {
    const entry = this.chatSessions.get(sessionId);
    if (!entry) return false;
    try { entry.runner.clearSession(); } catch {}
    this.chatSessions.delete(sessionId);
    this.logger.info(`[Sessions] Deleted session: ${sessionId}`);
    return true;
  }

async sessionCompact(sessionId: string): Promise<string> {
    const entry = this.chatSessions.get(sessionId);
    if (entry) return entry.runner.compactNow();
    return 'No active session to compact.';
  }

sessionDiagnostics(sessionId: string): ReturnType<Runtime['getAgentDiagnostics']> {
    const entry = this.chatSessions.get(sessionId);
    if (!entry) return null;
    const r = entry.runner;
    return {
      historyLength: r.getHistoryLength(),
      compactionSummary: r.getCompactionSummary(),
      promptMode: r.getPromptMode(),
      efficiencyMode: r.getEfficiencyMode(),
      maxRounds: r.getMaxRounds(),
      contextBudget: r.getContextBudget(),
    };
  }

sessionCheckpoints(sessionId: string): Array<{ id: number; timestamp: number; messageCount: number; preview: string }> {
    const entry = this.chatSessions.get(sessionId);
    if (!entry) return [];
    return entry.runner.getCheckpoints();
  }

sessionRestoreCheckpoint(sessionId: string, checkpointId: number): { ok: boolean; messageCount: number; removedMessages: number } {
    const entry = this.chatSessions.get(sessionId);
    if (!entry) return { ok: false, messageCount: 0, removedMessages: 0 };
    return entry.runner.restoreCheckpoint(checkpointId);
  }

listSessions(): Array<{ id: string; agentId: string; lastUsed: number }> {
    const sessions: Array<{ id: string; agentId: string; lastUsed: number }> = [];
    for (const [id, entry] of this.chatSessions) {
      sessions.push({ id, agentId: entry.agentId, lastUsed: entry.lastUsed });
    }
    return sessions.sort((a, b) => b.lastUsed - a.lastUsed);
  }

private cleanupIdleSessions(): void {
    const maxIdleMs = 2 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, entry] of this.chatSessions) {

      if (id.startsWith('_job_')) continue;
      if (now - entry.lastUsed > maxIdleMs) {
        try { entry.runner.saveSession(); } catch {}
        this.chatSessions.delete(id);
        this.logger.info(`[Sessions] Cleaned up idle session: ${id}`);
      }
    }
  }

getSessionFilterId(sessionId: string): string | null {
    const entry = this.chatSessions.get(sessionId);
    return entry ? sessionId : null;
  }


getAgentDiagnostics(agentId: string): { historyLength: number; compactionSummary: string | null; promptMode: string; efficiencyMode: string; maxRounds: number; contextBudget: { historyChars: number; maxChars: number; pct: number; maxMessages: number; compactionThreshold: number } } | null {
    const agent = this.agents.get(agentId) || this.agents.values().next().value;
    if (!agent) return null;
    return {
      historyLength: agent.getHistoryLength(),
      compactionSummary: agent.getCompactionSummary(),
      promptMode: agent.getPromptMode(),
      efficiencyMode: agent.getEfficiencyMode(),
      maxRounds: agent.getMaxRounds(),
      contextBudget: agent.getContextBudget(),
    };
  }

setAgentPromptMode(agentId: string, mode: 'full' | 'minimal' | 'none'): boolean {
    const agent = this.agents.get(agentId) || this.agents.values().next().value;
    if (!agent) return false;
    agent.setPromptMode(mode);
    return true;
  }

setAgentEfficiencyMode(agentId: string, mode: 'economy' | 'balanced' | 'max'): boolean {
    const agent = this.agents.get(agentId) || this.agents.values().next().value;
    if (!agent) return false;
    agent.setEfficiencyMode(mode);
    return true;
  }

async ensureAgents(): Promise<boolean> {
    if (this.agents.size > 0) return true;
    if (this.agentCreationLock) return false;
    this.agentCreationLock = true;

    try {

      const { loadConfig } = await import('./config.ts');
      const freshConfig = loadConfig();

      if (freshConfig.agents.length === 0) return false;

      // Apply saved model-config.json (loadConfig doesn't read it)
      try {
        if (fs.existsSync(this.modelConfigPath)) {
          const saved = JSON.parse(fs.readFileSync(this.modelConfigPath, 'utf-8'));
          if (saved.provider && saved.model) {
            const savedMc: ModelConfig = { provider: saved.provider as any, model: saved.model };
            const envKey = Runtime.PROVIDER_ENV_MAP[savedMc.provider];
            if (envKey && process.env[envKey]) savedMc.apiKey = process.env[envKey];
            if (savedMc.provider === 'ollama') savedMc.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
            if (savedMc.provider === 'google-oauth') savedMc.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
            for (const ac of freshConfig.agents) ac.model = savedMc;
            this.logger.info(`ensureAgents: applied saved model ${savedMc.provider}/${savedMc.model}`);
          }
        }
      } catch {}

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
            wallet: this.wallet,
          });
          this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
          this.agents.set(agentConfig.id, runner);
          this.logger.info(`Agent "${agentConfig.name}" (${agentConfig.id}) created`);
        } catch (err: any) {
          this.logger.warn(`Failed to create agent ${agentConfig.id}: ${err.message}`);
        }
      }


      // Sync this.config.agents so createIsolatedRunner() can find agent templates
      if (this.config.agents.length === 0 && freshConfig.agents.length > 0) {
        this.config.agents = freshConfig.agents;
      }

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
        wallet: this.wallet,
      });
      this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
      this.agents.set(agentConfig.id, runner);


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
        wallet: this.wallet,
      });
      this.riskManager.setAgentLimits(agentConfig.id, agentConfig.riskLimits);
      this.agents.set(agentConfig.id, runner);


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
          wallet: this.wallet,
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

  getJobManager(): JobManager {
    return this.jobManager;
  }

  setAutoApproveLevel(level: AutoApproveLevel): void {
    this.autoApprove.setLevel(level);

    for (const [, runner] of this.agents) {
      runner.setAutoApproveLevel(level as any);
    }
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

      const keyMatch = rpc.helius?.match(/api-key=([^&]+)/);
      this.config.rpc.heliusApiKey = keyMatch ? keyMatch[1] : undefined;
    }

    const newSolanaRpc = this.config.rpc.solana;
    const newHeliusKey = this.config.rpc.heliusApiKey || '';
    const newHeliusRpc = newHeliusKey ? `https://mainnet.helius-rpc.com/?api-key=${newHeliusKey}` : undefined;

    const rpcSkills = ['token-analyzer', 'token-security', 'curve-analyzer', 'holder-intelligence', 'wallet-tracker', 'shit-trader'];
    for (const skillName of rpcSkills) {
      const skill = this.skillLoader.getSkill(skillName);
      if (skill) {
        (skill as any).solanaRpc = newSolanaRpc;
        (skill as any).heliusKey = newHeliusKey;
      }
    }

    const blockchain = this.skillLoader.getSkill('blockchain');
    if (blockchain && (blockchain as any).updateRpc) {
      (blockchain as any).updateRpc(newSolanaRpc, newHeliusRpc);
    }

    const shitTrader = this.skillLoader.getSkill('shit-trader');
    if (shitTrader && (shitTrader as any).updateRpc) {
      (shitTrader as any).updateRpc(newSolanaRpc);
    }

    this.wallet.updateRpc(newSolanaRpc);

    this.logger.info(`RPC config updated: solana=${newSolanaRpc.substring(0, 40)}...`);


    try {
      const rpcPath = path.join(process.cwd(), 'data', 'rpc-config.json');
      fs.writeFileSync(rpcPath, JSON.stringify({ solana: this.config.rpc.solana, helius: this.config.rpc.helius || '' }, null, 2));
    } catch {}
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


    const envKey = Runtime.PROVIDER_ENV_MAP[mc.provider];
    if (envKey && process.env[envKey]) {
      mc.apiKey = process.env[envKey];
    }
    if (mc.provider === 'ollama') {
      mc.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }
    if (mc.provider === 'google-oauth') {
      mc.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
    }


    const privacyConfig = this.config.privacy || {};
    for (const [id, runner] of this.agents) {
      try {
        const baseLlm = getLLMProvider(mc);
        const llm = new PrivacyGuard(baseLlm, privacyConfig, this.logger);
        llm.registerWallet(this.wallet.getAddress(), 'MY_WALLET');
        runner.setLLM(llm);


        const agentCfg = this.config.agents.find(a => a.id === id);
        if (agentCfg) agentCfg.model = mc;

        this.logger.info(`Agent "${id}" model updated: ${mc.provider}/${mc.model}`);
      } catch (err: any) {
        this.logger.warn(`Failed to update model for agent ${id}: ${err.message}`);
      }
    }


    try {
      fs.mkdirSync(path.dirname(this.modelConfigPath), { recursive: true });
      fs.writeFileSync(this.modelConfigPath, JSON.stringify({ provider: mc.provider, model: mc.model }, null, 2), 'utf-8');
      this.logger.info('Model config saved to disk');
    } catch (err: any) {
      this.logger.warn('Failed to save model config: ' + err.message);
    }
  }


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
    houdini_key: 'HOUDINI_API_KEY',
    houdini_secret: 'HOUDINI_API_SECRET',
    hyperliquid_api_url: 'HYPERLIQUID_API_URL',
    hyperliquid_account_address: 'HYPERLIQUID_ACCOUNT_ADDRESS',
    hyperliquid_api_wallet_address: 'HYPERLIQUID_API_WALLET_ADDRESS',
    hyperliquid_private_key: 'HYPERLIQUID_PRIVATE_KEY',
  };

  getApiKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [provider, envKey] of Object.entries(Runtime.PROVIDER_ENV_MAP)) {
      const val = process.env[envKey];
      if (val) {

        result[provider] = provider === 'ollama' || provider === 'hyperliquid_api_url' || provider === 'hyperliquid_account_address' || provider === 'hyperliquid_api_wallet_address'
          ? val
          : '***configured***';
      }
    }
    return result;
  }

  setApiKeys(keys: Record<string, string>): void {
    const updatedProviders = new Set<string>();

    for (const [provider, value] of Object.entries(keys)) {
      const envKey = Runtime.PROVIDER_ENV_MAP[provider];
      if (!envKey) continue;

      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed && trimmed !== '***configured***') {
        process.env[envKey] = trimmed;
        updatedProviders.add(provider);
        this.logger.info(`API key set for ${provider}`);
      } else if (trimmed === '') {
        delete process.env[envKey];
        this.logger.info(`API key removed for ${provider}`);
      }
    }
    this.saveApiKeysToDisk();


    if (updatedProviders.size > 0 && this.agents.size > 0) {
      try {
        const currentModels = this.getAgentModels();
        const firstModel = Object.values(currentModels)[0];
        if (firstModel && updatedProviders.has(firstModel.provider)) {
          this.setModelConfig(firstModel);
          this.logger.info(`Re-applied model config after API key update for ${firstModel.provider}`);
        }
      } catch (err: any) {
        this.logger.warn('Failed to re-apply model config after key update: ' + err.message);
      }
    }
  }

  private loadApiKeysFromDisk(): void {
    try {
      if (!fs.existsSync(this.apiKeysPath)) return;
      const encrypted = fs.readFileSync(this.apiKeysPath, 'utf-8');
      const decrypted = this.decryptData(encrypted);
      const keys = JSON.parse(decrypted) as Record<string, string>;
      for (const [provider, value] of Object.entries(keys)) {

        if (provider === '_twitter_cookies') {
          if (value && !process.env.TWITTER_COOKIES) process.env.TWITTER_COOKIES = value;
          continue;
        }
        const envKey = Runtime.PROVIDER_ENV_MAP[provider];
        if (envKey && value && !process.env[envKey]) {

          process.env[envKey] = value;
        }
      }
      this.logger.debug(`Loaded ${Object.keys(keys).length} API key(s) from disk`);
    } catch {

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


    for (const [id, agent] of this.agents) {
      try { agent.saveSession(); } catch {}
    }

    if (this.session) {
      await this.stopSession();
    }

    this.scheduler.stopAll();
    this.jobManager.stop();
    await this.skillLoader.shutdownAll();
    await this.browserService.shutdown();
    this.eventBus.removeAllListeners();
    this.memory.close();

    this.logger.info('Shutdown complete');
  }

  private registerScheduledTasks(): void {

    this.scheduler.register('session-autosave', 'Session Auto-Save', async () => {
      this.saveAllSessions();
    }, 5 * 60_000);


    this.scheduler.register('health-check', 'System Health Check', async () => {
      const agents = Array.from(this.agents.values()).map(a => a.getState());
      this.eventBus.emit('system:health', {
        uptime: Date.now() - this.startTime,
        agents,
        positions: [],
      });
    }, 3 * 60 * 60_000);


    this.scheduler.register('snapshot-cleanup', 'Snapshot Cleanup', async () => {
      const removed = this.memory.cleanOldSnapshots();
      if (removed > 0) {
        this.logger.debug(`Cleaned ${removed} old snapshots`);
      }
    }, 86_400_000);


    this.scheduler.register('balance-check', 'Balance Check', async () => {
      try {
        if (!this.wallet.hasWallet()) return;
        const balance = await this.wallet.getBalance();
        this.marketState.updateBalance(balance);
        this.logger.debug(`Wallet balance: ${balance.toFixed(4)} SOL`);
      } catch {}
    }, 300_000);


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
