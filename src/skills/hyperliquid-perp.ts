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
const STATE_PATH = path.join(PROJECT_ROOT, 'data', 'hyperliquid-state.json');
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

export interface HLPaperPosition {
  id: string;
  coin: string;
  side: 'long' | 'short';
  szUsd: number;
  leverage: number;
  entryPx: number;
  openedAt: number;
  closedAt?: number;
  closePx?: number;
  pnlUsd?: number;
  reason?: string;
  status: 'open' | 'closed';
  source?: 'manual' | 'announcement';
}

interface HLState {
  paperMode: boolean;
  defaultSizeUsd: number;
  defaultLeverage: number;
  maxOpenPositions: number;
  enableShortFromAnnouncement: boolean;
  positions: HLPaperPosition[];
}

const DEFAULT_STATE: HLState = {
  paperMode: true,
  defaultSizeUsd: 250,
  defaultLeverage: 3,
  maxOpenPositions: 3,
  enableShortFromAnnouncement: false,
  positions: [],
};

export class HyperliquidPerpSkill implements Skill {
  manifest: SkillManifest = {
    name: 'hyperliquid-perp',
    version: '0.1.0',
    description:
      'Hyperliquid perp adapter (Phase 4 paper-only). Read-only market data via public info endpoint, paper-mode short/long positions, and an opt-in bridge from bearish announcements to perp shorts.',
    tools: [
      {
        name: 'hl_status',
        description: 'Current Hyperliquid skill status: paper mode, open paper positions, config.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'hl_configure',
        description: 'Update config: paperMode, defaultSizeUsd, defaultLeverage, maxOpenPositions, enableShortFromAnnouncement.',
        parameters: {
          type: 'object',
          properties: {
            paperMode: { type: 'boolean' },
            defaultSizeUsd: { type: 'number' },
            defaultLeverage: { type: 'number' },
            maxOpenPositions: { type: 'number' },
            enableShortFromAnnouncement: { type: 'boolean' },
          },
        },
        riskLevel: 'write',
      },
      {
        name: 'hl_funding',
        description: 'Fetch current funding rates (predicted) from Hyperliquid public info endpoint.',
        parameters: {
          type: 'object',
          properties: { coin: { type: 'string', description: 'Optional coin symbol filter, e.g. "BTC"' } },
        },
        riskLevel: 'read',
      },
      {
        name: 'hl_mark_price',
        description: 'Fetch mark prices for all perps or a specific coin.',
        parameters: {
          type: 'object',
          properties: { coin: { type: 'string' } },
        },
        riskLevel: 'read',
      },
      {
        name: 'hl_open',
        description: 'Open a paper-mode perp position. Live mode is not supported in this build.',
        parameters: {
          type: 'object',
          properties: {
            coin: { type: 'string' },
            side: { type: 'string', enum: ['long', 'short'] },
            szUsd: { type: 'number' },
            leverage: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['coin', 'side'],
        },
        riskLevel: 'high',
      },
      {
        name: 'hl_close',
        description: 'Close a paper-mode perp position by id.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'hl_positions',
        description: 'List paper-mode perp positions (open + recent closed).',
        parameters: {
          type: 'object',
          properties: { includeClosed: { type: 'boolean' } },
        },
        riskLevel: 'read',
      },
    ],
  };

  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private state: HLState = { ...DEFAULT_STATE, positions: [] };
  private markCache = new Map<string, { px: number; ts: number }>();
  private readonly MARK_TTL_MS = 8_000;

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

    this.loadState();
    this.bindEvents();

    this.logger.info(
      `[Hyperliquid] Initialized — paper=${this.state.paperMode} sizeUsd=${this.state.defaultSizeUsd} ` +
        `lev=${this.state.defaultLeverage}x maxPos=${this.state.maxOpenPositions} ` +
        `annShorts=${this.state.enableShortFromAnnouncement} positions=${this.state.positions.filter(p => p.status === 'open').length}`
    );
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'hl_status':
        return this.getStatus();
      case 'hl_configure':
        return this.configure(params);
      case 'hl_funding':
        return await this.getFunding(params.coin);
      case 'hl_mark_price':
        return await this.getMarkPrice(params.coin);
      case 'hl_open':
        return await this.openPosition(params);
      case 'hl_close':
        return await this.closePosition(params.id);
      case 'hl_positions':
        return this.listPositions(!!params.includeClosed);
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.persistState();
  }

  private bindEvents(): void {
    this.eventBus.on('announcement:detected' as any, async (det: any) => {
      try {
        if (!this.state.enableShortFromAnnouncement) return;
        if (det?.direction !== 'short') return;
        if ((det.score ?? 0) < 85) return;
        const coin = (det.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!coin) {
          this.logger.debug('[Hyperliquid] Bearish announcement without symbol — skipping perp short');
          return;
        }
        const known = await this.isKnownPerp(coin);
        if (!known) {
          this.logger.debug(`[Hyperliquid] ${coin} not on Hyperliquid — skipping perp short`);
          return;
        }
        await this.openPosition({
          coin,
          side: 'short',
          szUsd: this.state.defaultSizeUsd,
          leverage: this.state.defaultLeverage,
          reason: `[ANNOUNCEMENT BEARISH] ${det.patternLabel}`,
          source: 'announcement',
        });
      } catch (err: any) {
        this.logger.debug(`[Hyperliquid] announcement handler error: ${err.message}`);
      }
    });
  }

  private getStatus() {
    const open = this.state.positions.filter(p => p.status === 'open');
    return {
      paperMode: this.state.paperMode,
      defaultSizeUsd: this.state.defaultSizeUsd,
      defaultLeverage: this.state.defaultLeverage,
      maxOpenPositions: this.state.maxOpenPositions,
      enableShortFromAnnouncement: this.state.enableShortFromAnnouncement,
      apiUrl: this.getInfoUrl(),
      accountConfigured: !!process.env.HYPERLIQUID_ACCOUNT_ADDRESS,
      apiWalletConfigured: !!process.env.HYPERLIQUID_API_WALLET_ADDRESS,
      privateKeyConfigured: !!process.env.HYPERLIQUID_PRIVATE_KEY,
      openCount: open.length,
      totalCount: this.state.positions.length,
      live: false,
      note: 'Phase 4 paper-only - live signing not implemented.',
    };
  }

  private configure(patch: Partial<HLState>) {
    const allowed: (keyof HLState)[] = [
      'paperMode',
      'defaultSizeUsd',
      'defaultLeverage',
      'maxOpenPositions',
      'enableShortFromAnnouncement',
    ];
    for (const k of allowed) {
      if (patch[k] !== undefined) (this.state as any)[k] = patch[k];
    }
    if (this.state.paperMode === false) {
      this.state.paperMode = true;
      this.logger.warn('[Hyperliquid] Live mode requested but not supported in this build - staying paper.');
    }
    this.persistState();
    return { ok: true, status: this.getStatus() };
  }

  private async openPosition(params: {
    coin: string;
    side: 'long' | 'short';
    szUsd?: number;
    leverage?: number;
    reason?: string;
    source?: 'manual' | 'announcement';
  }): Promise<{ ok: boolean; position?: HLPaperPosition; error?: string }> {
    const coin = (params.coin || '').toUpperCase();
    const side = params.side;
    if (!coin || (side !== 'long' && side !== 'short')) {
      return { ok: false, error: 'invalid coin/side' };
    }
    const open = this.state.positions.filter(p => p.status === 'open');
    if (open.length >= this.state.maxOpenPositions) {
      return { ok: false, error: `max open positions (${this.state.maxOpenPositions}) reached` };
    }
    if (open.some(p => p.coin === coin)) {
      return { ok: false, error: `already open on ${coin}` };
    }
    const px = await this.getMarkPriceNumber(coin);
    if (!px) return { ok: false, error: 'no mark price' };

    const pos: HLPaperPosition = {
      id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      coin,
      side,
      szUsd: params.szUsd ?? this.state.defaultSizeUsd,
      leverage: params.leverage ?? this.state.defaultLeverage,
      entryPx: px,
      openedAt: Date.now(),
      reason: params.reason,
      status: 'open',
      source: params.source || 'manual',
    };
    this.state.positions.push(pos);
    this.persistState();
    this.logger.info(
      `[Hyperliquid/Paper] OPEN ${side.toUpperCase()} ${coin} @ ${px} | ${pos.szUsd} USD x${pos.leverage} | ${pos.reason || ''}`
    );
    this.eventBus.emit('hyperliquid:position_opened' as any, pos);
    return { ok: true, position: pos };
  }

  private async closePosition(id: string): Promise<{ ok: boolean; position?: HLPaperPosition; error?: string }> {
    const pos = this.state.positions.find(p => p.id === id && p.status === 'open');
    if (!pos) return { ok: false, error: 'not found or already closed' };
    const px = await this.getMarkPriceNumber(pos.coin);
    if (!px) return { ok: false, error: 'no mark price' };
    pos.closedAt = Date.now();
    pos.closePx = px;
    pos.status = 'closed';
    const dir = pos.side === 'long' ? 1 : -1;
    const pctMove = (px - pos.entryPx) / pos.entryPx;
    pos.pnlUsd = +(pos.szUsd * pos.leverage * pctMove * dir).toFixed(2);
    this.persistState();
    this.logger.info(
      `[Hyperliquid/Paper] CLOSE ${pos.side.toUpperCase()} ${pos.coin} @ ${px} | pnl=${pos.pnlUsd} USD`
    );
    this.eventBus.emit('hyperliquid:position_closed' as any, pos);
    return { ok: true, position: pos };
  }

  private listPositions(includeClosed: boolean) {
    const items = includeClosed
      ? this.state.positions
      : this.state.positions.filter(p => p.status === 'open');
    return { items: [...items].reverse() };
  }

  private getInfoUrl(): string {
    return process.env.HYPERLIQUID_API_URL || HL_INFO_URL;
  }

  private async info<T = any>(body: any): Promise<T> {
    const res = await fetch(this.getInfoUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HL info ${res.status}`);
    return (await res.json()) as T;
  }

  private async isKnownPerp(coin: string): Promise<boolean> {
    try {
      const meta = await this.info<{ universe?: Array<{ name: string }> }>({ type: 'meta' });
      return !!meta.universe?.some(u => u.name?.toUpperCase() === coin);
    } catch {
      return false;
    }
  }

  private async getFunding(coinFilter?: string): Promise<any> {
    const data = await this.info<any>({ type: 'metaAndAssetCtxs' });
    const meta = data?.[0];
    const ctxs = data?.[1];
    if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return { items: [] };
    const items = meta.universe.map((u: any, i: number) => ({
      coin: u.name,
      funding: parseFloat(ctxs[i]?.funding ?? '0'),
      premium: parseFloat(ctxs[i]?.premium ?? '0'),
      markPx: parseFloat(ctxs[i]?.markPx ?? '0'),
      openInterest: parseFloat(ctxs[i]?.openInterest ?? '0'),
    }));
    if (coinFilter) {
      const c = coinFilter.toUpperCase();
      return { items: items.filter((x: any) => x.coin?.toUpperCase() === c) };
    }
    return { items };
  }

  private async getMarkPrice(coinFilter?: string): Promise<any> {
    const all = await this.info<Record<string, string>>({ type: 'allMids' });
    if (coinFilter) {
      const c = coinFilter.toUpperCase();
      const k = Object.keys(all).find(x => x.toUpperCase() === c);
      const px = k ? parseFloat(all[k]) : null;
      if (px) this.markCache.set(c, { px, ts: Date.now() });
      return { coin: c, markPx: px };
    }
    return { mids: all };
  }

  private async getMarkPriceNumber(coin: string): Promise<number | null> {
    const cached = this.markCache.get(coin);
    if (cached && Date.now() - cached.ts < this.MARK_TTL_MS) return cached.px;
    try {
      const r = await this.getMarkPrice(coin);
      return r.markPx ?? null;
    } catch {
      return null;
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        this.state = { ...DEFAULT_STATE, ...raw, positions: Array.isArray(raw.positions) ? raw.positions : [] };
      } else {
        this.persistState();
      }
    } catch (err: any) {
      this.logger.warn(`[Hyperliquid] Failed to load state (${err.message}), using defaults`);
      this.state = { ...DEFAULT_STATE, positions: [] };
    }
  }

  private persistState(): void {
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
    } catch (err: any) {
      this.logger?.debug?.(`[Hyperliquid] persistState failed: ${err.message}`);
    }
  }
}
