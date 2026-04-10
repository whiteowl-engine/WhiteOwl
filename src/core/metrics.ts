
import { EventBusInterface, LoggerInterface, SessionStats } from '../types.ts';
import { Memory } from '../memory/index.ts';

interface MetricState {

  tradesTotal: number;
  tradesSuccess: number;
  tradesFailed: number;
  pnlSolTotal: number;
  positionsOpen: number;

  pipelineTokensReceived: number;
  pipelineTokensPassed: number;
  pipelineTokensRejected: number;

  rpcCallsTotal: number;
  rpcErrors: number;
  rpcLatencySum: number;

  startTime: number;
  eventsEmitted: number;
  agentDecisions: number;
  llmCalls: number;
  llmErrors: number;

  lastTradeAt: number;
  lastErrorAt: number;
}

export class MetricsCollector {
  private state: MetricState;
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private memory: Memory;
  private healthCallbacks: Array<() => boolean> = [];

  constructor(eventBus: EventBusInterface, logger: LoggerInterface, memory: Memory) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.memory = memory;
    this.state = {
      tradesTotal: 0,
      tradesSuccess: 0,
      tradesFailed: 0,
      pnlSolTotal: 0,
      positionsOpen: 0,
      pipelineTokensReceived: 0,
      pipelineTokensPassed: 0,
      pipelineTokensRejected: 0,
      rpcCallsTotal: 0,
      rpcErrors: 0,
      rpcLatencySum: 0,
      startTime: Date.now(),
      eventsEmitted: 0,
      agentDecisions: 0,
      llmCalls: 0,
      llmErrors: 0,
      lastTradeAt: 0,
      lastErrorAt: 0,
    };
  }

  start(): void {
    this.eventBus.on('trade:executed', (data) => {
      this.state.tradesTotal++;
      if (data.success) this.state.tradesSuccess++;
      else this.state.tradesFailed++;
      this.state.lastTradeAt = Date.now();
    });

    this.eventBus.on('position:opened', () => { this.state.positionsOpen++; });
    this.eventBus.on('position:closed', (data) => {
      this.state.positionsOpen = Math.max(0, this.state.positionsOpen - 1);
      this.state.pnlSolTotal += data.pnl;
    });

    this.eventBus.on('token:new', () => { this.state.pipelineTokensReceived++; });
    this.eventBus.on('signal:buy', () => { this.state.pipelineTokensPassed++; });
    this.eventBus.on('signal:rug', () => { this.state.pipelineTokensRejected++; });

    this.eventBus.on('agent:decided', () => { this.state.agentDecisions++; });
    this.eventBus.on('agent:error', () => { this.state.lastErrorAt = Date.now(); });
    this.eventBus.on('system:error', () => { this.state.lastErrorAt = Date.now(); });

    this.logger.info('Metrics collector started');
  }

  addHealthCheck(fn: () => boolean): void {
    this.healthCallbacks.push(fn);
  }

  recordRpcCall(latencyMs: number, success: boolean): void {
    this.state.rpcCallsTotal++;
    this.state.rpcLatencySum += latencyMs;
    if (!success) this.state.rpcErrors++;
  }

  recordLlmCall(success: boolean): void {
    this.state.llmCalls++;
    if (!success) this.state.llmErrors++;
  }

  getPrometheusMetrics(): string {
    const s = this.state;
    const uptimeSeconds = Math.round((Date.now() - s.startTime) / 1000);
    const memUsage = process.memoryUsage();
    const avgRpcLatency = s.rpcCallsTotal > 0 ? s.rpcLatencySum / s.rpcCallsTotal : 0;

    const lines: string[] = [
      '# HELP whiteowl_uptime_seconds Total uptime in seconds',
      '# TYPE whiteowl_uptime_seconds gauge',
      `whiteowl_uptime_seconds ${uptimeSeconds}`,
      '',
      '# HELP whiteowl_trades_total Total number of trades',
      '# TYPE whiteowl_trades_total counter',
      `whiteowl_trades_total{status="success"} ${s.tradesSuccess}`,
      `whiteowl_trades_total{status="failed"} ${s.tradesFailed}`,
      '',
      '# HELP whiteowl_pnl_sol_total Total P&L in SOL',
      '# TYPE whiteowl_pnl_sol_total gauge',
      `whiteowl_pnl_sol_total ${s.pnlSolTotal.toFixed(6)}`,
      '',
      '# HELP whiteowl_positions_open Current open positions',
      '# TYPE whiteowl_positions_open gauge',
      `whiteowl_positions_open ${s.positionsOpen}`,
      '',
      '# HELP whiteowl_pipeline_tokens_total Pipeline tokens processed',
      '# TYPE whiteowl_pipeline_tokens_total counter',
      `whiteowl_pipeline_tokens_total{stage="received"} ${s.pipelineTokensReceived}`,
      `whiteowl_pipeline_tokens_total{stage="passed"} ${s.pipelineTokensPassed}`,
      `whiteowl_pipeline_tokens_total{stage="rejected"} ${s.pipelineTokensRejected}`,
      '',
      '# HELP whiteowl_rpc_calls_total Total RPC calls',
      '# TYPE whiteowl_rpc_calls_total counter',
      `whiteowl_rpc_calls_total{status="success"} ${s.rpcCallsTotal - s.rpcErrors}`,
      `whiteowl_rpc_calls_total{status="error"} ${s.rpcErrors}`,
      '',
      '# HELP whiteowl_rpc_latency_avg_ms Average RPC latency in ms',
      '# TYPE whiteowl_rpc_latency_avg_ms gauge',
      `whiteowl_rpc_latency_avg_ms ${avgRpcLatency.toFixed(2)}`,
      '',
      '# HELP whiteowl_agent_decisions_total Agent decisions made',
      '# TYPE whiteowl_agent_decisions_total counter',
      `whiteowl_agent_decisions_total ${s.agentDecisions}`,
      '',
      '# HELP whiteowl_llm_calls_total LLM API calls',
      '# TYPE whiteowl_llm_calls_total counter',
      `whiteowl_llm_calls_total{status="success"} ${s.llmCalls - s.llmErrors}`,
      `whiteowl_llm_calls_total{status="error"} ${s.llmErrors}`,
      '',
      '# HELP whiteowl_memory_bytes Process memory usage in bytes',
      '# TYPE whiteowl_memory_bytes gauge',
      `whiteowl_memory_bytes{type="rss"} ${memUsage.rss}`,
      `whiteowl_memory_bytes{type="heapUsed"} ${memUsage.heapUsed}`,
      `whiteowl_memory_bytes{type="heapTotal"} ${memUsage.heapTotal}`,
      '',
    ];

    return lines.join('\n') + '\n';
  }

isHealthy(): { healthy: boolean; checks: Record<string, boolean>; details: string } {
    const heapUsed = process.memoryUsage().heapUsed;
    const uptimeMs = Date.now() - this.state.startTime;

    const checks: Record<string, boolean> = {
      processUp: uptimeMs >= 0,
      memoryOk: heapUsed < 512 * 1024 * 1024,

      noBurstErrors: this.state.lastErrorAt === 0 || (Date.now() - this.state.lastErrorAt) > 120_000,
    };

    for (const cb of this.healthCallbacks) {
      try {
        checks['customHealth'] = cb();
      } catch {
        checks['customHealth'] = false;
      }
    }

    const criticalKeys = ['processUp', 'memoryOk'];
    const healthy = criticalKeys.every(k => checks[k] !== false);
    const failedChecks = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    const details = healthy
      ? (failedChecks.length ? `OK (note: ${failedChecks.join(', ')})` : 'All checks passed')
      : `Failed: ${failedChecks.join(', ')}`;

    return { healthy, checks, details };
  }

  getState(): MetricState {
    return { ...this.state };
  }
}


import * as fs from 'fs';
import * as path from 'path';

export class BackupManager {
  private dbPath: string;
  private backupDir: string;
  private logger: LoggerInterface;
  private maxBackups: number;

  constructor(dbPath: string, backupDir: string, logger: LoggerInterface, maxBackups: number = 7) {
    this.dbPath = dbPath;
    this.backupDir = backupDir;
    this.logger = logger;
    this.maxBackups = maxBackups;

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
  }

backup(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `whiteowl-backup-${timestamp}.db`;
    const backupPath = path.join(this.backupDir, backupName);

    try {
      fs.copyFileSync(this.dbPath, backupPath);
      this.logger.info(`Backup created: ${backupPath}`);


      this.cleanOldBackups();

      return backupPath;
    } catch (err: any) {
      this.logger.error(`Backup failed: ${err.message}`);
      throw err;
    }
  }

listBackups(): Array<{ name: string; path: string; size: number; created: Date }> {
    const files = fs.readdirSync(this.backupDir)
      .filter(f => f.startsWith('whiteowl-backup-') && f.endsWith('.db'))
      .map(f => {
        const fullPath = path.join(this.backupDir, f);
        const stat = fs.statSync(fullPath);
        return {
          name: f,
          path: fullPath,
          size: stat.size,
          created: stat.mtime,
        };
      })
      .sort((a, b) => b.created.getTime() - a.created.getTime());

    return files;
  }

restore(backupPath: string): void {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupPath}`);
    }


    const safetyPath = this.dbPath + '.pre-restore';
    if (fs.existsSync(this.dbPath)) {
      fs.copyFileSync(this.dbPath, safetyPath);
    }

    fs.copyFileSync(backupPath, this.dbPath);
    this.logger.info(`Database restored from: ${backupPath}`);
  }

  private cleanOldBackups(): void {
    const backups = this.listBackups();
    if (backups.length <= this.maxBackups) return;

    const toDelete = backups.slice(this.maxBackups);
    for (const backup of toDelete) {
      try {
        fs.unlinkSync(backup.path);
        this.logger.debug(`Deleted old backup: ${backup.name}`);
      } catch {}
    }
  }
}
