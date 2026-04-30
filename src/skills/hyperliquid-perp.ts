import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
// @ts-ignore - subpath export requires bundler moduleResolution
import { formatPrice, formatSize, SymbolConverter } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';
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
  szBase?: number;
  leverage: number;
  entryPx: number;
  openedAt: number;
  closedAt?: number;
  closePx?: number;
  pnlUsd?: number;
  reason?: string;
  status: 'open' | 'closed';
  source?: 'manual' | 'announcement';
  mode?: 'paper' | 'live';
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
    version: '0.2.0',
    description:
      'Hyperliquid perp adapter with live and paper execution, public market data, and an opt-in bridge from bearish announcements to perp shorts.',
    tools: [
      {
        name: 'hl_status',
        description: 'Current Hyperliquid skill status: execution mode, live readiness, open positions, and config.',
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
        description: 'Open a Hyperliquid perp position in the active mode. Paper stores local positions; live sends a signed IOC order.',
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
        riskLevel: 'financial',
      },
      {
        name: 'hl_close',
        description: 'Close a Hyperliquid perp position by id. In live mode this sends a reduce-only IOC order.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'hl_positions',
        description: 'List Hyperliquid positions for the active mode.',
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
      `[Hyperliquid] Initialized - paper=${this.state.paperMode} sizeUsd=${this.state.defaultSizeUsd} ` +
        `lev=${this.state.defaultLeverage}x maxPos=${this.state.maxOpenPositions} ` +
        `annShorts=${this.state.enableShortFromAnnouncement} positions=${this.state.positions.filter(p => p.status === 'open').length}`
    );
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'hl_status':
        return await this.getStatus();
      case 'hl_configure':
        return await this.configure(params);
      case 'hl_funding':
        return await this.getFunding(params.coin);
      case 'hl_mark_price':
        return await this.getMarkPrice(params.coin);
      case 'hl_open':
        return await this.openPosition(params as any);
      case 'hl_close':
        return await this.closePosition(params.id);
      case 'hl_positions':
        return await this.listPositions(!!params.includeClosed);
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
          this.logger.debug('[Hyperliquid] Bearish announcement without symbol - skipping perp short');
          return;
        }
        const known = await this.isKnownPerp(coin);
        if (!known) {
          this.logger.debug(`[Hyperliquid] ${coin} not on Hyperliquid - skipping perp short`);
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

  private async getStatus() {
    const credentials = this.getLiveCredentials();
    const liveReady = !!credentials.accountAddress && !!credentials.privateKey;
    const open = this.state.paperMode
      ? this.state.positions.filter(p => p.status === 'open')
      : await this.getLivePositions(false).catch(() => []);
    const note = this.state.paperMode
      ? (liveReady
          ? 'Paper mode active. Switch off paper mode to route orders to Hyperliquid live.'
          : 'Paper mode active. Add Hyperliquid account and private key to enable live execution.')
      : (liveReady
          ? 'Live mode active. Orders use signed Hyperliquid IOC execution.'
          : 'Live mode selected, but Hyperliquid account/private key are not fully configured.');
    return {
      paperMode: this.state.paperMode,
      mode: this.state.paperMode ? 'paper' : 'live',
      defaultSizeUsd: this.state.defaultSizeUsd,
      defaultLeverage: this.state.defaultLeverage,
      maxOpenPositions: this.state.maxOpenPositions,
      enableShortFromAnnouncement: this.state.enableShortFromAnnouncement,
      apiUrl: this.getInfoUrl(),
      accountConfigured: !!credentials.accountAddress,
      apiWalletConfigured: !!credentials.apiWalletAddress,
      privateKeyConfigured: !!credentials.privateKey,
      openCount: open.length,
      totalCount: this.state.paperMode ? this.state.positions.length : open.length,
      live: !this.state.paperMode,
      liveSupported: true,
      liveReady,
      note,
    };
  }

  private async configure(patch: Partial<HLState>) {
    const allowed: (keyof HLState)[] = [
      'paperMode',
      'defaultSizeUsd',
      'defaultLeverage',
      'maxOpenPositions',
      'enableShortFromAnnouncement',
    ];
    for (const key of allowed) {
      if (patch[key] !== undefined) (this.state as any)[key] = patch[key];
    }
    this.persistState();
    if (!this.state.paperMode) {
      const credentials = this.getLiveCredentials();
      if (!credentials.accountAddress || !credentials.privateKey) {
        this.logger.warn('[Hyperliquid] Live mode selected without full credentials. Trading calls will fail until configured.');
      }
    }
    return { ok: true, status: await this.getStatus() };
  }

  private async openPosition(params: {
    coin: string;
    side: 'long' | 'short';
    szUsd?: number;
    leverage?: number;
    reason?: string;
    source?: 'manual' | 'announcement';
  }): Promise<{ ok: boolean; position?: HLPaperPosition; error?: string }> {
    if (!this.state.paperMode) {
      return await this.openLivePosition(params);
    }
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
      mode: 'paper',
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
    if (!this.state.paperMode) {
      return await this.closeLivePosition(id);
    }
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

  private async listPositions(includeClosed: boolean) {
    if (!this.state.paperMode) {
      return { items: await this.getLivePositions(includeClosed) };
    }
    const items = includeClosed
      ? this.state.positions
      : this.state.positions.filter(p => p.status === 'open');
    return { items: [...items].reverse() };
  }

  private getApiBaseUrl(): string {
    const raw = (process.env.HYPERLIQUID_API_URL || HL_INFO_URL).trim();
    const withoutInfo = raw.replace(/\/info\/?$/i, '');
    return withoutInfo.replace(/\/$/, '') || 'https://api.hyperliquid.xyz';
  }

  private getInfoUrl(): string {
    return `${this.getApiBaseUrl()}/info`;
  }

  private getLiveCredentials(): {
    accountAddress: string;
    apiWalletAddress: string;
    privateKey: string;
  } {
    return {
      accountAddress: (process.env.HYPERLIQUID_ACCOUNT_ADDRESS || '').trim(),
      apiWalletAddress: (process.env.HYPERLIQUID_API_WALLET_ADDRESS || '').trim(),
      privateKey: this.normalizePrivateKey(process.env.HYPERLIQUID_PRIVATE_KEY || ''),
    };
  }

  private normalizePrivateKey(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  }

  private createTransport(): HttpTransport {
    return new HttpTransport({ apiUrl: this.getApiBaseUrl() });
  }

  private async createLiveClients(): Promise<{
    exchange: ExchangeClient;
    converter: Awaited<ReturnType<typeof SymbolConverter.create>>;
  }> {
    const credentials = this.getLiveCredentials();
    if (!credentials.accountAddress) {
      throw new Error('Hyperliquid account address is required for live mode');
    }
    if (!credentials.privateKey) {
      throw new Error('Hyperliquid private key is required for live mode');
    }
    const transport = this.createTransport();
    const exchange = new ExchangeClient({
      transport,
      wallet: privateKeyToAccount(credentials.privateKey as `0x${string}`),
    });
    const converter = await SymbolConverter.create({ transport });
    return { exchange, converter };
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
      return !!meta.universe?.some(item => item.name?.toUpperCase() === coin);
    } catch {
      return false;
    }
  }

  private async getFunding(coinFilter?: string): Promise<any> {
    const data = await this.info<any>({ type: 'metaAndAssetCtxs' });
    const meta = data?.[0];
    const ctxs = data?.[1];
    if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return { items: [] };
    const items = meta.universe.map((item: any, index: number) => ({
      coin: item.name,
      funding: parseFloat(ctxs[index]?.funding ?? '0'),
      premium: parseFloat(ctxs[index]?.premium ?? '0'),
      markPx: parseFloat(ctxs[index]?.markPx ?? '0'),
      openInterest: parseFloat(ctxs[index]?.openInterest ?? '0'),
    }));
    if (coinFilter) {
      const coin = coinFilter.toUpperCase();
      return { items: items.filter((item: any) => item.coin?.toUpperCase() === coin) };
    }
    return { items };
  }

  private async getMarkPrice(coinFilter?: string): Promise<any> {
    const all = await this.info<Record<string, string>>({ type: 'allMids' });
    if (coinFilter) {
      const coin = coinFilter.toUpperCase();
      const key = Object.keys(all).find(item => item.toUpperCase() === coin);
      const markPx = key ? parseFloat(all[key]) : null;
      if (markPx) this.markCache.set(coin, { px: markPx, ts: Date.now() });
      return { coin, markPx };
    }
    return { mids: all };
  }

  private async getMarkPriceNumber(coin: string): Promise<number | null> {
    const cached = this.markCache.get(coin);
    if (cached && Date.now() - cached.ts < this.MARK_TTL_MS) return cached.px;
    try {
      const result = await this.getMarkPrice(coin);
      return result.markPx ?? null;
    } catch {
      return null;
    }
  }

  private async getLivePositions(_includeClosed: boolean): Promise<HLPaperPosition[]> {
    const credentials = this.getLiveCredentials();
    if (!credentials.accountAddress) return [];
    const transport = this.createTransport();
    const info = new InfoClient({ transport });
    const [state, mids] = await Promise.all([
      info.clearinghouseState({ user: credentials.accountAddress }),
      info.allMids(),
    ]);
    const assetPositions = Array.isArray((state as any)?.assetPositions) ? (state as any).assetPositions : [];
    return assetPositions
      .map((item: any) => this.mapLivePosition(item, mids, (state as any)?.time))
      .filter((item: HLPaperPosition | null): item is HLPaperPosition => !!item)
      .reverse();
  }

  private mapLivePosition(item: any, mids: Record<string, string>, snapshotTime?: number): HLPaperPosition | null {
    const position = item?.position;
    const coin = (position?.coin || '').toUpperCase();
    const signedSize = parseFloat(position?.szi ?? '0');
    if (!coin || !signedSize) return null;
    const side = signedSize > 0 ? 'long' : 'short';
    const markPx = parseFloat(mids?.[coin] ?? position?.entryPx ?? '0');
    const entryPx = parseFloat(position?.entryPx ?? '0');
    const szBase = Math.abs(signedSize);
    const szUsd = +(szBase * (markPx || entryPx || 0)).toFixed(2);
    const leverage = parseFloat(position?.leverage?.value ?? '0') || this.state.defaultLeverage;
    const pnlUsd = parseFloat(position?.unrealizedPnl ?? '0');
    return {
      id: `live:${coin}`,
      coin,
      side,
      szUsd,
      szBase,
      leverage,
      entryPx,
      openedAt: snapshotTime || Date.now(),
      pnlUsd: Number.isFinite(pnlUsd) ? +pnlUsd.toFixed(2) : undefined,
      status: 'open',
      source: 'manual',
      mode: 'live',
      reason: 'live position',
    };
  }

  private async openLivePosition(params: {
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
    const open = await this.getLivePositions(false);
    if (open.length >= this.state.maxOpenPositions) {
      return { ok: false, error: `max open positions (${this.state.maxOpenPositions}) reached` };
    }
    if (open.some(position => position.coin === coin)) {
      return { ok: false, error: `already open on ${coin}` };
    }
    const markPx = await this.getMarkPriceNumber(coin);
    if (!markPx) return { ok: false, error: 'no mark price' };
    const notionalUsd = params.szUsd ?? this.state.defaultSizeUsd;
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      return { ok: false, error: 'invalid size usd' };
    }
    try {
      const { exchange, converter } = await this.createLiveClients();
      const asset = converter.getAssetId(coin);
      const szDecimals = converter.getSzDecimals(coin);
      if (asset == null || szDecimals == null) {
        return { ok: false, error: `${coin} is not available on Hyperliquid` };
      }
      const leverage = Math.max(1, Math.round(params.leverage ?? this.state.defaultLeverage));
      await exchange.updateLeverage({ asset, isCross: true, leverage });
      const sizeBase = notionalUsd / markPx;
      const isBuy = side === 'long';
      const aggressivePx = markPx * (1 + (isBuy ? 0.01 : -0.01));
      await exchange.order({
        orders: [{
          a: asset,
          b: isBuy,
          p: formatPrice(aggressivePx, szDecimals),
          s: formatSize(String(sizeBase), szDecimals),
          r: false,
          t: { limit: { tif: 'Ioc' } },
        }],
        grouping: 'na',
      });
      const latest = await this.getLivePositions(false);
      const position = latest.find(item => item.coin === coin) || {
        id: `live:${coin}`,
        coin,
        side,
        szUsd: +notionalUsd.toFixed(2),
        szBase: +sizeBase.toFixed(6),
        leverage,
        entryPx: markPx,
        openedAt: Date.now(),
        status: 'open',
        source: params.source || 'manual',
        mode: 'live' as const,
        reason: params.reason || 'live order submitted',
      };
      this.logger.info(
        `[Hyperliquid/Live] OPEN ${side.toUpperCase()} ${coin} @ ${markPx} | ${notionalUsd} USD | ${params.reason || ''}`
      );
      this.eventBus.emit('hyperliquid:position_opened' as any, position);
      return { ok: true, position };
    } catch (err: any) {
      return { ok: false, error: err.message || 'live open failed' };
    }
  }

  private async closeLivePosition(id: string): Promise<{ ok: boolean; position?: HLPaperPosition; error?: string }> {
    const coin = (id || '').replace(/^live:/i, '').trim().toUpperCase();
    if (!coin) return { ok: false, error: 'id is required' };
    try {
      const open = await this.getLivePositions(false);
      const position = open.find(item => item.coin === coin || item.id === id);
      if (!position || !position.szBase) {
        return { ok: false, error: 'live position not found' };
      }
      const markPx = await this.getMarkPriceNumber(position.coin);
      if (!markPx) return { ok: false, error: 'no mark price' };
      const { exchange, converter } = await this.createLiveClients();
      const asset = converter.getAssetId(position.coin);
      const szDecimals = converter.getSzDecimals(position.coin);
      if (asset == null || szDecimals == null) {
        return { ok: false, error: `${position.coin} is not available on Hyperliquid` };
      }
      const isBuy = position.side === 'short';
      const aggressivePx = markPx * (1 + (isBuy ? 0.01 : -0.01));
      await exchange.order({
        orders: [{
          a: asset,
          b: isBuy,
          p: formatPrice(aggressivePx, szDecimals),
          s: formatSize(String(position.szBase), szDecimals),
          r: true,
          t: { limit: { tif: 'Ioc' } },
        }],
        grouping: 'na',
      });
      const closed: HLPaperPosition = {
        ...position,
        closePx: markPx,
        closedAt: Date.now(),
        status: 'closed',
        reason: position.reason || 'live close submitted',
      };
      this.logger.info(`[Hyperliquid/Live] CLOSE ${position.side.toUpperCase()} ${position.coin} @ ${markPx}`);
      this.eventBus.emit('hyperliquid:position_closed' as any, closed);
      return { ok: true, position: closed };
    } catch (err: any) {
      return { ok: false, error: err.message || 'live close failed' };
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
