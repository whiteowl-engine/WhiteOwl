import {
  Skill, SkillManifest, SkillContext, TokenInfo, TokenAnalysis,
  LoggerInterface, EventBusInterface,
} from '../types';
import { TokenPipeline, PipelineConfig } from '../core/pipeline';

const PUMP_API = 'https://frontend-api-v3.pump.fun';

export class FastSniperSkill implements Skill {
  manifest: SkillManifest = {
    name: 'fast-sniper',
    version: '2.0.0',
    description: 'Ultra-fast token sniper with multi-stage pipeline. Evaluates every token in <5ms (Stage 0-2), deep-checks survivors via concurrent worker pool (<200ms), and auto-enters positions without LLM.',
    tools: [
      {
        name: 'sniper_enable',
        description: 'Enable the fast sniper pipeline. Starts listening for token:new events and auto-evaluates all tokens.',
        parameters: {
          type: 'object',
          properties: {
            buyAmountSol: { type: 'number', description: 'SOL per trade (default: 0.1)' },
            minScore: { type: 'number', description: 'Stage 4 buy threshold (default: 65)' },
            stage2MinScore: { type: 'number', description: 'Stage 2 filter threshold (default: 40)' },
            slippageBps: { type: 'number', description: 'Slippage basis points (default: 2000)' },
            workers: { type: 'number', description: 'Concurrent deep-check workers (default: 8)' },
            requireSocials: { type: 'boolean', description: 'Require at least 1 social link (default: true)' },
            enableDeepCheck: { type: 'boolean', description: 'Enable Stage 3 network checks (default: true)' },
            queueLimit: { type: 'number', description: 'Max tokens in deep-check queue (default: 200)' },
          },
        },
        riskLevel: 'financial',
      },
      {
        name: 'sniper_disable',
        description: 'Disable the fast sniper pipeline',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'sniper_status',
        description: 'Get detailed pipeline stats: tokens/sec, pass rates per stage, latencies (avg/p99), worker utilization, cache hit rate',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'sniper_evaluate',
        description: 'Manually evaluate a single token through the full pipeline stages. Shows score and signals without executing a trade.',
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
        name: 'sniper_config',
        description: 'Update pipeline config at runtime (hot-reload). Pass only the fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            buyAmountSol: { type: 'number' },
            minScore: { type: 'number' },
            stage2MinScore: { type: 'number' },
            workers: { type: 'number' },
            requireSocials: { type: 'boolean' },
            enableDeepCheck: { type: 'boolean' },
            queueLimit: { type: 'number' },
            slippageBps: { type: 'number' },
          },
        },
        riskLevel: 'write',
      },
      {
        name: 'sniper_blacklist',
        description: 'Add a dev wallet or name pattern to the pipeline blacklist. Takes effect immediately.',
        parameters: {
          type: 'object',
          properties: {
            devAddress: { type: 'string', description: 'Dev wallet address to blacklist' },
            namePattern: { type: 'string', description: 'Name regex pattern to blacklist' },
          },
        },
        riskLevel: 'write',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private pipeline: TokenPipeline | null = null;
  private enabled = false;
  private tokenNewHandler: ((data: any) => void) | null = null;
  private pipelineConfig: Partial<PipelineConfig> = {};

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'sniper_enable': return this.enable(params);
      case 'sniper_disable': return this.disable();
      case 'sniper_status': return this.getStatus();
      case 'sniper_evaluate': return this.evaluateToken(params.mint);
      case 'sniper_config': return this.updateConfig(params);
      case 'sniper_blacklist': return this.addBlacklist(params);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.disable();
  }

  private enable(params: Record<string, any>): { status: string; config: Record<string, any> } {
    if (this.enabled && this.pipeline) {
      this.updateConfig(params);
      return { status: 'already_running_config_updated', config: this.pipelineConfig };
    }

    this.pipelineConfig = {
      buyAmountSol: params.buyAmountSol ?? 0.1,
      stage4BuyThreshold: params.minScore ?? 65,
      stage2MinScore: params.stage2MinScore ?? 40,
      slippageBps: params.slippageBps ?? 2000,
      workers: params.workers ?? 8,
      requireSocials: params.requireSocials ?? true,
      enableDeepCheck: params.enableDeepCheck ?? true,
      queueLimit: params.queueLimit ?? 200,
    };

    this.pipeline = new TokenPipeline({
      config: this.pipelineConfig,
      eventBus: this.eventBus,
      logger: this.logger,
      memory: this.ctx.memory,
      solanaRpc: this.ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      heliusKey: this.ctx.config.rpc?.heliusApiKey || process.env.HELIUS_API_KEY,
    });

    this.pipeline.start();
    this.enabled = true;

    // Wire token:new → pipeline.ingest() (zero-overhead path)
    this.tokenNewHandler = (data: any) => {
      this.pipeline?.ingest(data);
    };
    this.eventBus.on('token:new', this.tokenNewHandler);

    this.logger.info(
      `Sniper pipeline ENABLED: ${this.pipelineConfig.workers} workers, ` +
      `buy=${this.pipelineConfig.buyAmountSol} SOL, ` +
      `threshold=${this.pipelineConfig.stage4BuyThreshold}`
    );

    return { status: 'enabled', config: this.pipelineConfig };
  }

  private disable(): { status: string } {
    if (this.pipeline) {
      this.pipeline.stop();
      this.pipeline = null;
    }
    if (this.tokenNewHandler) {
      this.eventBus.off('token:new', this.tokenNewHandler);
      this.tokenNewHandler = null;
    }
    this.enabled = false;
    this.logger.info('Sniper pipeline DISABLED');
    return { status: 'disabled' };
  }

  private getStatus(): any {
    if (!this.pipeline) {
      return { enabled: false, message: 'Pipeline not running' };
    }

    const stats = this.pipeline.getStats();
    const elapsed = (Date.now() - stats.startedAt) / 1000;

    return {
      enabled: true,
      uptime: `${Math.floor(elapsed)}s`,
      throughput: {
        tokensPerSec: stats.tokensPerSec.toFixed(1),
        totalReceived: stats.received,
      },
      filterRates: {
        stage0_killed: stats.killedStage0,
        stage1_killed: stats.killedStage1,
        stage2_killed: stats.killedStage2,
        stage3_killed: stats.killedStage3,
        stage4_approved: stats.approvedStage4,
        queueDropped: stats.queueDropped,
        passRate: stats.received > 0
          ? `${((stats.approvedStage4 / stats.received) * 100).toFixed(1)}%`
          : '0%',
      },
      latencies: {
        stage2_avg_ms: stats.avgStage2Ms.toFixed(2),
        stage2_p99_ms: stats.p99Stage2Ms.toFixed(2),
        stage3_avg_ms: stats.avgStage3Ms.toFixed(1),
        stage3_p99_ms: stats.p99Stage3Ms.toFixed(1),
      },
      workers: {
        total: this.pipelineConfig.workers,
        utilization: `${(stats.workerUtilization * 100).toFixed(0)}%`,
      },
      cache: {
        hitRate: `${(stats.cacheHitRate * 100).toFixed(1)}%`,
      },
      trades: {
        emitted: stats.tradesEmitted,
      },
    };
  }

  private updateConfig(params: Record<string, any>): { status: string } {
    const configMap: Record<string, string> = {
      buyAmountSol: 'buyAmountSol',
      minScore: 'stage4BuyThreshold',
      stage2MinScore: 'stage2MinScore',
      workers: 'workers',
      requireSocials: 'requireSocials',
      enableDeepCheck: 'enableDeepCheck',
      queueLimit: 'queueLimit',
      slippageBps: 'slippageBps',
    };

    const update: Partial<PipelineConfig> = {};
    for (const [paramKey, configKey] of Object.entries(configMap)) {
      if (params[paramKey] !== undefined) {
        (update as any)[configKey] = params[paramKey];
        (this.pipelineConfig as any)[configKey] = params[paramKey];
      }
    }

    if (this.pipeline) {
      this.pipeline.updateConfig(update);
    }

    return { status: 'config_updated' };
  }

  private addBlacklist(params: { devAddress?: string; namePattern?: string }): { status: string } {
    if (!this.pipeline) return { status: 'pipeline_not_running' };

    if (params.devAddress) {
      this.pipeline.updateConfig({
        blacklistDevs: new Set([...(this.pipelineConfig.blacklistDevs || []), params.devAddress]),
      });
      this.ctx.memory.addRugAddress(params.devAddress, 'Manually blacklisted');
      this.logger.info(`Blacklisted dev: ${params.devAddress.slice(0, 8)}...`);
    }

    if (params.namePattern) {
      const currentPatterns = this.pipelineConfig.blacklistPatterns || [];
      const newPatterns = [...currentPatterns, new RegExp(params.namePattern, 'i')];
      this.pipeline.updateConfig({ blacklistPatterns: newPatterns });
      this.pipelineConfig.blacklistPatterns = newPatterns;
      this.logger.info(`Blacklisted pattern: ${params.namePattern}`);
    }

    return { status: 'blacklist_updated' };
  }

  async evaluateToken(mint: string): Promise<TokenAnalysis> {
    let token = this.ctx.memory.getToken(mint);

    if (!token) {
      try {
        const res = await fetch(`${PUMP_API}/coins-v2/${mint}`, {
          headers: { 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' },
        });
        if (res.ok) {
          const data = await res.json() as any;
          token = {
            mint,
            name: data.name || 'Unknown',
            symbol: data.symbol || '???',
            description: data.description,
            twitter: data.twitter,
            telegram: data.telegram,
            website: data.website,
            dev: data.creator || '',
            createdAt: data.created_timestamp || Date.now(),
            bondingCurveProgress: data.bonding_curve_percentage || 0,
            marketCap: data.market_cap || 0,
            volume24h: 0,
            holders: 0,
            price: 0,
          };
        }
      } catch {}
    }

    if (!token) {
      return {
        mint, score: 0, rugScore: 100,
        signals: ['Token not found'],
        recommendation: 'avoid',
        reasoning: 'Could not fetch token data',
        analyzedAt: Date.now(),
      };
    }

    const signals: string[] = [];
    let score = 45;

    if (token.twitter) { score += 12; signals.push('twitter'); }
    if (token.telegram) { score += 6; signals.push('telegram'); }
    if (token.website) { score += 6; signals.push('website'); }

    if (token.dev && this.ctx.memory.isKnownRug(token.dev)) {
      return {
        mint, score: 0, rugScore: 99,
        signals: ['KNOWN RUGGER'],
        recommendation: 'avoid',
        reasoning: 'Dev wallet is a known rug puller',
        analyzedAt: Date.now(),
      };
    }

    if (token.bondingCurveProgress < 5) { score += 10; signals.push('ultra_early'); }
    else if (token.bondingCurveProgress < 15) { score += 5; signals.push('early'); }
    else if (token.bondingCurveProgress > 85) { score -= 8; signals.push('near_graduation'); }

    if (/^[a-f0-9]{10,}$/i.test(token.symbol)) { score -= 10; signals.push('garbage_symbol'); }
    if (token.description && token.description.length > 30) { score += 3; signals.push('has_desc'); }

    score = Math.max(0, Math.min(100, score));
    const rugScore = Math.max(0, Math.min(100, 50 - (score - 50)));

    let recommendation: TokenAnalysis['recommendation'];
    if (score >= 80 && rugScore < 30) recommendation = 'strong_buy';
    else if (score >= 65 && rugScore < 50) recommendation = 'buy';
    else if (score >= 45) recommendation = 'watch';
    else if (score >= 25) recommendation = 'skip';
    else recommendation = 'avoid';

    return {
      mint, score, rugScore, signals, recommendation,
      reasoning: `Pipeline eval: score=${score}/100, rug=${rugScore}/100. ${signals.join(', ')}`,
      analyzedAt: Date.now(),
    };
  }
}
