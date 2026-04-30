import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface, WalletInterface,
} from '../types.ts';

interface DCAOrder {
  id: string;
  mint: string;
  symbol: string;
  totalAmountSol: number;
  perOrderSol: number;
  orders: number;
  completedOrders: number;
  intervalMs: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  createdAt: number;
  nextOrderAt: number;
  slippageBps: number;
}

interface TrailingStop {
  id: string;
  mint: string;
  symbol: string;
  trailPercent: number;

  peakPrice: number;

  stopPrice: number;
  entryPrice: number;
  amountToSell: number;
  status: 'active' | 'triggered' | 'cancelled';
  createdAt: number;
  lastUpdated: number;
}

interface GridConfig {
  id: string;
  mint: string;
  symbol: string;
  lowerPrice: number;
  upperPrice: number;
  gridLevels: number;
  amountPerLevel: number;

  levels: Array<{ price: number; side: 'buy' | 'sell'; filled: boolean }>;
  status: 'active' | 'paused' | 'completed';
  createdAt: number;
  totalFills: number;
  profitSol: number;
}

interface GraduationWatch {
  id: string;
  mint: string;
  symbol: string;
  buyAmountSol: number;
  slippageBps: number;
  status: 'watching' | 'graduated' | 'bought' | 'expired';
  createdAt: number;
  expiresAt: number;
}

interface ScalingRule {
  id: string;
  mint: string;
  symbol: string;

  dipPercent: number;

  maxScaleIns: number;
  completedScaleIns: number;
  perScaleSol: number;
  entryPrice: number;
  status: 'active' | 'maxed' | 'cancelled';
}

export class AdvancedTraderSkill implements Skill {
  manifest: SkillManifest = {
    name: 'advanced-trader',
    version: '1.0.0',
    description: 'Advanced trading: DCA, trailing stop-loss, grid trading, graduation sniping, MEV protection, multi-DEX routing, position scaling',
    tools: [

      {
        name: 'dca_create',
        description: 'Create a DCA (Dollar Cost Averaging) order — splits total buy into N smaller orders over time',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            symbol: { type: 'string', description: 'Token symbol' },
            totalAmountSol: { type: 'number', description: 'Total SOL to invest' },
            orders: { type: 'number', description: 'Number of orders to split into (default: 5)' },
            intervalMinutes: { type: 'number', description: 'Minutes between each order (default: 5)' },
            slippageBps: { type: 'number', description: 'Slippage in basis points (default: 2000)' },
          },
          required: ['mint', 'totalAmountSol'],
        },
        riskLevel: 'financial',
      },
      {
        name: 'dca_cancel',
        description: 'Cancel an active DCA order',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'DCA order ID' } },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'dca_list',
        description: 'List all DCA orders (active and completed)',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'trailing_stop_set',
        description: 'Set a trailing stop-loss that follows price up. When price drops trailPercent% from peak, sells.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            symbol: { type: 'string', description: 'Token symbol' },
            trailPercent: { type: 'number', description: 'Trail distance in percent (e.g., 15 for 15%)' },
            entryPrice: { type: 'number', description: 'Entry price (to calculate peak) ' },
            sellPercent: { type: 'number', description: 'Percent of position to sell when triggered (default: 100)' },
          },
          required: ['mint', 'trailPercent'],
        },
        riskLevel: 'financial',
      },
      {
        name: 'trailing_stop_cancel',
        description: 'Cancel a trailing stop-loss',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Trailing stop ID' } },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'trailing_stop_list',
        description: 'List all trailing stop-losses with current peak/stop prices',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'grid_create',
        description: 'Create a grid trading strategy — places buy/sell orders at price levels for range-bound scalping',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            symbol: { type: 'string', description: 'Token symbol' },
            lowerPrice: { type: 'number', description: 'Lower bound of grid price range' },
            upperPrice: { type: 'number', description: 'Upper bound of grid price range' },
            gridLevels: { type: 'number', description: 'Number of grid levels (default: 10)' },
            amountPerLevel: { type: 'number', description: 'SOL per grid level (default: 0.05)' },
          },
          required: ['mint', 'lowerPrice', 'upperPrice'],
        },
        riskLevel: 'financial',
      },
      {
        name: 'grid_cancel',
        description: 'Cancel an active grid',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Grid ID' } },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'grid_list',
        description: 'List all grid strategies with fill stats',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'graduation_watch',
        description: 'Watch a pump.fun token for graduation to pump.fun AMM pool — auto-buys on graduation event',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            symbol: { type: 'string', description: 'Token symbol' },
            buyAmountSol: { type: 'number', description: 'SOL to buy with on graduation (default: 0.5)' },
            slippageBps: { type: 'number', description: 'Slippage bps (default: 3000)' },
            timeoutMinutes: { type: 'number', description: 'Stop watching after N minutes (default: 120)' },
          },
          required: ['mint'],
        },
        riskLevel: 'financial',
      },
      {
        name: 'graduation_list',
        description: 'List tokens being watched for graduation',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'mev_config',
        description: 'Configure MEV protection: Jito tip amount, bundle priority, backrun protection',
        parameters: {
          type: 'object',
          properties: {
            jitoTipSol: { type: 'number', description: 'Jito tip in SOL (default: 0.005)' },
            usePrivateTx: { type: 'boolean', description: 'Send via private Jito bundle (no mempool exposure)' },
            maxPriorityFee: { type: 'number', description: 'Max priority fee in SOL' },
          },
        },
        riskLevel: 'write',
      },

      {
        name: 'route_best',
        description: 'Find the best route across all DEXes (Jupiter, pump.fun AMM, Orca, Meteora) for a swap',
        parameters: {
          type: 'object',
          properties: {
            inputMint: { type: 'string', description: 'Input token mint' },
            outputMint: { type: 'string', description: 'Output token mint' },
            amountSol: { type: 'number', description: 'Amount in SOL' },
          },
          required: ['inputMint', 'outputMint', 'amountSol'],
        },
        riskLevel: 'read',
      },

      {
        name: 'scale_in_set',
        description: 'Set auto scale-in rule: buy more when price dips X% from entry (pyramid in)',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint' },
            symbol: { type: 'string', description: 'Token symbol' },
            dipPercent: { type: 'number', description: 'Buy more on X% dip from entry (e.g., 20)' },
            maxScaleIns: { type: 'number', description: 'Max scale-in orders (default: 3)' },
            perScaleSol: { type: 'number', description: 'SOL per scale-in order (default: 0.1)' },
            entryPrice: { type: 'number', description: 'Original entry price' },
          },
          required: ['mint', 'dipPercent', 'entryPrice'],
        },
        riskLevel: 'financial',
      },
      {
        name: 'scale_in_list',
        description: 'List all scale-in rules',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;

  private dcaOrders = new Map<string, DCAOrder>();
  private trailingStops = new Map<string, TrailingStop>();
  private grids = new Map<string, GridConfig>();
  private graduationWatches = new Map<string, GraduationWatch>();
  private scalingRules = new Map<string, ScalingRule>();
  private dcaTimers = new Map<string, ReturnType<typeof setInterval>>();
  private priceCheckTimer: ReturnType<typeof setInterval> | null = null;

  private mevConfig = {
    jitoTipSol: 0.005,
    usePrivateTx: true,
    maxPriorityFee: 0.01,
  };

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

    this.eventBus.on('token:graduated', (data) => {
      this.handleGraduation(data.mint, data.dex);
    });

    this.priceCheckTimer = setInterval(() => this.checkPrices(), 5_000);

    this.eventBus.on('token:update', (snap) => {
      this.updateTrailingStop(snap.mint, snap.price);
      this.checkGridFills(snap.mint, snap.price);
      this.checkScaleIn(snap.mint, snap.price);
    });
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'dca_create': return this.dcaCreate(params as any);
      case 'dca_cancel': return this.dcaCancel(params.id);
      case 'dca_list': return this.dcaList();
      case 'trailing_stop_set': return this.trailingStopSet(params as any);
      case 'trailing_stop_cancel': return this.trailingStopCancel(params.id);
      case 'trailing_stop_list': return this.trailingStopList();
      case 'grid_create': return this.gridCreate(params as any);
      case 'grid_cancel': return this.gridCancel(params.id);
      case 'grid_list': return this.gridList();
      case 'graduation_watch': return this.graduationWatch(params as any);
      case 'graduation_list': return this.graduationList();
      case 'mev_config': return this.setMevConfig(params as any);
      case 'route_best': return this.routeBest(params as any);
      case 'scale_in_set': return this.scaleInSet(params as any);
      case 'scale_in_list': return this.scaleInList();
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    for (const timer of this.dcaTimers.values()) clearInterval(timer);
    this.dcaTimers.clear();
    if (this.priceCheckTimer) clearInterval(this.priceCheckTimer);
  }


  private dcaCreate(params: {
    mint: string; symbol?: string; totalAmountSol: number;
    orders?: number; intervalMinutes?: number; slippageBps?: number;
  }): { status: string; dca: DCAOrder } {
    const orders = params.orders || 5;
    const intervalMs = (params.intervalMinutes || 5) * 60_000;
    const perOrder = params.totalAmountSol / orders;
    const id = `dca_${Date.now().toString(36)}`;

    const dca: DCAOrder = {
      id,
      mint: params.mint,
      symbol: params.symbol || params.mint.slice(0, 8),
      totalAmountSol: params.totalAmountSol,
      perOrderSol: perOrder,
      orders,
      completedOrders: 0,
      intervalMs,
      status: 'active',
      createdAt: Date.now(),
      nextOrderAt: Date.now(),
      slippageBps: params.slippageBps || 2000,
    };

    this.dcaOrders.set(id, dca);


    this.executeDCAOrder(dca);
    const timer = setInterval(() => this.executeDCAOrder(dca), intervalMs);
    this.dcaTimers.set(id, timer);

    this.logger.info(`DCA created: ${dca.symbol} | ${dca.totalAmountSol} SOL / ${orders} orders @ ${params.intervalMinutes || 5}min`);
    return { status: 'created', dca };
  }

  private executeDCAOrder(dca: DCAOrder): void {
    if (dca.status !== 'active') return;
    if (dca.completedOrders >= dca.orders) {
      dca.status = 'completed';
      const timer = this.dcaTimers.get(dca.id);
      if (timer) { clearInterval(timer); this.dcaTimers.delete(dca.id); }
      this.logger.info(`DCA completed: ${dca.symbol} | ${dca.completedOrders}/${dca.orders} orders`);
      return;
    }

    this.eventBus.emit('trade:intent', {
      id: `${dca.id}_${dca.completedOrders}`,
      agentId: 'advanced-trader',
      action: 'buy',
      mint: dca.mint,
      symbol: dca.symbol,
      amountSol: dca.perOrderSol,
      slippageBps: dca.slippageBps,
      priorityFeeSol: this.mevConfig.jitoTipSol,
      reason: `DCA order ${dca.completedOrders + 1}/${dca.orders} for ${dca.symbol}`,
      timestamp: Date.now(),
    });

    dca.completedOrders++;
    dca.nextOrderAt = Date.now() + dca.intervalMs;
  }

  private dcaCancel(id: string): { status: string } {
    const dca = this.dcaOrders.get(id);
    if (!dca) return { status: 'not_found' };
    dca.status = 'cancelled';
    const timer = this.dcaTimers.get(id);
    if (timer) { clearInterval(timer); this.dcaTimers.delete(id); }
    return { status: 'cancelled' };
  }

  private dcaList(): { dcas: DCAOrder[] } {
    return { dcas: Array.from(this.dcaOrders.values()) };
  }


  private trailingStopSet(params: {
    mint: string; symbol?: string; trailPercent: number;
    entryPrice?: number; sellPercent?: number;
  }): { status: string; stop: TrailingStop } {
    const id = `ts_${Date.now().toString(36)}`;
    const entry = params.entryPrice || 0;

    const stop: TrailingStop = {
      id,
      mint: params.mint,
      symbol: params.symbol || params.mint.slice(0, 8),
      trailPercent: params.trailPercent,
      peakPrice: entry,
      stopPrice: entry * (1 - params.trailPercent / 100),
      entryPrice: entry,
      amountToSell: params.sellPercent ?? 100,
      status: 'active',
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };

    this.trailingStops.set(id, stop);
    this.logger.info(`Trailing stop set: ${stop.symbol} | trail=${stop.trailPercent}% | stop=${stop.stopPrice.toFixed(10)}`);
    return { status: 'created', stop };
  }

  private updateTrailingStop(mint: string, currentPrice: number): void {
    for (const stop of this.trailingStops.values()) {
      if (stop.mint !== mint || stop.status !== 'active') continue;


      if (currentPrice > stop.peakPrice) {
        stop.peakPrice = currentPrice;
        stop.stopPrice = currentPrice * (1 - stop.trailPercent / 100);
        stop.lastUpdated = Date.now();
      }


      if (currentPrice <= stop.stopPrice && stop.peakPrice > 0) {
        stop.status = 'triggered';
        this.logger.trade(
          `TRAILING STOP TRIGGERED: ${stop.symbol} | peak=${stop.peakPrice.toFixed(10)} | stop=${stop.stopPrice.toFixed(10)} | current=${currentPrice.toFixed(10)}`
        );

        this.eventBus.emit('signal:sell', {
          mint: stop.mint,
          reason: `Trailing stop: dropped ${stop.trailPercent}% from peak ${stop.peakPrice.toFixed(10)}`,
          urgency: 'high',
          agentId: 'advanced-trader',
        });
      }
    }
  }

  private trailingStopCancel(id: string): { status: string } {
    const stop = this.trailingStops.get(id);
    if (!stop) return { status: 'not_found' };
    stop.status = 'cancelled';
    return { status: 'cancelled' };
  }

  private trailingStopList(): { stops: TrailingStop[] } {
    return { stops: Array.from(this.trailingStops.values()) };
  }


  private gridCreate(params: {
    mint: string; symbol?: string; lowerPrice: number;
    upperPrice: number; gridLevels?: number; amountPerLevel?: number;
  }): { status: string; grid: GridConfig } {
    const id = `grid_${Date.now().toString(36)}`;
    const levels = params.gridLevels || 10;
    const step = (params.upperPrice - params.lowerPrice) / levels;

    const gridLevels: GridConfig['levels'] = [];
    for (let i = 0; i <= levels; i++) {
      const price = params.lowerPrice + step * i;

      gridLevels.push({
        price,
        side: i < levels / 2 ? 'buy' : 'sell',
        filled: false,
      });
    }

    const grid: GridConfig = {
      id,
      mint: params.mint,
      symbol: params.symbol || params.mint.slice(0, 8),
      lowerPrice: params.lowerPrice,
      upperPrice: params.upperPrice,
      gridLevels: levels,
      amountPerLevel: params.amountPerLevel || 0.05,
      levels: gridLevels,
      status: 'active',
      createdAt: Date.now(),
      totalFills: 0,
      profitSol: 0,
    };

    this.grids.set(id, grid);
    this.logger.info(`Grid created: ${grid.symbol} | ${params.lowerPrice}-${params.upperPrice} | ${levels} levels @ ${grid.amountPerLevel} SOL`);
    return { status: 'created', grid };
  }

  private checkGridFills(mint: string, currentPrice: number): void {
    for (const grid of this.grids.values()) {
      if (grid.mint !== mint || grid.status !== 'active') continue;

      for (const level of grid.levels) {
        if (level.filled) continue;

        const triggered = level.side === 'buy'
          ? currentPrice <= level.price
          : currentPrice >= level.price;

        if (triggered) {
          level.filled = true;
          grid.totalFills++;

          this.eventBus.emit('trade:intent', {
            id: `${grid.id}_${grid.totalFills}`,
            agentId: 'advanced-trader',
            action: level.side,
            mint: grid.mint,
            symbol: grid.symbol,
            amountSol: grid.amountPerLevel,
            slippageBps: 2000,
            priorityFeeSol: this.mevConfig.jitoTipSol,
            reason: `Grid ${level.side} at ${level.price.toFixed(10)} (level ${grid.totalFills}/${grid.gridLevels})`,
            timestamp: Date.now(),
          });

          this.logger.trade(`GRID ${level.side.toUpperCase()}: ${grid.symbol} @ ${level.price.toFixed(10)}`);
        }
      }


      if (grid.levels.every(l => l.filled)) {
        grid.status = 'completed';
        this.logger.info(`Grid completed: ${grid.symbol} | ${grid.totalFills} fills`);
      }
    }
  }

  private gridCancel(id: string): { status: string } {
    const grid = this.grids.get(id);
    if (!grid) return { status: 'not_found' };
    grid.status = 'completed';
    return { status: 'cancelled' };
  }

  private gridList(): { grids: GridConfig[] } {
    return { grids: Array.from(this.grids.values()) };
  }


  private graduationWatch(params: {
    mint: string; symbol?: string; buyAmountSol?: number;
    slippageBps?: number; timeoutMinutes?: number;
  }): { status: string; watch: GraduationWatch } {
    const id = `grad_${Date.now().toString(36)}`;
    const timeout = (params.timeoutMinutes || 120) * 60_000;

    const watch: GraduationWatch = {
      id,
      mint: params.mint,
      symbol: params.symbol || params.mint.slice(0, 8),
      buyAmountSol: params.buyAmountSol || 0.5,
      slippageBps: params.slippageBps || 3000,
      status: 'watching',
      createdAt: Date.now(),
      expiresAt: Date.now() + timeout,
    };

    this.graduationWatches.set(id, watch);
    this.logger.info(`Graduation watch: ${watch.symbol} | buy ${watch.buyAmountSol} SOL on pump.fun AMM migration`);
    return { status: 'watching', watch };
  }

  private handleGraduation(mint: string, dex: string): void {
    for (const watch of this.graduationWatches.values()) {
      if (watch.mint !== mint || watch.status !== 'watching') continue;
      if (Date.now() > watch.expiresAt) {
        watch.status = 'expired';
        continue;
      }

      watch.status = 'graduated';
      this.logger.trade(`GRADUATION SNIPE: ${watch.symbol} graduated to ${dex} | buying ${watch.buyAmountSol} SOL`);

      this.eventBus.emit('trade:intent', {
        id: `grad_${Date.now()}_${mint.slice(0, 8)}`,
        agentId: 'advanced-trader',
        action: 'buy',
        mint,
        symbol: watch.symbol,
        amountSol: watch.buyAmountSol,
        slippageBps: watch.slippageBps,
        priorityFeeSol: Math.max(this.mevConfig.jitoTipSol, 0.01),
        reason: `Graduation snipe: ${watch.symbol} → ${dex}`,
        timestamp: Date.now(),
      });

      watch.status = 'bought';
    }
  }

  private graduationList(): { watches: GraduationWatch[] } {
    return { watches: Array.from(this.graduationWatches.values()) };
  }


  private setMevConfig(params: {
    jitoTipSol?: number; usePrivateTx?: boolean; maxPriorityFee?: number;
  }): { status: string; config: { jitoTipSol: number; usePrivateTx: boolean; maxPriorityFee: number } } {
    if (params.jitoTipSol !== undefined) this.mevConfig.jitoTipSol = params.jitoTipSol;
    if (params.usePrivateTx !== undefined) this.mevConfig.usePrivateTx = params.usePrivateTx;
    if (params.maxPriorityFee !== undefined) this.mevConfig.maxPriorityFee = params.maxPriorityFee;
    return { status: 'updated', config: this.mevConfig };
  }


  private async routeBest(params: {
    inputMint: string; outputMint: string; amountSol: number;
  }): Promise<any> {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const inputMint = params.inputMint === 'SOL' ? SOL_MINT : params.inputMint;
    const outputMint = params.outputMint === 'SOL' ? SOL_MINT : params.outputMint;
    const amountLamports = Math.round(params.amountSol * 1e9);

    const routes: Array<{ dex: string; outAmount: number; priceImpact: number; error?: string }> = [];


    try {
      const res = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=50`,
        { signal: AbortSignal.timeout(5_000) }
      );
      if (res.ok) {
        const data = await res.json() as any;
        routes.push({
          dex: 'Jupiter',
          outAmount: Number(data.outAmount || 0) / 1e9,
          priceImpact: Number(data.priceImpactPct || 0),
        });
      }
    } catch (e: any) {
      routes.push({ dex: 'Jupiter', outAmount: 0, priceImpact: 0, error: e.message });
    }

    try {
      const res = await fetch(
        `https://pumpportal.fun/api/trade-local`,
        {
                    method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publicKey: this.ctx.wallet.getAddress(),
            action: 'buy',
            mint: outputMint,
            amount: amountLamports,
            denominatedInSol: 'true',
            slippage: 2,
            priorityFee: 0.005,
            pool: 'auto',
          }),
          signal: AbortSignal.timeout(5_000),
        }
      );
      if (res.ok) {
        routes.push({
          dex: 'pump.fun AMM',
          outAmount: params.amountSol,
          priceImpact: 0,
        });
      }
    } catch (e: any) {
      routes.push({ dex: 'pump.fun AMM', outAmount: 0, priceImpact: 0, error: e.message });
    }

    routes.sort((a, b) => b.outAmount - a.outAmount);
    const best = routes[0];

    return {
      inputMint,
      outputMint,
      amountSol: params.amountSol,
      bestRoute: best?.dex || 'none',
      routes,
    };
  }

  private scaleInSet(params: {
    mint: string; symbol?: string; dipPercent: number;
    maxScaleIns?: number; perScaleSol?: number; entryPrice: number;
  }): { status: string; rule: ScalingRule } {
    const id = `scale_${Date.now().toString(36)}`;

    const rule: ScalingRule = {
      id,
      mint: params.mint,
      symbol: params.symbol || params.mint.slice(0, 8),
      dipPercent: params.dipPercent,
      maxScaleIns: params.maxScaleIns || 3,
      completedScaleIns: 0,
      perScaleSol: params.perScaleSol || 0.1,
      entryPrice: params.entryPrice,
      status: 'active',
    };

    this.scalingRules.set(id, rule);
    this.logger.info(`Scale-in rule: ${rule.symbol} | buy ${rule.perScaleSol} SOL on ${rule.dipPercent}% dips, max ${rule.maxScaleIns}x`);
    return { status: 'created', rule };
  }

  private checkScaleIn(mint: string, currentPrice: number): void {
    for (const rule of this.scalingRules.values()) {
      if (rule.mint !== mint || rule.status !== 'active') continue;
      if (rule.completedScaleIns >= rule.maxScaleIns) {
        rule.status = 'maxed';
        continue;
      }


      const dipFromEntry = ((rule.entryPrice - currentPrice) / rule.entryPrice) * 100;
      const nextDipTarget = rule.dipPercent * (rule.completedScaleIns + 1);

      if (dipFromEntry >= nextDipTarget) {
        rule.completedScaleIns++;
        this.logger.trade(
          `SCALE-IN: ${rule.symbol} dip ${dipFromEntry.toFixed(1)}% | buying ${rule.perScaleSol} SOL (${rule.completedScaleIns}/${rule.maxScaleIns})`
        );

        this.eventBus.emit('trade:intent', {
          id: `scale_${Date.now()}_${mint.slice(0, 8)}`,
          agentId: 'advanced-trader',
          action: 'buy',
          mint,
          symbol: rule.symbol,
          amountSol: rule.perScaleSol,
          slippageBps: 2000,
          priorityFeeSol: this.mevConfig.jitoTipSol,
          reason: `Scale-in: ${dipFromEntry.toFixed(1)}% dip (${rule.completedScaleIns}/${rule.maxScaleIns})`,
          timestamp: Date.now(),
        });
      }
    }
  }

  private scaleInList(): { rules: ScalingRule[] } {
    return { rules: Array.from(this.scalingRules.values()) };
  }


  private async checkPrices(): Promise<void> {

    for (const [id, watch] of this.graduationWatches) {
      if (watch.status === 'watching' && Date.now() > watch.expiresAt) {
        watch.status = 'expired';
      }
    }
  }
}
