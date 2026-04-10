
import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
} from '../types.ts';
import { JobManager, CreateJobParams, JobStatus, JobPriority } from '../core/job-manager.ts';

export class BackgroundJobsSkill implements Skill {
  manifest: SkillManifest = {
    name: 'background-jobs',
    version: '1.0.0',
    description: 'Schedule and manage background jobs — timed monitoring, periodic checks, recurring tasks',
    tools: [
      {
        name: 'create_background_job',
        description: 'Create a background job that runs periodically. MUST USE when user says: "watch", "monitor", "track", "create job", or any request for periodic/repeated checking. Examples: "watch Twitter for 15 min", "monitor token every 5 min", "check wallet every hour". The prompt is executed every interval_minutes for duration_minutes total time. Set max_runs=1 for a single execution. IMPORTANT: If a job with the same name already exists and is active, it will NOT be duplicated — you will get the existing job back. Do NOT create multiple jobs for the same task.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Short descriptive name for the job (e.g., "Twitter Monitor", "Token Watch PEPE")',
            },
            prompt: {
              type: 'string',
              description: 'The task/prompt to execute on each run. Be specific about what to do and what to report.',
            },
            interval_minutes: {
              type: 'number',
              description: 'How often to run (in minutes). Default: 3. Use 1-5 for active monitoring, 10-30 for passive checks.',
            },
            duration_minutes: {
              type: 'number',
              description: 'Total duration to keep the job active (in minutes). REQUIRED — match the user request. E.g., 15 for "watch 15 min", 60 for 1 hour. Default: 30.',
            },
            max_runs: {
              type: 'number',
              description: 'Maximum number of times to execute. 0 = unlimited (until duration expires). Set 1 for a single one-time execution.',
            },
            delay_minutes: {
              type: 'number',
              description: 'Delay before first run (minutes). 0 = start immediately.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags for categorization (e.g., ["twitter", "monitoring"])',
            },
            priority: {
              type: 'string',
              enum: ['high', 'normal', 'low'],
              description: 'Job priority. high = runs first when multiple jobs compete. Default: normal.',
            },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of job IDs this job depends on. Will not start until all dependencies complete.',
            },
          },
          required: ['name', 'prompt'],
        },
        riskLevel: 'write',
      },
      {
        name: 'list_background_jobs',
        description: 'List all background jobs with their status, schedule, and run count. Filter by status optionally.',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['active', 'paused', 'completed', 'cancelled', 'failed'],
              description: 'Filter by job status. Omit to show all.',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag.',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'get_job_results',
        description: 'Get the execution results/output from a specific background job. Shows what the AI found/reported during each run.',
        parameters: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID (e.g., "job_abc123")',
            },
            limit: {
              type: 'number',
              description: 'Number of recent results to return (default: 5)',
            },
          },
          required: ['job_id'],
        },
        riskLevel: 'read',
      },
      {
        name: 'cancel_background_job',
        description: 'Cancel/stop a background job. The job will not run again.',
        parameters: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID to cancel',
            },
          },
          required: ['job_id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'pause_background_job',
        description: 'Pause a running background job. Can be resumed later.',
        parameters: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID to pause',
            },
          },
          required: ['job_id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'resume_background_job',
        description: 'Resume a previously paused background job.',
        parameters: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'The job ID to resume',
            },
          },
          required: ['job_id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'get_job_stats',
        description: 'Get overview statistics for the background jobs system: total jobs, active, completed, total runs, etc.',
        parameters: {
          type: 'object',
          properties: {},
        },
        riskLevel: 'read',
      },
    ],
  };

  private logger!: LoggerInterface;
  private jobManager: JobManager | null = null;

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;

  }

  setJobManager(jm: JobManager): void {
    this.jobManager = jm;
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    if (!this.jobManager) {
      return { error: 'Background jobs system not initialized yet. Try again in a moment.' };
    }

    switch (tool) {
      case 'create_background_job':
        return this.createJob(params);
      case 'list_background_jobs':
        return this.listJobs(params);
      case 'get_job_results':
        return this.getResults(params);
      case 'cancel_background_job':
        return this.cancelJob(params);
      case 'pause_background_job':
        return this.pauseJob(params);
      case 'resume_background_job':
        return this.resumeJob(params);
      case 'get_job_stats':
        return this.getStats();
      default:
        return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {}


  private createJob(params: Record<string, any>): any {
    const name = String(params.name || '').slice(0, 100);
    const prompt = String(params.prompt || '').slice(0, 5000);

    if (!name) return { error: 'Job name is required' };
    if (!prompt) return { error: 'Job prompt/task is required' };


    const existing = this.jobManager!.findDuplicate(name, prompt);
    if (existing) {
      const remainMin = existing.expiresAt > 0
        ? Math.max(0, Math.round((existing.expiresAt - Date.now()) / 60_000))
        : null;
      return {
        success: true,
        duplicate: true,
        job_id: existing.id,
        name: existing.name,
        status: existing.status,
        priority: existing.priority,
        total_runs: existing.totalRuns,
        message: `Job "${name}" already exists and is ${existing.status} (${existing.id}).` +
          (remainMin !== null ? ` Time remaining: ${remainMin} min.` : '') +
          ` Use resume/restart if needed. No new job created.`,
      };
    }

    const continuous = Boolean(params.continuous);
    const intervalMinutes = Math.max(1, Math.min(1440, Number(params.interval_minutes) || 3));
    const durationMinutes = Math.max(0, Math.min(10080, Number(params.duration_minutes) || 30));
    const maxRuns = Math.max(0, Math.min(1000, Number(params.max_runs) || 0));
    const delayMinutes = Math.max(0, Math.min(1440, Number(params.delay_minutes) || 0));

    const priority: JobPriority = ['high', 'normal', 'low'].includes(params.priority) ? params.priority : 'normal';
    const dependsOn: string[] = Array.isArray(params.depends_on) ? params.depends_on.map(String).slice(0, 10) : [];

    const createParams: CreateJobParams = {
      name,
      prompt,
      schedule: 'interval',
      intervalMinutes,
      durationMinutes: durationMinutes || undefined,
      maxRuns: maxRuns || undefined,
      delayMinutes: delayMinutes || undefined,
      tags: Array.isArray(params.tags) ? params.tags.map(String).slice(0, 10) : [],
      continuous,
      priority,
      dependsOn,
    };

    const job = this.jobManager!.createJob(createParams);

    const schedDesc = continuous
      ? `continuous monitoring for ${durationMinutes} min`
      : `every ${intervalMinutes} min` + (durationMinutes > 0 ? ` for ${durationMinutes} min` : ' (indefinite)');

    return {
      success: true,
      job_id: job.id,
      name: job.name,
      priority: job.priority,
      schedule: schedDesc,
      depends_on: job.dependsOn.length > 0 ? job.dependsOn : undefined,
      starts_at: job.startsAt === job.createdAt ? 'immediately' : new Date(job.startsAt).toISOString(),
      expires_at: job.expiresAt > 0 ? new Date(job.expiresAt).toISOString() : 'never',
      message: `Background job "${name}" created (${job.id}). Priority: ${job.priority}. Schedule: ${schedDesc}.` +
        (job.dependsOn.length > 0 ? ` Depends on: ${job.dependsOn.join(', ')}` : ''),
    };
  }

  private listJobs(params: Record<string, any>): any {
    const filter: { status?: JobStatus; tag?: string; priority?: JobPriority } = {};
    if (params.status) filter.status = params.status as JobStatus;
    if (params.tag) filter.tag = String(params.tag);
    if (params.priority) filter.priority = params.priority as JobPriority;

    const jobs = this.jobManager!.listJobs(filter);

    if (jobs.length === 0) {
      return { jobs: [], message: 'No background jobs found.' };
    }

    return {
      jobs: jobs.map(j => ({
        id: j.id,
        name: j.name,
        status: j.status,
        priority: j.priority,
        schedule: j.schedule,
        interval: j.intervalMs ? `${j.intervalMs / 60_000} min` : 'N/A',
        total_runs: j.totalRuns,
        max_runs: j.maxRuns || 'unlimited',
        created: new Date(j.createdAt).toISOString(),
        expires: j.expiresAt > 0 ? new Date(j.expiresAt).toISOString() : 'never',
        next_run: j.status === 'active' ? new Date(j.nextRunAt).toISOString() : 'N/A',
        tags: j.tags,
        last_error: j.lastError,
        depends_on: j.dependsOn.length > 0 ? j.dependsOn : undefined,
        time_remaining: j.expiresAt > 0 ? `${Math.max(0, Math.round((j.expiresAt - Date.now()) / 60_000))} min` : 'N/A',
      })),
      count: jobs.length,
    };
  }

  private getResults(params: Record<string, any>): any {
    const jobId = String(params.job_id || '');
    if (!jobId) return { error: 'job_id is required' };

    const job = this.jobManager!.getJob(jobId);
    if (!job) return { error: `Job "${jobId}" not found` };

    const limit = Math.max(1, Math.min(20, Number(params.limit) || 5));
    const results = this.jobManager!.getJobResults(jobId, limit);

    return {
      job_id: jobId,
      job_name: job.name,
      status: job.status,
      total_runs: job.totalRuns,
      results: results.map(r => ({
        run_id: r.id,
        status: r.status,
        started: new Date(r.startedAt).toISOString(),
        duration: `${(r.durationMs / 1000).toFixed(1)}s`,
        response: r.response,
        error: r.error,
      })),
    };
  }

  private cancelJob(params: Record<string, any>): any {
    const jobId = String(params.job_id || '');
    if (!jobId) return { error: 'job_id is required' };

    const ok = this.jobManager!.cancelJob(jobId);
    if (!ok) return { error: `Could not cancel job "${jobId}". It may not exist or is already stopped.` };

    return { success: true, message: `Job "${jobId}" has been cancelled.` };
  }

  private pauseJob(params: Record<string, any>): any {
    const jobId = String(params.job_id || '');
    if (!jobId) return { error: 'job_id is required' };

    const ok = this.jobManager!.pauseJob(jobId);
    if (!ok) return { error: `Could not pause job "${jobId}". It may not be active.` };

    return { success: true, message: `Job "${jobId}" has been paused.` };
  }

  private resumeJob(params: Record<string, any>): any {
    const jobId = String(params.job_id || '');
    if (!jobId) return { error: 'job_id is required' };

    const ok = this.jobManager!.resumeJob(jobId);
    if (!ok) return { error: `Could not resume job "${jobId}". It may not be paused.` };

    return { success: true, message: `Job "${jobId}" has been resumed.` };
  }

  private getStats(): any {
    return {
      ...this.jobManager!.getStats(),
      message: 'Background jobs system statistics',
    };
  }
}
