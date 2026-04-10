
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LoggerInterface, EventBusInterface } from '../types.ts';

const TICK_INTERVAL_MS = 10_000;
const MIN_REFIRE_GAP_MS = 2_000;
const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 300_000, 900_000, 1_800_000];
const MAX_CONSECUTIVE_ERRORS = 5;
const STALE_RUNNING_MS = 10 * 60_000;
const MAX_MISSED_JOBS_RESTART = 5;
const MISSED_JOB_STAGGER_MS = 5_000;
const TASK_TIMEOUT_MS = 5 * 60_000;
const CONTINUOUS_SUMMARY_TIMEOUT_MS = 3 * 60_000;
const MAX_CONCURRENT_JOBS = 3;
const RATE_LIMIT_COOLDOWN_MS = 15_000;
const PRIORITY_WEIGHTS: Record<JobPriority, number> = { high: 0, normal: 1, low: 2 };

const TRANSIENT_PATTERNS = [
  /rate.?limit/i, /429/i, /overloaded/i, /503/i, /502/i,
  /timeout/i, /timed.?out/i, /ECONNRESET/i, /ECONNREFUSED/i,
  /network/i, /fetch.?failed/i, /ETIMEDOUT/i, /server.?error/i,
];

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i, /429/i, /too.?many.?requests/i, /quota.?exceeded/i,
];

export type JobScheduleType = 'once' | 'interval';
export type JobStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type NotifyPolicy = 'all' | 'done_only' | 'silent';
export type JobPriority = 'high' | 'normal' | 'low';

export interface ContinuousState {
  iteration: number;
  findings: string[];
  startedAtMs: number;
  endAtMs: number;
  checkIntervalMs: number;
  phase: 'running' | 'summarizing' | 'done';
}

export interface Job {
  id: string;
  name: string;
  prompt: string;
  promptHash: string;
  schedule: JobScheduleType;
  intervalMs?: number;
  durationMs?: number;
  createdAt: number;
  startsAt: number;
  expiresAt: number;
  status: JobStatus;
  nextRunAt: number;
  totalRuns: number;
  maxRuns: number;
  agentId: string;
  notify: NotifyPolicy;
  tags: string[];
  results: TaskResult[];
  lastError?: string;
  continuous?: boolean;

  priority: JobPriority;

  dependsOn: string[];

  consecutiveErrors: number;
  backoffUntilMs: number;
  runningAtMs: number;

  continuousState?: ContinuousState;
}

export interface TaskResult {
  id: string;
  jobId: string;
  startedAt: number;
  completedAt: number;
  status: TaskStatus;
  response: string;
  durationMs: number;
  error?: string;
}

export interface CreateJobParams {
  name: string;
  prompt: string;
  schedule: JobScheduleType;
  intervalMinutes?: number;
  durationMinutes?: number;
  maxRuns?: number;
  delayMinutes?: number;
  agentId?: string;
  notify?: NotifyPolicy;
  tags?: string[];
  continuous?: boolean;
  priority?: JobPriority;
  dependsOn?: string[];
}

function isTransientError(err: string): boolean {
  return TRANSIENT_PATTERNS.some(p => p.test(err));
}

function isRateLimitError(err: string): boolean {
  return RATE_LIMIT_PATTERNS.some(p => p.test(err));
}

function getBackoffDelayMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return idx >= 0 ? BACKOFF_SCHEDULE_MS[idx] : 0;
}

function computePromptHash(prompt: string): string {
  const normalized = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export type JobCategory = 'monitoring' | 'trading' | 'coding' | 'research' | 'general';

export const JOB_CATEGORY_SKILLS: Record<JobCategory, string[] | null> = {
  monitoring: [
    'social-monitor', 'token-analyzer', 'gmgn', 'pump-monitor',
    'blockchain', 'web-search', 'web-intel', 'browser-eye', 'alpha-scanner',
    'holder-intelligence', 'volume-detector', 'curve-analyzer',
    'token-security', 'portfolio', 'ai-memory', 'insightx', 'wallet-tracker',
    'projects', 'terminal',
  ],
  trading: [
    'shit-trader', 'advanced-trader', 'portfolio',
    'token-analyzer', 'gmgn', 'blockchain', 'exit-optimizer',
    'copy-trade', 'curve-analyzer', 'holder-intelligence', 'token-security',
    'pump-monitor', 'ai-memory', 'projects', 'terminal', 'news-search',
  ],
  coding: ['projects', 'terminal', 'web-search', 'ai-memory'],
  research: ['web-search', 'web-intel', 'browser-eye', 'social-monitor', 'alpha-scanner', 'ai-memory', 'projects', 'terminal'],
  general: null,
};

export function classifyJobCategory(prompt: string, name: string): JobCategory {
  const text = (prompt + ' ' + name).toLowerCase();

  if (/\b(buy|sell|trade|swap|snipe|dca|grid|trailing)\b/.test(text)) return 'trading';

  if (/\b(code|build|fix bug|create file|project|npm|compile|deploy)\b/.test(text)) return 'coding';

  if (/\b(research|deep research)\b/.test(text)) return 'research';

  return 'monitoring';
}

function getJobScopeConstraints(category: JobCategory): string {
  switch (category) {
    case 'monitoring':
      return [
        '',
        '⚠️ SCOPE — MONITORING JOB:',
        '• You are a MONITORING agent. Your primary purpose is to OBSERVE and REPORT.',
        '• ABSOLUTELY FORBIDDEN: buying, selling, trading, swapping tokens. NEVER call buy_token, sell_token, fast_buy, place_order, or ANY trading tool.',
        '• If you discover something interesting — REPORT it in text. Do NOT act on it.',
        '• Allowed: read data from APIs, analyze, compare, summarize, report.',
        '• If the task requires creating/editing files or running commands — you MAY use project and terminal tools.',
      ].join('\n');
    case 'trading':
      return [
        '',
        '⚠️ SCOPE — TRADING JOB:',
        '• You may execute trades as specified in the task.',
        '• If the task requires creating/editing files or running commands — you MAY use project and terminal tools.',
      ].join('\n');
    case 'coding':
      return [
        '',
        '⚠️ SCOPE — CODING JOB:',
        '• Use project and terminal tools only.',
        '• Do NOT execute any token trades.',
      ].join('\n');
    case 'research':
      return [
        '',
        '⚠️ SCOPE — RESEARCH JOB:',
        '• Search, browse, and summarize information.',
        '• NEVER execute trades.',
        '• If the task requires creating/editing files — you MAY use project and terminal tools.',
      ].join('\n');
    default:
      return '';
  }
}

function getJobToolHints(category: JobCategory, prompt: string): string {
  if (category !== 'monitoring') return '';

  const text = prompt.toLowerCase();
  const hints: string[] = ['', '📌 USE THESE TOOLS:'];

  if (/twitter|x tracker|tweet|x\.com/.test(text)) {
    hints.push('• Twitter/X data → twitter_feed_read, twitter_feed_analyze, search_twitter, get_trending_tickers');
    hints.push('• Sentiment → analyze_sentiment, check_token_social');
    hints.push('• KOL tracking → check_kol_activity');
  }
  if (/token|pump/.test(text)) {
    hints.push('• Token info → get_token_info, analyze_token, get_trending_tokens');
    hints.push('• Prices → get_token_pairs, get_price_history');
    hints.push('• New tokens → get_new_tokens, get_new_pairs');
  }
  if (/wallet/.test(text)) {
    hints.push('• Wallet tracking → track_wallet, get_wallet_balances');
  }
  if (/alpha|scan|source/.test(text)) {
    hints.push('• Alpha → alpha_scan_now, alpha_recent, alpha_list_sources');
  }
  if (/holder|whale/.test(text)) {
    hints.push('• Holders → check_holders, get_top_holders');
  }
  if (/volume/.test(text)) {
    hints.push('• Volume → detect_wash_trading, analyze_volume');
  }

  if (hints.length <= 2) {
    hints.push('• Social → twitter_feed_read, search_twitter, get_trending_tickers');
    hints.push('• Tokens → get_trending_tokens, analyze_token, get_token_pairs');
    hints.push('• Web → google_search, fetch_url');
  }

  return hints.join('\n');
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private runningJobs = new Set<string>();
  private logger: LoggerInterface;
  private eventBus: EventBusInterface;
  private persistPath: string;
  private chatFn: ((agentId: string, message: string, jobId?: string, freshSession?: boolean) => Promise<string>) | null = null;
  private summaryFn: ((prompt: string, jobId: string) => Promise<string>) | null = null;
  private tickTimer?: ReturnType<typeof setInterval>;
  private lastTickAt = 0;
  private persistDirty = false;
  private maxResultsPerJob = 50;

  private rateLimitCooldownUntil = 0;

  constructor(logger: LoggerInterface, eventBus: EventBusInterface, dataDir: string) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.persistPath = path.join(dataDir, 'jobs.json');
    this.restore();
  }

  setChatFunction(fn: (agentId: string, message: string, jobId?: string, freshSession?: boolean) => Promise<string>): void {
    this.chatFn = fn;
  }

  setSummaryFunction(fn: (prompt: string, jobId: string) => Promise<string>): void {
    this.summaryFn = fn;
  }

  start(): void {
    this.recoverStaleJobs();
    this.catchUpMissedJobs();
    this.tickTimer = setInterval(() => this.onTick(), TICK_INTERVAL_MS);
    this.logger.info(`[Jobs] Started with ${this.jobs.size} job(s), tick every ${TICK_INTERVAL_MS / 1000}s`);
  }

stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.flushPersist();
  }


findJobByName(name: string, activeOnly = true): Job | undefined {
    const lower = name.toLowerCase();
    for (const job of this.jobs.values()) {
      if (job.name.toLowerCase() === lower) {
        if (!activeOnly || job.status === 'active' || job.status === 'paused') {
          return job;
        }
      }
    }
    return undefined;
  }

findJobByPromptHash(prompt: string, activeOnly = true): Job | undefined {
    const hash = computePromptHash(prompt);
    for (const job of this.jobs.values()) {
      if (job.promptHash === hash) {
        if (!activeOnly || job.status === 'active' || job.status === 'paused') {
          return job;
        }
      }
    }
    return undefined;
  }

findDuplicate(name: string, prompt: string): Job | undefined {
    return this.findJobByName(name) || this.findJobByPromptHash(prompt);
  }

  createJob(params: CreateJobParams): Job {
    const now = Date.now();
    const id = 'job_' + crypto.randomBytes(6).toString('hex');

    const intervalMs = params.schedule === 'interval'
      ? (params.intervalMinutes || 5) * 60_000
      : 0;

    const durationMs = params.durationMinutes
      ? params.durationMinutes * 60_000
      : 0;

    const delayMs = (params.delayMinutes || 0) * 60_000;
    const startsAt = now + delayMs;
    const expiresAt = durationMs > 0 ? startsAt + durationMs : 0;

    const isContinuous = params.continuous || false;
    const priority = params.priority || 'normal';


    const dependsOn = (params.dependsOn || []).filter(depId => this.jobs.has(depId));

    const job: Job = {
      id,
      name: params.name,
      prompt: params.prompt,
      promptHash: computePromptHash(params.prompt),
      schedule: isContinuous ? 'interval' : params.schedule,
      intervalMs: isContinuous ? 0 : intervalMs,
      durationMs,
      createdAt: now,
      startsAt,
      expiresAt,
      status: 'active',
      nextRunAt: startsAt,
      totalRuns: 0,
      maxRuns: params.maxRuns || 0,
      agentId: params.agentId || 'commander',
      notify: params.notify || 'done_only',
      tags: params.tags || [],
      results: [],
      continuous: isContinuous,
      priority,
      dependsOn,
      consecutiveErrors: 0,
      backoffUntilMs: 0,
      runningAtMs: 0,
    };


    if (isContinuous) {
      const totalMs = durationMs || 10 * 60_000;
      const checkInterval = Math.max(30_000, Math.min(120_000, Math.floor(totalMs / 10)));
      job.continuousState = {
        iteration: 0,
        findings: [],
        startedAtMs: startsAt,
        endAtMs: startsAt + totalMs,
        checkIntervalMs: checkInterval,
        phase: 'running',
      };
    }

    this.jobs.set(id, job);
    this.markDirty();

    this.logger.info(`[Jobs] Created: "${job.name}" (${isContinuous ? 'continuous' : job.schedule}, prio=${priority}, ${id})`);
    this.eventBus.emit('job:created' as any, { jobId: id, name: job.name, priority });

    return job;
  }

  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status !== 'active' && job.status !== 'paused') return false;

    job.status = 'cancelled';
    job.runningAtMs = 0;
    this.runningJobs.delete(jobId);
    this.markDirty();

    this.logger.info(`[Jobs] Cancelled: "${job.name}" (${jobId})`);
    this.eventBus.emit('job:cancelled' as any, { jobId, name: job.name });
    return true;
  }

  pauseJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'active') return false;

    job.status = 'paused';
    job.runningAtMs = 0;
    this.runningJobs.delete(jobId);
    this.markDirty();

    this.logger.info(`[Jobs] Paused: "${job.name}" (${jobId})`);
    return true;
  }

  resumeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'paused') return false;

    job.status = 'active';
    job.nextRunAt = Date.now();
    job.consecutiveErrors = 0;
    job.backoffUntilMs = 0;
    this.markDirty();

    this.logger.info(`[Jobs] Resumed: "${job.name}" (${jobId})`);
    return true;
  }

setJobPriority(jobId: string, priority: JobPriority): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.priority = priority;
    this.markDirty();
    this.logger.info(`[Jobs] Priority changed: "${job.name}" → ${priority}`);
    return true;
  }

getJobAllowedSkills(jobId: string): string[] | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const category = classifyJobCategory(job.prompt, job.name);
    return JOB_CATEGORY_SKILLS[category];
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(filter?: { status?: JobStatus; tag?: string; priority?: JobPriority }): Job[] {
    let jobs = Array.from(this.jobs.values());
    if (filter?.status) {
      jobs = jobs.filter(j => j.status === filter.status);
    }
    if (filter?.tag) {
      jobs = jobs.filter(j => j.tags.includes(filter.tag!));
    }
    if (filter?.priority) {
      jobs = jobs.filter(j => j.priority === filter.priority);
    }

    return jobs.sort((a, b) => {
      const aActive = a.status === 'active' || a.status === 'paused' ? 0 : 1;
      const bActive = b.status === 'active' || b.status === 'paused' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const aPrio = PRIORITY_WEIGHTS[a.priority] ?? 1;
      const bPrio = PRIORITY_WEIGHTS[b.priority] ?? 1;
      if (aPrio !== bPrio) return aPrio - bPrio;
      return b.createdAt - a.createdAt;
    });
  }

  getJobResults(jobId: string, limit = 10): TaskResult[] {
    const job = this.jobs.get(jobId);
    if (!job) return [];
    return job.results.slice(-limit);
  }

  getStats(): { total: number; active: number; paused: number; completed: number; cancelled: number; failed: number; totalRuns: number; rateLimited: boolean } {
    const jobs = Array.from(this.jobs.values());
    return {
      total: jobs.length,
      active: jobs.filter(j => j.status === 'active').length,
      paused: jobs.filter(j => j.status === 'paused').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      cancelled: jobs.filter(j => j.status === 'cancelled').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      totalRuns: jobs.reduce((sum, j) => sum + j.totalRuns, 0),
      rateLimited: Date.now() < this.rateLimitCooldownUntil,
    };
  }

deleteJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'active' || job.status === 'paused') return false;
    this.jobs.delete(jobId);
    this.runningJobs.delete(jobId);
    this.markDirty();
    this.logger.info(`[Jobs] Deleted: "${job.name}" (${jobId})`);
    return true;
  }

clearInactiveJobs(): number {
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
        this.jobs.delete(id);
        this.runningJobs.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.markDirty();
      this.logger.info(`[Jobs] Cleared ${removed} inactive job(s)`);
    }
    return removed;
  }

restartJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'active' || job.status === 'paused') return false;

    const now = Date.now();
    job.status = 'active';
    job.nextRunAt = now;
    job.consecutiveErrors = 0;
    job.backoffUntilMs = 0;
    job.runningAtMs = 0;
    if ((job.durationMs ?? 0) > 0) {
      job.expiresAt = now + job.durationMs!;
    }
    this.markDirty();

    this.logger.info(`[Jobs] Restarted: "${job.name}" (${jobId})`);
    this.eventBus.emit('job:created' as any, { jobId, name: job.name });
    return true;
  }

cleanup(maxAgeDays = 7): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if ((job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') && job.createdAt < cutoff) {
        this.jobs.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.markDirty();
    return removed;
  }


  private async onTick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTickAt < MIN_REFIRE_GAP_MS) return;
    this.lastTickAt = now;


    if (now < this.rateLimitCooldownUntil) {
      const waitSec = Math.round((this.rateLimitCooldownUntil - now) / 1000);
      if (waitSec % 10 === 0) {
        this.logger.warn(`[Jobs] Global rate limit cooldown: ${waitSec}s remaining`);
      }
      this.flushPersist();
      return;
    }


    const runnable = this.collectRunnableJobs(now);

    for (const job of runnable) {
      if (job.status !== 'active') continue;

      if (Date.now() < this.rateLimitCooldownUntil) {
        this.logger.warn(`[Jobs] Rate limit hit mid-tick, deferring remaining jobs`);
        break;
      }
      try {
        await this.executeJobTick(job);
      } catch (err: any) {
        this.logger.error(`[Jobs] Tick error for "${job.name}": ${err.message}`);
      }
    }

    this.sweep(now);
    this.flushPersist();
  }

  private collectRunnableJobs(now: number): Job[] {
    const runnable: Job[] = [];
    for (const job of this.jobs.values()) {
      if (this.isRunnable(job, now)) {
        runnable.push(job);
      }
    }


    runnable.sort((a, b) => {
      const pA = PRIORITY_WEIGHTS[a.priority] ?? 1;
      const pB = PRIORITY_WEIGHTS[b.priority] ?? 1;
      if (pA !== pB) return pA - pB;
      return a.nextRunAt - b.nextRunAt;
    });


    const currentlyRunning = this.runningJobs.size;
    const slots = Math.max(0, MAX_CONCURRENT_JOBS - currentlyRunning);
    if (runnable.length > slots) {
      this.logger.debug?.(`[Jobs] Concurrency cap: ${currentlyRunning} running, ${runnable.length} want to run, allowing ${slots}`);
    }
    return runnable.slice(0, slots);
  }

  private isRunnable(job: Job, now: number): boolean {
    if (job.status !== 'active') return false;
    if (this.runningJobs.has(job.id)) return false;
    if (job.runningAtMs > 0) return false;
    if (now < job.nextRunAt) return false;
    if (now < job.backoffUntilMs) return false;
    if (job.expiresAt > 0 && now >= job.expiresAt && !job.continuous) return false;
    if (job.maxRuns > 0 && job.totalRuns >= job.maxRuns) return false;


    if (job.dependsOn.length > 0) {
      for (const depId of job.dependsOn) {
        const dep = this.jobs.get(depId);
        if (dep && (dep.status === 'active' || dep.status === 'paused')) {
          return false;
        }
      }
    }

    return true;
  }


  private async executeJobTick(job: Job): Promise<void> {
    if (!this.chatFn) {
      this.logger.error(`[Jobs] No chat function — cannot execute "${job.name}"`);
      return;
    }

    if (job.continuous && job.continuousState) {
      await this.executeContinuousTick(job);
      return;
    }

    if (job.expiresAt > 0 && Date.now() >= job.expiresAt) {
      this.completeJob(job, 'expired');
      return;
    }

    if (job.maxRuns > 0 && job.totalRuns >= job.maxRuns) {
      this.completeJob(job, 'max_runs');
      return;
    }

    job.runningAtMs = Date.now();
    this.runningJobs.add(job.id);

    const taskId = 'task_' + crypto.randomBytes(4).toString('hex');
    const startedAt = Date.now();

    this.logger.info(`[Jobs] Executing: "${job.name}" [${job.priority}] run #${job.totalRuns + 1} (${taskId})`);
    this.eventBus.emit('job:task_start' as any, { jobId: job.id, taskId, name: job.name, run: job.totalRuns + 1, priority: job.priority });

    const prompt = this.buildTaskPrompt(job);
    let response = '';
    let status: TaskStatus = 'succeeded';
    let error: string | undefined;

    try {
      response = await this.executeWithTimeout(job.agentId, prompt, job.id, TASK_TIMEOUT_MS);
    } catch (err: any) {
      status = err.message?.includes('timed out') ? 'timed_out' : 'failed';
      error = err.message || 'Unknown error';
      response = `Error: ${error}`;
      this.logger.error(`[Jobs] Task failed for "${job.name}": ${error}`);
    }

    job.runningAtMs = 0;
    this.runningJobs.delete(job.id);
    const completedAt = Date.now();

    const result: TaskResult = {
      id: taskId,
      jobId: job.id,
      startedAt,
      completedAt,
      status,
      response: response.slice(0, 10_000),
      durationMs: completedAt - startedAt,
      error,
    };

    job.results.push(result);
    job.totalRuns++;
    this.trimResults(job);

    this.eventBus.emit('job:task_done' as any, {
      jobId: job.id, taskId, name: job.name,
      status, run: job.totalRuns, durationMs: result.durationMs,
    });

    this.applyJobResult(job, status, error);

    if (job.status === 'active') {
      if (job.schedule === 'interval' && job.intervalMs) {
        job.nextRunAt = Date.now() + job.intervalMs;
      } else if (job.schedule === 'once') {
        this.completeJob(job, 'one_shot');
      }
    }

    if (job.notify === 'all') {
      this.eventBus.emit('job:notify' as any, {
        jobId: job.id, name: job.name,
        message: `Job "${job.name}" run #${job.totalRuns} ${status}: ${response.slice(0, 200)}`,
      });
    }

    this.markDirty();
  }


  private async executeContinuousTick(job: Job): Promise<void> {
    if (!this.chatFn || !job.continuousState) return;
    const cs = job.continuousState;
    const now = Date.now();

    if (cs.phase === 'summarizing') {
      await this.generateContinuousSummary(job);
      return;
    }

    if (now >= cs.endAtMs) {
      cs.phase = 'summarizing';
      job.nextRunAt = now;
      this.markDirty();
      await this.generateContinuousSummary(job);
      return;
    }

    cs.iteration++;
    job.runningAtMs = now;
    this.runningJobs.add(job.id);

    const remaining = Math.max(0, cs.endAtMs - now);
    const remainingMin = Math.round(remaining / 60_000);

    this.eventBus.emit('job:task_start' as any, {
      jobId: job.id, taskId: `check_${cs.iteration}`, name: job.name,
      run: cs.iteration, continuous: true,
      durationMin: Math.round((cs.endAtMs - cs.startedAtMs) / 60_000),
    });

    const prompt = this.buildContinuousCheckPrompt(job, cs, remainingMin);

    try {
      const perCheckTimeout = Math.min(cs.checkIntervalMs * 3, 3 * 60_000);
      const response = await this.executeWithTimeout(job.agentId, prompt, job.id, perCheckTimeout);
      cs.findings.push(response);
      job.totalRuns = cs.iteration;
      job.consecutiveErrors = 0;

      this.eventBus.emit('job:task_done' as any, {
        jobId: job.id, taskId: `check_${cs.iteration}`, name: job.name,
        status: 'succeeded', run: cs.iteration, durationMs: Date.now() - now, continuous: true,
      });
    } catch (err: any) {
      cs.findings.push(`Error: ${err.message}`);
      this.logger.error(`[Jobs] Continuous check #${cs.iteration} failed for "${job.name}": ${err.message}`);
      job.consecutiveErrors++;


      if (err.message && isRateLimitError(err.message)) {
        this.triggerRateLimitCooldown(err.message);
      }

      if (job.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.logger.warn(`[Jobs] Continuous job "${job.name}" hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors, generating summary`);
        cs.phase = 'summarizing';
      }
    }

    job.runningAtMs = 0;
    this.runningJobs.delete(job.id);

    if (cs.phase === 'running') {
      const backoff = job.consecutiveErrors > 0 ? getBackoffDelayMs(job.consecutiveErrors) : 0;
      job.nextRunAt = Date.now() + Math.max(cs.checkIntervalMs, backoff);
    } else {
      job.nextRunAt = Date.now();
    }

    this.markDirty();
  }

  private async generateContinuousSummary(job: Job): Promise<void> {
    if (!this.chatFn || !job.continuousState) return;
    const cs = job.continuousState;

    job.runningAtMs = Date.now();
    this.runningJobs.add(job.id);

    this.logger.info(`[Jobs] Continuous job "${job.name}" finished ${cs.iteration} checks, generating summary...`);
    this.eventBus.emit('job:task_start' as any, {
      jobId: job.id, taskId: 'summary', name: job.name,
      run: cs.iteration + 1, summary: true,
    });

    const totalDurationMs = cs.endAtMs - cs.startedAtMs;
    let finalSummary = '';

    if (cs.findings.length === 0 || cs.findings.every(f => f.length < 20)) {
      finalSummary = `Monitoring "${job.name}" completed (${Math.round(totalDurationMs / 60_000)} min, ${cs.iteration} checks).\n\nNo data — monitoring tools may have been unavailable or returned no results.`;
    } else {
      try {
        const findingsText = cs.findings.map((f, i) => `[Check #${i + 1}] ${f.slice(0, 1500)}`).join('\n\n');
        const summaryPrompt = [
          `Compile a FINAL REPORT from the monitoring data below.`,
          `Job: "${job.name}"`,
          `Time: ${Math.round(totalDurationMs / 60_000)} min, ${cs.iteration} checks`,
          '',
          '=== DATA ===',
          findingsText.slice(0, 8000),
          '=== END ===',
          '',
          'Write a structured report in Russian:',
          '1. Brief summary (2-3 sentences)',
          '2. Key findings',
          '3. Trends / changes',
          '4. Recommendations',
          '',
          'Summarize the data above. Do NOT call any tools.',
        ].join('\n');


        if (this.summaryFn) {
          finalSummary = await Promise.race([
            this.summaryFn(summaryPrompt, job.id),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('Summary generation timed out')), CONTINUOUS_SUMMARY_TIMEOUT_MS)
            ),
          ]);
        } else {

          finalSummary = await this.executeWithTimeout(
            job.agentId, summaryPrompt, job.id, CONTINUOUS_SUMMARY_TIMEOUT_MS, true
          );
        }
      } catch (err: any) {
        finalSummary = `Report generation error: ${err.message}\n\nRaw data:\n` +
          cs.findings.map((f, i) => `#${i + 1}: ${f.slice(0, 300)}`).join('\n');
      }
    }

    const result: TaskResult = {
      id: 'task_summary_' + crypto.randomBytes(4).toString('hex'),
      jobId: job.id,
      startedAt: cs.startedAtMs,
      completedAt: Date.now(),
      status: 'succeeded',
      response: finalSummary.slice(0, 10_000),
      durationMs: totalDurationMs,
    };
    job.results.push(result);

    job.runningAtMs = 0;
    this.runningJobs.delete(job.id);
    cs.phase = 'done';
    job.status = 'completed';
    this.markDirty();

    this.logger.info(`[Jobs] Continuous job "${job.name}" completed with final summary`);
    this.eventBus.emit('job:completed' as any, { jobId: job.id, name: job.name, reason: 'continuous_done' });
    this.eventBus.emit('job:summary' as any, {
      jobId: job.id, name: job.name,
      summary: finalSummary.slice(0, 5000),
      checks: cs.iteration,
      durationMin: Math.round(totalDurationMs / 60_000),
    });

    this.notifyCompletion(job);
  }


  private applyJobResult(job: Job, status: TaskStatus, error?: string): void {
    if (status === 'succeeded') {
      job.consecutiveErrors = 0;
      job.backoffUntilMs = 0;
      job.lastError = undefined;
      return;
    }

    job.consecutiveErrors++;
    job.lastError = error;


    if (error && isRateLimitError(error)) {
      this.triggerRateLimitCooldown(error);
    }

    const isTransient = error ? isTransientError(error) : false;

    if (isTransient) {
      const backoffMs = getBackoffDelayMs(job.consecutiveErrors);
      job.backoffUntilMs = Date.now() + backoffMs;
      this.logger.warn(`[Jobs] Transient error for "${job.name}" (${job.consecutiveErrors}x), backoff ${Math.round(backoffMs / 1000)}s`);
    } else if (job.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      job.status = 'failed';
      job.lastError = `Too many consecutive failures (${job.consecutiveErrors})`;
      this.logger.error(`[Jobs] Auto-failed "${job.name}" after ${job.consecutiveErrors} consecutive failures`);
      this.eventBus.emit('job:failed' as any, { jobId: job.id, name: job.name, reason: 'consecutive_failures' });
    } else {
      const backoffMs = getBackoffDelayMs(job.consecutiveErrors);
      job.backoffUntilMs = Date.now() + backoffMs;
      this.logger.warn(`[Jobs] Error for "${job.name}" (${job.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), backoff ${Math.round(backoffMs / 1000)}s`);
    }
  }

private triggerRateLimitCooldown(errorMsg: string): void {
    const cooldownMs = RATE_LIMIT_COOLDOWN_MS;
    const until = Date.now() + cooldownMs;
    if (until > this.rateLimitCooldownUntil) {
      this.rateLimitCooldownUntil = until;
      this.logger.warn(`[Jobs] ★ Global rate limit cooldown activated: ${cooldownMs / 1000}s (triggered by: ${errorMsg.slice(0, 80)})`);
      this.eventBus.emit('job:rate_limited' as any, { cooldownMs, until, error: errorMsg.slice(0, 200) });
    }
  }


  private async executeWithTimeout(agentId: string, prompt: string, jobId: string, timeoutMs: number, freshSession = false): Promise<string> {
    return Promise.race([
      this.chatFn!(agentId, prompt, jobId, freshSession),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Task execution timed out')), timeoutMs)
      ),
    ]);
  }


  private buildTaskPrompt(job: Job): string {
    const parts: string[] = [];
    const category = classifyJobCategory(job.prompt, job.name);

    parts.push(`[BACKGROUND JOB: "${job.name}"]`);
    parts.push(`Run #${job.totalRuns + 1} | Schedule: ${job.schedule} | Priority: ${job.priority} | Mode: ${category.toUpperCase()}`);

    if (job.expiresAt > 0) {
      const remaining = Math.max(0, job.expiresAt - Date.now());
      const mins = Math.round(remaining / 60_000);
      parts.push(`Time remaining: ${mins} min`);
    }


    parts.push(getJobScopeConstraints(category));


    parts.push(getJobToolHints(category, job.prompt));


    const recentResults = job.results.slice(-3);
    if (recentResults.length > 0) {
      parts.push('');
      parts.push('--- Recent results ---');
      for (const r of recentResults) {
        const label = r.status === 'succeeded' ? 'OK' : r.status;
        parts.push(`[${label}] ${r.response.slice(0, 800)}`);
      }
      parts.push('---');
    }

    parts.push('');
    parts.push('TASK: ' + job.prompt);
    parts.push('');
    parts.push('Execute this task using ONLY the tools listed above. Be concise. Report key findings.');

    return parts.join('\n');
  }

  private buildContinuousCheckPrompt(job: Job, cs: ContinuousState, remainingMin: number): string {
    const parts: string[] = [];
    const category = classifyJobCategory(job.prompt, job.name);

    parts.push(`[MONITORING: "${job.name}"] | Mode: ${category.toUpperCase()}`);
    parts.push(`Check #${cs.iteration} | Remaining: ${remainingMin} min`);


    parts.push(getJobScopeConstraints(category));


    parts.push(getJobToolHints(category, job.prompt));

    parts.push('');
    parts.push('You MUST use the tools listed above to get REAL data. Do NOT make up information.');
    parts.push('');

    if (cs.findings.length > 0) {
      const recent = cs.findings.slice(-2);
      parts.push('--- Previous findings ---');
      for (let i = 0; i < recent.length; i++) {
        parts.push(`[Check #${cs.findings.length - recent.length + i + 1}] ${recent[i].slice(0, 600)}`);
      }
      parts.push('---');
      parts.push('');
    }

    parts.push('TASK: ' + job.prompt);
    parts.push('');
    parts.push('Use ONLY the recommended tools above. Get data, compare with previous findings, report NEW or CHANGED info.');

    return parts.join('\n');
  }


  private recoverStaleJobs(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.runningAtMs > 0) {
        const elapsed = now - job.runningAtMs;
        if (elapsed > STALE_RUNNING_MS) {
          this.logger.warn(`[Jobs] Clearing stale running marker for "${job.name}" (was running for ${Math.round(elapsed / 1000)}s)`);
          job.runningAtMs = 0;
        }
      }
    }
  }

  private catchUpMissedJobs(): void {
    const now = Date.now();
    let missedCount = 0;

    for (const job of this.jobs.values()) {
      if (job.status !== 'active') continue;
      if (job.nextRunAt > 0 && job.nextRunAt < now && job.runningAtMs === 0) {
        const missedMs = now - job.nextRunAt;
        if (missedMs > TICK_INTERVAL_MS * 2) {
          missedCount++;
          if (missedCount <= MAX_MISSED_JOBS_RESTART) {
            job.nextRunAt = now + (missedCount * MISSED_JOB_STAGGER_MS);
            this.logger.info(`[Jobs] Catch-up: "${job.name}" was ${Math.round(missedMs / 1000)}s overdue, rescheduled in ${missedCount * MISSED_JOB_STAGGER_MS / 1000}s`);
          } else {
            job.nextRunAt = now + (job.intervalMs || TICK_INTERVAL_MS);
            this.logger.info(`[Jobs] Catch-up: "${job.name}" deferred to next interval`);
          }
        }
      }
    }

    if (missedCount > 0) {
      this.markDirty();
    }
  }


  private completeJob(job: Job, reason: string): void {
    job.status = 'completed';
    job.runningAtMs = 0;
    this.runningJobs.delete(job.id);
    this.markDirty();
    this.logger.info(`[Jobs] Completed (${reason}): "${job.name}" (${job.id})`);
    this.eventBus.emit('job:completed' as any, { jobId: job.id, name: job.name, reason });
    this.notifyCompletion(job);
  }

  private notifyCompletion(job: Job): void {
    if (job.notify === 'silent') return;

    const summary = job.results.length > 0
      ? job.results[job.results.length - 1].response.slice(0, 500)
      : 'No results';

    this.eventBus.emit('job:notify' as any, {
      jobId: job.id,
      name: job.name,
      message: `Background job "${job.name}" completed after ${job.totalRuns} run(s). Last result: ${summary}`,
      final: true,
    });
  }

  private trimResults(job: Job): void {
    if (job.results.length > this.maxResultsPerJob) {
      job.results = job.results.slice(-this.maxResultsPerJob);
    }
  }


  private sweep(now: number): void {
    for (const [id, job] of this.jobs) {
      if (job.status === 'active' && job.expiresAt > 0 && now >= job.expiresAt) {
        if (job.continuous && job.continuousState?.phase === 'running') {
          job.continuousState.phase = 'summarizing';
          job.nextRunAt = now;
        } else if (!job.continuous) {
          this.completeJob(job, 'expired');
        }
      }
    }
    this.cleanup(7);
  }


  private markDirty(): void {
    this.persistDirty = true;
  }

  private flushPersist(): void {
    if (!this.persistDirty) return;
    this.persistDirty = false;
    try {
      const serializable = Array.from(this.jobs.values()).map(j => ({
        ...j,
        results: j.status === 'active' || j.status === 'paused'
          ? j.results
          : j.results.slice(-5),
      }));
      fs.writeFileSync(this.persistPath, JSON.stringify(serializable, null, 2), 'utf-8');
    } catch (err: any) {
      this.logger.error(`[Jobs] Failed to persist: ${err.message}`);
    }
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
      if (!Array.isArray(data)) return;

      for (const raw of data) {
        if (!raw.id || !raw.name || !raw.prompt) continue;
        const job: Job = {
          id: raw.id,
          name: raw.name || 'Unnamed',
          prompt: raw.prompt || '',
          promptHash: raw.promptHash || computePromptHash(raw.prompt || ''),
          schedule: raw.schedule || 'once',
          intervalMs: raw.intervalMs || 0,
          durationMs: raw.durationMs || 0,
          createdAt: raw.createdAt || Date.now(),
          startsAt: raw.startsAt || 0,
          expiresAt: raw.expiresAt || 0,
          status: raw.status || 'completed',
          nextRunAt: raw.nextRunAt || 0,
          totalRuns: raw.totalRuns || 0,
          maxRuns: raw.maxRuns || 0,
          agentId: raw.agentId || 'commander',
          notify: raw.notify || 'done_only',
          tags: raw.tags || [],
          results: Array.isArray(raw.results) ? raw.results : [],
          lastError: raw.lastError,
          continuous: raw.continuous || false,
          priority: raw.priority || 'normal',
          dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn : [],
          consecutiveErrors: raw.consecutiveErrors || 0,
          backoffUntilMs: raw.backoffUntilMs || 0,
          runningAtMs: raw.runningAtMs || 0,
          continuousState: raw.continuousState || undefined,
        };
        this.jobs.set(job.id, job);
      }

      this.logger.info(`[Jobs] Restored ${this.jobs.size} job(s) from disk`);
    } catch (err: any) {
      this.logger.error(`[Jobs] Failed to restore: ${err.message}`);
    }
  }
}
