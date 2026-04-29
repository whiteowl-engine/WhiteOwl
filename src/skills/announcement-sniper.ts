import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  Skill,
  SkillManifest,
  SkillContext,
  LoggerInterface,
  EventBusInterface,
} from '../types.ts';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'announcement-triggers.json');
const HISTORY_PATH = path.join(PROJECT_ROOT, 'data', 'announcement-history.json');
const HISTORY_MAX = 200;

export interface AnnouncementPattern {
  id: string;
  label: string;
  direction: 'long' | 'short';
  weight: number;
  keywords: string[];
}

export interface AnnouncementConfig {
  version: number;
  enabled: boolean;
  paperMode: boolean;
  minSignalScore: number;
  cooldownMs: number;
  perAssetCooldownMs: number;
  maxTradesPerDay: number;
  defaultPositionSol: number;
  autoExecute: boolean;
  venuePreference: 'solana' | 'hyperliquid' | 'auto';
  patterns: AnnouncementPattern[];
  negativePatterns: AnnouncementPattern[];
}

export interface AnnouncementDetection {
  id: string;
  ts: number;
  source: 'gmgn-twitter' | 'news' | 'manual' | 'social-monitor';
  patternId: string;
  patternLabel: string;
  direction: 'long' | 'short';
  score: number;
  matchedKeywords: string[];
  text: string;
  mint?: string;
  symbol?: string;
  url?: string;
  status: 'detected' | 'skipped' | 'paper-traded' | 'live-traded' | 'expired';
  notes?: string;
}

const DEFAULT_CONFIG: AnnouncementConfig = {
  version: 1,
  enabled: true,
  paperMode: true,
  minSignalScore: 85,
  cooldownMs: 600_000,
  perAssetCooldownMs: 1_800_000,
  maxTradesPerDay: 5,
  defaultPositionSol: 0.25,
  autoExecute: false,
  venuePreference: 'solana',
  patterns: [],
  negativePatterns: [],
};

export class AnnouncementSniperSkill implements Skill {
  manifest: SkillManifest = {
    name: 'announcement-sniper',
    version: '0.1.0',
    description:
      'Detects high-signal token announcements (buybacks, listings, revenue share, exploits) from Twitter/news streams and routes them to the trading layer. Phase 1: Solana-only detection + paper hooks.',
    tools: [
      {
        name: 'announcement_status',
        description:
          'Get current announcement-sniper status: enabled/paper mode, today\'s trade count, cooldowns, recent detections.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'announcement_configure',
        description:
          'Update announcement-sniper config. Use to enable/disable detection, switch paper/live mode, adjust thresholds.',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            paperMode: { type: 'boolean' },
            minSignalScore: { type: 'number', description: '0-100, default 85' },
            autoExecute: { type: 'boolean', description: 'If false, only emits signals; user must confirm.' },
            defaultPositionSol: { type: 'number' },
            maxTradesPerDay: { type: 'number' },
            venuePreference: { type: 'string', enum: ['solana', 'hyperliquid', 'auto'] },
          },
        },
        riskLevel: 'write',
      },
      {
        name: 'announcement_active',
        description: 'List currently active (un-acted) announcement detections.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max items (default 20)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'announcement_history',
        description: 'Get past announcement detections and their outcomes.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max items (default 50)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'announcement_test',
        description:
          'Run a text sample through the classifier without emitting any trade signal. Useful for tuning patterns.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            mint: { type: 'string' },
          },
          required: ['text'],
        },
        riskLevel: 'read',
      },
      {
        name: 'announcement_skip',
        description: 'Mark an active detection as skipped (dismiss without trading).',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'announcement_approve',
        description: 'Manually approve an active detection: emits the trade signal honoring paperMode. Used when autoExecute is off.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            sizeSol: { type: 'number', description: 'Optional override for default position size' },
          },
          required: ['id'],
        },
        riskLevel: 'high',
      },
      {
        name: 'announcement_pattern_add',
        description: 'Add a custom announcement pattern (keywords trigger detection).',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            direction: { type: 'string', enum: ['long', 'short'] },
            weight: { type: 'number', description: '0-100' },
            keywords: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'label', 'direction', 'weight', 'keywords'],
        },
        riskLevel: 'write',
      },
      {
        name: 'announcement_pattern_remove',
        description: 'Remove an announcement pattern by id.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        riskLevel: 'write',
      },
    ],
  };

  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private config: AnnouncementConfig = { ...DEFAULT_CONFIG };
  private active: AnnouncementDetection[] = [];
  private history: AnnouncementDetection[] = [];
  private globalCooldownUntil = 0;
  private perAssetCooldown = new Map<string, number>();
  private todayCount = 0;
  private dayStart = startOfDayMs();
  private boundHandlers: Array<{ event: string; handler: (data: any) => void }> = [];

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

    this.loadConfig();
    this.loadHistory();
    this.bindEvents();

    this.logger.info(
      `[AnnouncementSniper] Initialized — enabled=${this.config.enabled} paper=${this.config.paperMode} ` +
        `patterns=${this.config.patterns.length}+${this.config.negativePatterns.length}`
    );
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'announcement_status':
        return this.getStatus();
      case 'announcement_configure':
        return this.configure(params);
      case 'announcement_active':
        return { items: this.active.slice(0, params.limit || 20) };
      case 'announcement_history':
        return { items: this.history.slice(-(params.limit || 50)).reverse() };
      case 'announcement_test':
        return this.classify(params.text || '', params.mint);
      case 'announcement_skip':
        return this.skipDetection(params.id);
      case 'announcement_approve':
        return this.approveDetection(params.id, params.sizeSol);
      case 'announcement_pattern_add':
        return this.addPattern(params as AnnouncementPattern);
      case 'announcement_pattern_remove':
        return this.removePattern(params.id);
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.persistHistory();
  }

  private bindEvents(): void {
    const onTweet = (data: any) => {
      try {
        const text = normalizeAnnouncementText([data?.analysis, data?.relatedAnalysis]);
        if (!text) return;
        this.process({
          source: 'gmgn-twitter',
          text,
          mint: typeof data?.mint === 'string' ? data.mint : undefined,
        });
      } catch (err: any) {
        this.logger.debug(`[AnnouncementSniper] gmgn:tweet handler error: ${err.message}`);
      }
    };
    this.eventBus.on('gmgn:tweet' as any, onTweet);
    this.boundHandlers.push({ event: 'gmgn:tweet', handler: onTweet });

    const onNews = (data: any) => {
      try {
        const item = data?.item;
        if (!item) return;
        const text = normalizeAnnouncementText([item.title, item.summary, item.description]);
        if (!text) return;
        const mint = Array.isArray(item.mentioned_tokens) && item.mentioned_tokens.length > 0
          ? item.mentioned_tokens[0]
          : undefined;
        this.process({
          source: 'news',
          text,
          mint: typeof mint === 'string' ? mint : undefined,
          url: item.url,
        });
      } catch (err: any) {
        this.logger.debug(`[AnnouncementSniper] news:headline handler error: ${err.message}`);
      }
    };
    this.eventBus.on('news:headline' as any, onNews);
    this.boundHandlers.push({ event: 'news:headline', handler: onNews });
  }

  private process(input: { source: AnnouncementDetection['source']; text: string; mint?: string; url?: string }): void {
    if (!this.config.enabled) return;
    this.rolloverDay();

    const result = this.classify(input.text, input.mint);
    if (!result.matched || !result.detection) return;

    const key = `${result.detection.patternId}:${result.detection.mint || result.detection.symbol || result.detection.text.slice(0, 40)}`;
    const cdUntil = this.perAssetCooldown.get(key) || 0;
    if (Date.now() < cdUntil) return;
    if (Date.now() < this.globalCooldownUntil) return;

    if (this.todayCount >= this.config.maxTradesPerDay) {
      this.logger.info('[AnnouncementSniper] daily cap reached, ignoring');
      return;
    }

    const det: AnnouncementDetection = {
      ...result.detection,
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      source: input.source,
      url: input.url,
      status: 'detected',
    };

    this.active.unshift(det);
    if (this.active.length > 50) this.active.length = 50;

    this.perAssetCooldown.set(key, Date.now() + this.config.perAssetCooldownMs);
    this.globalCooldownUntil = Date.now() + this.config.cooldownMs;

    this.logger.info(
      `[AnnouncementSniper] ${det.direction.toUpperCase()} signal — ${det.patternLabel} ` +
        `score=${det.score} mint=${det.mint || 'n/a'} kws=[${det.matchedKeywords.join(',')}]`
    );

    try {
      this.eventBus.emit('announcement:detected' as any, det);
    } catch {}

    if (det.score >= this.config.minSignalScore) {
      if (det.direction === 'long' && det.mint) {
        if (this.config.autoExecute) {
          this.todayCount++;
          this.eventBus.emit('signal:buy', {
            mint: det.mint,
            score: det.score,
            reason: `[ANNOUNCEMENT] ${det.patternLabel}: ${det.text.slice(0, 80)}`,
            agentId: 'announcement-sniper',
          });
          det.status = this.config.paperMode ? 'paper-traded' : 'live-traded';
        }
      } else if (det.direction === 'short' && det.mint) {
        if (this.config.autoExecute) {
          this.todayCount++;
          this.eventBus.emit('signal:sell', {
            mint: det.mint,
            reason: `[ANNOUNCEMENT BEARISH] ${det.patternLabel}: ${det.text.slice(0, 80)}`,
            urgency: 'high',
            agentId: 'announcement-sniper',
          });
          det.status = this.config.paperMode ? 'paper-traded' : 'live-traded';
        }
      }
    }

    this.history.push({ ...det });
    if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX);
    this.persistHistory();
  }

  private classify(rawText: string, mint?: string): {
    matched: boolean;
    detection?: Omit<AnnouncementDetection, 'id' | 'ts' | 'source' | 'status' | 'url'>;
    debug?: any;
  } {
    const cleanedText = normalizeAnnouncementText(rawText);
    const text = cleanedText.toLowerCase();
    if (text.length < 8) return { matched: false };

    const allPatterns = [...this.config.patterns, ...this.config.negativePatterns];
    let best: { p: AnnouncementPattern; matched: string[] } | null = null;

    for (const p of allPatterns) {
      const hits: string[] = [];
      for (const kw of p.keywords) {
        if (kw && text.includes(kw.toLowerCase())) hits.push(kw);
      }
      if (hits.length === 0) continue;
      if (!best || hits.length > best.matched.length || p.weight > best.p.weight) {
        best = { p, matched: hits };
      }
    }

    if (!best) return { matched: false };

    const score = Math.min(100, best.p.weight + Math.min(10, (best.matched.length - 1) * 3));

    return {
      matched: true,
      detection: {
        patternId: best.p.id,
        patternLabel: best.p.label,
        direction: best.p.direction,
        score,
        matchedKeywords: best.matched,
        text: cleanedText.slice(0, 280),
        mint,
      },
    };
  }

  private getStatus() {
    this.rolloverDay();
    return {
      enabled: this.config.enabled,
      paperMode: this.config.paperMode,
      autoExecute: this.config.autoExecute,
      minSignalScore: this.config.minSignalScore,
      defaultPositionSol: this.config.defaultPositionSol,
      maxTradesPerDay: this.config.maxTradesPerDay,
      venuePreference: this.config.venuePreference,
      tradesToday: this.todayCount,
      activeCount: this.active.length,
      historyCount: this.history.length,
      patternCount: this.config.patterns.length + this.config.negativePatterns.length,
      globalCooldownMsRemaining: Math.max(0, this.globalCooldownUntil - Date.now()),
      recent: this.active.slice(0, 5),
    };
  }

  private configure(params: Record<string, any>) {
    const allowed: Array<keyof AnnouncementConfig> = [
      'enabled', 'paperMode', 'minSignalScore', 'autoExecute',
      'defaultPositionSol', 'maxTradesPerDay', 'venuePreference',
    ];
    for (const key of allowed) {
      if (params[key] !== undefined) (this.config as any)[key] = params[key];
    }
    this.persistConfig();
    return { ok: true, config: this.config };
  }

  private skipDetection(id: string) {
    const idx = this.active.findIndex(d => d.id === id);
    if (idx === -1) return { ok: false, error: 'not found' };
    const [det] = this.active.splice(idx, 1);
    det.status = 'skipped';
    const histIdx = this.history.findIndex(h => h.id === id);
    if (histIdx !== -1) this.history[histIdx] = det;
    this.persistHistory();
    return { ok: true };
  }

  private approveDetection(id: string, sizeSol?: number) {
    const idx = this.active.findIndex(d => d.id === id);
    if (idx === -1) return { ok: false, error: 'not found' };
    const det = this.active[idx];
    if (!det.mint) return { ok: false, error: 'no mint on detection' };

    const reasonPrefix = det.direction === 'long' ? '[ANNOUNCEMENT]' : '[ANNOUNCEMENT BEARISH]';
    if (det.direction === 'long') {
      this.eventBus.emit('signal:buy', {
        mint: det.mint,
        score: det.score,
        reason: `${reasonPrefix} ${det.patternLabel} (manual approve): ${det.text.slice(0, 80)}`,
        agentId: 'announcement-sniper',
        sizeSol: sizeSol ?? this.config.defaultPositionSol,
      } as any);
    } else {
      this.eventBus.emit('signal:sell', {
        mint: det.mint,
        reason: `${reasonPrefix} ${det.patternLabel} (manual approve): ${det.text.slice(0, 80)}`,
        urgency: 'high',
        agentId: 'announcement-sniper',
      } as any);
    }

    this.todayCount++;
    det.status = this.config.paperMode ? 'paper-traded' : 'live-traded';
    det.notes = (det.notes ? det.notes + ' | ' : '') + `manually approved size=${sizeSol ?? this.config.defaultPositionSol} SOL`;
    this.active.splice(idx, 1);
    const histIdx = this.history.findIndex(h => h.id === id);
    if (histIdx !== -1) this.history[histIdx] = det;
    else this.history.push(det);
    this.persistHistory();
    this.logger.info(`[AnnouncementSniper] Manually approved ${det.id} → ${det.direction} ${det.mint?.slice(0,8)} (paper=${this.config.paperMode})`);
    return { ok: true, detection: det };
  }

  private addPattern(p: AnnouncementPattern) {
    if (!p.id || !Array.isArray(p.keywords)) return { ok: false, error: 'bad pattern' };
    const target = p.direction === 'short' ? this.config.negativePatterns : this.config.patterns;
    const existing = target.findIndex(x => x.id === p.id);
    if (existing !== -1) target[existing] = p;
    else target.push(p);
    this.persistConfig();
    return { ok: true, pattern: p };
  }

  private removePattern(id: string) {
    const before = this.config.patterns.length + this.config.negativePatterns.length;
    this.config.patterns = this.config.patterns.filter(p => p.id !== id);
    this.config.negativePatterns = this.config.negativePatterns.filter(p => p.id !== id);
    const after = this.config.patterns.length + this.config.negativePatterns.length;
    this.persistConfig();
    return { ok: true, removed: before - after };
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = { ...DEFAULT_CONFIG, ...parsed };
      } else {
        this.persistConfig();
      }
    } catch (err: any) {
      this.logger.warn(`[AnnouncementSniper] config load failed: ${err.message}`);
    }
  }

  private persistConfig(): void {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err: any) {
      this.logger.warn(`[AnnouncementSniper] config persist failed: ${err.message}`);
    }
  }

  private loadHistory(): void {
    try {
      if (!fs.existsSync(HISTORY_PATH)) return;
      const raw = fs.readFileSync(HISTORY_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        let changed = false;
        this.history = parsed.slice(-HISTORY_MAX).map((item: any) => {
          const text = normalizeAnnouncementText(item?.text);
          if (text && text !== item?.text) changed = true;
          return { ...item, text: text || item?.text || '' };
        });
        if (changed) this.persistHistory();
      }
    } catch {}
  }

  private persistHistory(): void {
    try {
      fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(this.history.slice(-HISTORY_MAX), null, 2), 'utf-8');
    } catch {}
  }

  private rolloverDay(): void {
    const now = startOfDayMs();
    if (now > this.dayStart) {
      this.dayStart = now;
      this.todayCount = 0;
    }
  }
}

function startOfDayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function normalizeAnnouncementText(value: unknown): string {
  let text = Array.isArray(value)
    ? value.filter(v => v !== undefined && v !== null && String(v).trim() && !/^(undefined|null)$/i.test(String(v).trim())).join('\n')
    : String(value ?? '');

  for (let i = 0; i < 3; i++) {
    const decoded = decodeHtmlEntities(text);
    if (decoded === text) break;
    text = decoded;
  }

  text = text
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|br|li|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/<[^<\n]*(?:>|$)/g, ' ')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');

  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(undefined|null)$/i.test(line))
    .join(' ')
    .replace(/\b(?:undefined|null)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number(code);
      return decodeCodePoint(value, _match);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const value = parseInt(code, 16);
      return decodeCodePoint(value, _match);
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip);/gi, (match, entity) => {
      const map: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        ndash: '-',
        mdash: '-',
        hellip: '...',
      };
      return map[String(entity).toLowerCase()] ?? match;
    });
}

function decodeCodePoint(value: number, fallback: string): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : fallback;
}
