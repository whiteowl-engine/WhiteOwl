import { Skill, SkillManifest, SkillContext, EventBusInterface, LoggerInterface, MemoryInterface } from '../types.ts';

interface VolumeProfile {
  mint: string;
  symbol: string;

  volume1m: number;
  volume5m: number;
  volume15m: number;
  txCount1m: number;
  txCount5m: number;
  uniqueWallets5m: number;

  washTradingScore: number;
  isVolumeSpike: boolean;
  spikeMultiple: number;
  organicScore: number;
  isCoordinatedPump: boolean;
  volumeTrend: 'increasing' | 'decreasing' | 'stable' | 'spike';

  alerts: string[];
  lastUpdated: number;
}

interface TradeRecord {
  mint: string;
  wallet: string;
  type: 'buy' | 'sell';
  solAmount: number;
  timestamp: number;
}

interface VolumeTracker {
  profile: VolumeProfile;
  trades: TradeRecord[];
  volumeHistory: { vol: number; ts: number }[];
  baselineVolume5m: number;
}

export class VolumeDetectorSkill implements Skill {
  manifest: SkillManifest = {
    name: 'volume-detector',
    version: '1.0.0',
    description: 'Volume anomaly detection: wash trading, spikes, organic analysis, coordinated pumps, volume decay',
    tools: [
      {
        name: 'volume_track',
        description: 'Start tracking volume for a token',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            symbol: { type: 'string', description: 'Token symbol' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'volume_untrack',
        description: 'Stop tracking volume for a token',
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
        name: 'volume_analyze',
        description: 'Get volume profile and anomaly analysis for a token',
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
        name: 'volume_wash_check',
        description: 'Check specifically for wash trading patterns',
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
        name: 'volume_spikes',
        description: 'List tokens with current volume spikes',
        parameters: {
          type: 'object',
          properties: {
            minMultiple: { type: 'number', description: 'Minimum spike multiple (default 3x)' },
            limit: { type: 'number', description: 'Max results (default 10)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'volume_organic',
        description: 'Get organic volume score for a token',
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
        name: 'volume_auto_track',
        description: 'Enable/disable automatic volume tracking for positions',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Enable auto-tracking' },
          },
          required: ['enabled'],
        },
        riskLevel: 'read',
      },
      {
        name: 'volume_stats',
        description: 'Get volume detector statistics',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private eventBus!: EventBusInterface;
  private logger!: LoggerInterface;
  private memory!: MemoryInterface;

  private trackers = new Map<string, VolumeTracker>();
  private autoTrack = false;
  private readonly TRADE_WINDOW = 15 * 60_000;
  private readonly MAX_TRACKED = 200;

  private stats = {
    totalTracked: 0,
    washTradingDetected: 0,
    volumeSpikesDetected: 0,
    coordinatedPumpsDetected: 0,
    avgOrganicScore: 0,
  };

  async initialize(ctx: SkillContext): Promise<void> {
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
    this.memory = ctx.memory;

    this.eventBus.on('position:opened', (pos) => {
      if (this.autoTrack) this.startTracking(pos.mint, pos.symbol);
    });
    this.eventBus.on('position:closed', ({ mint }) => {
      this.stopTracking(mint);
    });
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'volume_track': return this.startTracking(params.mint, params.symbol);
      case 'volume_untrack': return this.stopTracking(params.mint);
      case 'volume_analyze': return this.analyzeVolume(params.mint);
      case 'volume_wash_check': return this.checkWashTrading(params.mint);
      case 'volume_spikes': return this.getSpikes(params.minMultiple || 3, params.limit || 10);
      case 'volume_organic': return this.getOrganicScore(params.mint);
      case 'volume_auto_track': return this.setAutoTrack(params.enabled);
      case 'volume_stats': return { ...this.stats, currentlyTracking: this.trackers.size };
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.trackers.clear();
  }


recordTrade(mint: string, wallet: string, type: 'buy' | 'sell', solAmount: number): void {
    const tracker = this.trackers.get(mint);
    if (!tracker) return;

    tracker.trades.push({ mint, wallet, type, solAmount, timestamp: Date.now() });
    this.recalcProfile(tracker);
  }

getQuickFlags(mint: string): { washScore: number; organicScore: number; flags: string[] } {
    const tracker = this.trackers.get(mint);
    if (!tracker) return { washScore: 0, organicScore: 100, flags: [] };

    return {
      washScore: tracker.profile.washTradingScore,
      organicScore: tracker.profile.organicScore,
      flags: tracker.profile.alerts,
    };
  }


  private startTracking(mint: string, symbol?: string): { status: string; tracked: number } {
    if (this.trackers.has(mint)) return { status: 'already_tracking', tracked: this.trackers.size };

    if (this.trackers.size >= this.MAX_TRACKED) {
      this.evictOldest();
    }

    const profile: VolumeProfile = {
      mint,
      symbol: symbol || '???',
      volume1m: 0, volume5m: 0, volume15m: 0,
      txCount1m: 0, txCount5m: 0,
      uniqueWallets5m: 0,
      washTradingScore: 0,
      isVolumeSpike: false,
      spikeMultiple: 0,
      organicScore: 100,
      isCoordinatedPump: false,
      volumeTrend: 'stable',
      alerts: [],
      lastUpdated: Date.now(),
    };

    this.trackers.set(mint, {
      profile,
      trades: [],
      volumeHistory: [],
      baselineVolume5m: 0,
    });

    this.stats.totalTracked++;
    return { status: 'tracking', tracked: this.trackers.size };
  }

  private stopTracking(mint: string): { status: string } {
    this.trackers.delete(mint);
    return { status: 'stopped' };
  }

  private analyzeVolume(mint: string): VolumeProfile | { error: string } {
    const tracker = this.trackers.get(mint);
    if (!tracker) return { error: 'Not tracking this token' };
    this.recalcProfile(tracker);
    return { ...tracker.profile };
  }

  private checkWashTrading(mint: string): {
    washScore: number;
    suspiciousWallets: { wallet: string; buys: number; sells: number; volume: number }[];
    cyclePatterns: number;
  } {
    const tracker = this.trackers.get(mint);
    if (!tracker) return { washScore: 0, suspiciousWallets: [], cyclePatterns: 0 };

    const now = Date.now();
    const recentTrades = tracker.trades.filter(t => t.timestamp > now - 5 * 60_000);


    const walletActivity = new Map<string, { buys: number; sells: number; volume: number }>();
    for (const trade of recentTrades) {
      const activity = walletActivity.get(trade.wallet) || { buys: 0, sells: 0, volume: 0 };
      if (trade.type === 'buy') activity.buys++;
      else activity.sells++;
      activity.volume += trade.solAmount;
      walletActivity.set(trade.wallet, activity);
    }


    const suspicious: { wallet: string; buys: number; sells: number; volume: number }[] = [];
    let cyclePatterns = 0;

    for (const [wallet, activity] of walletActivity) {
      if (activity.buys > 0 && activity.sells > 0) {
        suspicious.push({ wallet, ...activity });
        cyclePatterns += Math.min(activity.buys, activity.sells);
      }
    }


    const totalTrades = recentTrades.length;
    const washTrades = suspicious.reduce((s, w) => s + w.buys + w.sells, 0);
    const washScore = totalTrades > 0 ? Math.min(100, (washTrades / totalTrades) * 100 * 1.5) : 0;

    if (washScore > 50) this.stats.washTradingDetected++;

    return {
      washScore: Math.round(washScore),
      suspiciousWallets: suspicious.sort((a, b) => b.volume - a.volume).slice(0, 10),
      cyclePatterns,
    };
  }

  private getSpikes(minMultiple: number, limit: number): VolumeProfile[] {
    const spiking: VolumeProfile[] = [];
    for (const tracker of this.trackers.values()) {
      if (tracker.profile.isVolumeSpike && tracker.profile.spikeMultiple >= minMultiple) {
        spiking.push({ ...tracker.profile });
      }
    }
    return spiking.sort((a, b) => b.spikeMultiple - a.spikeMultiple).slice(0, limit);
  }

  private getOrganicScore(mint: string): {
    organicScore: number;
    uniqueWallets: number;
    totalTrades: number;
    walletToTradeRatio: number;
    assessment: string;
  } {
    const tracker = this.trackers.get(mint);
    if (!tracker) return { organicScore: 0, uniqueWallets: 0, totalTrades: 0, walletToTradeRatio: 0, assessment: 'unknown' };

    const now = Date.now();
    const cutoff = now - 5 * 60_000;
    const recent = tracker.trades.filter(t => t.timestamp > cutoff);
    const uniqueWallets = new Set(recent.map(t => t.wallet)).size;
    const totalTrades = recent.length;
    const ratio = totalTrades > 0 ? uniqueWallets / totalTrades : 0;


    const organicScore = Math.min(100, Math.round(ratio * 100 * 1.5));

    let assessment = 'unknown';
    if (organicScore > 70) assessment = 'organic';
    else if (organicScore > 40) assessment = 'mixed';
    else if (organicScore > 0) assessment = 'suspicious';

    return { organicScore, uniqueWallets, totalTrades, walletToTradeRatio: ratio, assessment };
  }

  private setAutoTrack(enabled: boolean): { status: string } {
    this.autoTrack = enabled;
    return { status: enabled ? 'auto_track_enabled' : 'auto_track_disabled' };
  }


  private recalcProfile(tracker: VolumeTracker): void {
    const now = Date.now();
    const cutoff1m = now - 60_000;
    const cutoff5m = now - 5 * 60_000;
    const cutoff15m = now - 15 * 60_000;


    tracker.trades = tracker.trades.filter(t => t.timestamp > now - this.TRADE_WINDOW);

    const trades1m = tracker.trades.filter(t => t.timestamp > cutoff1m);
    const trades5m = tracker.trades.filter(t => t.timestamp > cutoff5m);
    const trades15m = tracker.trades.filter(t => t.timestamp > cutoff15m);


    tracker.profile.volume1m = trades1m.reduce((s, t) => s + t.solAmount, 0);
    tracker.profile.volume5m = trades5m.reduce((s, t) => s + t.solAmount, 0);
    tracker.profile.volume15m = trades15m.reduce((s, t) => s + t.solAmount, 0);
    tracker.profile.txCount1m = trades1m.length;
    tracker.profile.txCount5m = trades5m.length;


    tracker.profile.uniqueWallets5m = new Set(trades5m.map(t => t.wallet)).size;


    tracker.volumeHistory.push({ vol: tracker.profile.volume5m, ts: now });
    if (tracker.volumeHistory.length > 100) tracker.volumeHistory = tracker.volumeHistory.slice(-100);


    if (tracker.volumeHistory.length >= 3) {
      const oldEntries = tracker.volumeHistory.slice(0, -1);
      tracker.baselineVolume5m = oldEntries.reduce((s, e) => s + e.vol, 0) / oldEntries.length;
    }


    if (tracker.baselineVolume5m > 0) {
      tracker.profile.spikeMultiple = tracker.profile.volume5m / tracker.baselineVolume5m;
      tracker.profile.isVolumeSpike = tracker.profile.spikeMultiple >= 3;
      if (tracker.profile.isVolumeSpike) {
        this.stats.volumeSpikesDetected++;
      }
    }


    const walletActivity = new Map<string, { buys: number; sells: number }>();
    for (const trade of trades5m) {
      const activity = walletActivity.get(trade.wallet) || { buys: 0, sells: 0 };
      if (trade.type === 'buy') activity.buys++;
      else activity.sells++;
      walletActivity.set(trade.wallet, activity);
    }

    let washTrades = 0;
    for (const activity of walletActivity.values()) {
      if (activity.buys > 0 && activity.sells > 0) {
        washTrades += Math.min(activity.buys, activity.sells) * 2;
      }
    }
    tracker.profile.washTradingScore = trades5m.length > 0
      ? Math.min(100, Math.round((washTrades / trades5m.length) * 100))
      : 0;


    const ratio = trades5m.length > 0 ? tracker.profile.uniqueWallets5m / trades5m.length : 0;
    tracker.profile.organicScore = Math.min(100, Math.round(ratio * 100 * 1.5));


    const buys1m = trades1m.filter(t => t.type === 'buy');
    if (buys1m.length >= 10) {
      const avgBuySize = buys1m.reduce((s, t) => s + t.solAmount, 0) / buys1m.length;

      if (avgBuySize < 0.5 && buys1m.length >= 15) {
        tracker.profile.isCoordinatedPump = true;
        this.stats.coordinatedPumpsDetected++;
      } else {
        tracker.profile.isCoordinatedPump = false;
      }
    } else {
      tracker.profile.isCoordinatedPump = false;
    }


    if (tracker.volumeHistory.length >= 3) {
      const last3 = tracker.volumeHistory.slice(-3).map(e => e.vol);
      if (tracker.profile.isVolumeSpike) tracker.profile.volumeTrend = 'spike';
      else if (last3[2] > last3[1] && last3[1] > last3[0]) tracker.profile.volumeTrend = 'increasing';
      else if (last3[2] < last3[1] && last3[1] < last3[0]) tracker.profile.volumeTrend = 'decreasing';
      else tracker.profile.volumeTrend = 'stable';
    }


    const alerts: string[] = [];
    if (tracker.profile.washTradingScore > 50) alerts.push(`wash_trading_${tracker.profile.washTradingScore}`);
    if (tracker.profile.isVolumeSpike) alerts.push(`volume_spike_${tracker.profile.spikeMultiple.toFixed(1)}x`);
    if (tracker.profile.isCoordinatedPump) alerts.push('coordinated_pump');
    if (tracker.profile.organicScore < 30) alerts.push(`low_organic_${tracker.profile.organicScore}`);
    if (tracker.profile.volumeTrend === 'decreasing') alerts.push('volume_declining');
    tracker.profile.alerts = alerts;
    tracker.profile.lastUpdated = now;


    const allOrganic: number[] = [];
    for (const t of this.trackers.values()) {
      allOrganic.push(t.profile.organicScore);
    }
    if (allOrganic.length > 0) {
      this.stats.avgOrganicScore = Math.round(allOrganic.reduce((a, b) => a + b, 0) / allOrganic.length);
    }
  }

  private evictOldest(): void {
    let oldestMint: string | null = null;
    let oldestTime = Infinity;
    for (const [mint, tracker] of this.trackers) {
      if (tracker.profile.lastUpdated < oldestTime) {
        oldestTime = tracker.profile.lastUpdated;
        oldestMint = mint;
      }
    }
    if (oldestMint) this.trackers.delete(oldestMint);
  }
}
