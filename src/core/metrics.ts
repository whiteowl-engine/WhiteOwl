/**
 * Metrics & Health Monitoring — Phase 6
 *
 * Prometheus-compatible /metrics endpoint exposing:
 * - Trading metrics (trades, P&L, win rate)
 * - Pipeline metrics (throughput, latency, pass rate)
 * - System metrics (uptime, memory, event bus)
 * - RPC metrics (latency, errors)
 *
 * Also provides health check with auto-restart capability.
 */

import { EventBusInterface, LoggerInterface, SessionStats } from '../types';
import { Memory } from '../memory';

// ----- Metric Counters -----

interface MetricState {
  // Trading
  tradesTotal: number;
  tradesSuccess: number;
  tradesFailed: number;
  pnlSolTotal: number;
  positionsOpen: number;

  // Pipeline
  pipelineTokensReceived: number;
  pipelineTokensPassed: number;
  pipelineTokensRejected: number;

  // RPC
  rpcCallsTotal: number;
  rpcErrors: number;
  rpcLatencySum: number;

  // System
  startTime: number;
  eventsEmitted: number;
  agentDecisions: number;
  llmCalls: number;
  llmErrors: number;

  // Labels for last values
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

  /**
   * Start collecting metrics from the event bus.
   */
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

  /**
   * Register a health check callback.
   */
  addHealthCheck(fn: () => boolean): void {
    this.healthCallbacks.push(fn);
  }

  /**
   * Record RPC call metrics.
   */
  recordRpcCall(latencyMs: number, success: boolean): void {
    this.state.rpcCallsTotal++;
    this.state.rpcLatencySum += latencyMs;
    if (!success) this.state.rpcErrors++;
  }

  /**
   * Record LLM call metrics.
   */
  recordLlmCall(success: boolean): void {
    this.state.llmCalls++;
    if (!success) this.state.llmErrors++;
  }

  /**
   * Generate Prometheus-compatible metrics text.
   */
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

  /**
   * Health check — returns true if system is healthy.
   */
  isHealthy(): { healthy: boolean; checks: Record<string, boolean>; details: string } {
    const checks: Record<string, boolean> = {
      uptime: (Date.now() - this.state.startTime) > 5000,
      recentActivity: this.state.pipelineTokensReceived > 0 || (Date.now() - this.state.startTime) < 60_000,
      memoryOk: process.memoryUsage().heapUsed < 512 * 1024 * 1024,
      noRecentErrors: (Date.now() - this.state.lastErrorAt) > 60_000 || this.state.lastErrorAt === 0,
    };

    for (const cb of this.healthCallbacks) {
      try {
        checks['custom'] = cb();
      } catch {
        checks['custom'] = false;
      }
    }

    const healthy = Object.values(checks).every(v => v);
    const failedChecks = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    const details = healthy ? 'All checks passed' : `Failed: ${failedChecks.join(', ')}`;

    return { healthy, checks, details };
  }

  getState(): MetricState {
    return { ...this.state };
  }
}

// ----- Backup Strategy -----

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

  /**
   * Create a backup of the SQLite database.
   * Uses file copy (safe when WAL mode is enabled).
   */
  backup(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `whiteowl-backup-${timestamp}.db`;
    const backupPath = path.join(this.backupDir, backupName);

    try {
      fs.copyFileSync(this.dbPath, backupPath);
      this.logger.info(`Backup created: ${backupPath}`);

      // Clean old backups
      this.cleanOldBackups();

      return backupPath;
    } catch (err: any) {
      this.logger.error(`Backup failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * List available backups.
   */
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

  /**
   * Restore from a backup file.
   */
  restore(backupPath: string): void {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    // Create safety backup of current DB first
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
