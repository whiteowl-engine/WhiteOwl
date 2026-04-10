import {
  Skill, SkillManifest, SkillContext, Position,
  LoggerInterface, EventBusInterface, MemoryInterface,
} from '../types.ts';

export class PortfolioSkill implements Skill {
  manifest: SkillManifest = {
    name: 'portfolio',
    version: '1.0.0',
    description: 'Portfolio management: track open positions, calculate P&L, generate reports, manage exits',
    tools: [
      {
        name: 'get_positions',
        description: 'Get all open positions with current P&L',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_portfolio_summary',
        description: 'Get full portfolio summary: total value, P&L breakdown, win rate, best/worst positions',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_position_detail',
        description: 'Get detailed info about a specific open position including price history',
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
        name: 'get_trade_history',
        description: 'Get executed trade history with P&L per trade',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of trades (default: 50)' },
            mint: { type: 'string', description: 'Filter by token mint' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'get_daily_report',
        description: 'Generate a daily performance report: trades, P&L, win rate, volume',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'get_session_report',
        description: 'Generate a report for the current or specified trading session',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Session ID (default: current)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'check_positions_health',
        description: 'Check all positions for stop-loss, take-profit, or timeout conditions',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_best_performers',
        description: 'Get best performing tokens from trade history',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Lookback period' },
            limit: { type: 'number', description: 'Max results' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'get_wallet_activity_gmgn',
        description: 'Parse full trade history (buy/sell activity) for ANY Solana wallet using GMGN.ai API. Returns all transactions with token info, amounts, USD values, PnL per trade, gas fees, and timestamps. Supports pagination (50 trades per page). Use this to analyze any wallet\'s trading patterns.',
        parameters: {
          type: 'object',
          properties: {
            wallet: { type: 'string', description: 'Solana wallet address to parse trades for' },
            maxPages: { type: 'number', description: 'Number of pages to fetch (50 trades each, default: 1, max: 20). Set higher to get full history.' },
            cursor: { type: 'string', description: 'Pagination cursor from previous response (data.next). Leave empty for first page.' },
          },
          required: ['wallet'],
        },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private memory!: MemoryInterface;
  private positions = new Map<string, Position>();

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.memory = ctx.memory;

    this.eventBus.on('trade:executed', (result) => {
      if (result.success) {
        this.syncPositions();
      }
    });

    this.eventBus.on('position:opened', (pos) => {
      this.positions.set(pos.mint, pos);
    });

    this.eventBus.on('position:updated', (pos) => {
      this.positions.set(pos.mint, pos);
    });

    this.eventBus.on('position:closed', ({ mint }) => {
      this.positions.delete(mint);
    });

    this.syncPositions();
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'get_positions': return this.getPositions();
      case 'get_portfolio_summary': return this.getPortfolioSummary();
      case 'get_position_detail': return this.getPositionDetail(params.mint);
      case 'get_trade_history': return this.getTradeHistory(params.limit, params.mint);
      case 'get_daily_report': return this.getDailyReport(params.date);
      case 'get_session_report': return this.getSessionReport(params.sessionId);
      case 'check_positions_health': return this.checkPositionsHealth();
      case 'get_best_performers': return this.getBestPerformers(params.period, params.limit);
      case 'get_wallet_activity_gmgn': return this.getWalletActivityGmgn(params.wallet, params.maxPages, params.cursor);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}

  private getPositions(): Position[] {
    return Array.from(this.positions.values()).map(p => ({
      ...p,
      unrealizedPnl: (p.currentPrice - p.entryPrice) * p.amountTokens,
      unrealizedPnlPercent: p.entryPrice > 0
        ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100
        : 0,
    }));
  }

  private getPortfolioSummary(): any {
    const positions = this.getPositions();
    const totalInvested = positions.reduce((s, p) => s + p.amountSolInvested, 0);
    const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const stats = this.memory.getStats('24h');

    const profitable = positions.filter(p => p.unrealizedPnl > 0);
    const losing = positions.filter(p => p.unrealizedPnl < 0);

    const best = positions.length > 0
      ? positions.reduce((a, b) => a.unrealizedPnlPercent > b.unrealizedPnlPercent ? a : b)
      : null;
    const worst = positions.length > 0
      ? positions.reduce((a, b) => a.unrealizedPnlPercent < b.unrealizedPnlPercent ? a : b)
      : null;

    return {
      openPositions: positions.length,
      totalInvested,
      totalUnrealizedPnl,
      totalUnrealizedPnlPercent: totalInvested > 0 ? (totalUnrealizedPnl / totalInvested) * 100 : 0,
      profitableCount: profitable.length,
      losingCount: losing.length,
      bestPosition: best ? {
        mint: best.mint,
        symbol: best.symbol,
        pnlPercent: best.unrealizedPnlPercent,
      } : null,
      worstPosition: worst ? {
        mint: worst.mint,
        symbol: worst.symbol,
        pnlPercent: worst.unrealizedPnlPercent,
      } : null,
      realized24h: stats,
      positions,
    };
  }

  private getPositionDetail(mint: string): any {
    const pos = this.positions.get(mint);
    if (!pos) return { error: 'Position not found' };

    const snapshots = this.memory.getSnapshots(mint, pos.openedAt);
    const analysis = this.memory.getAnalysis(mint);
    const token = this.memory.getToken(mint);
    const holders = this.memory.getHolderData(mint);
    const holdTimeMinutes = (Date.now() - pos.openedAt) / 60_000;

    return {
      position: {
        ...pos,
        unrealizedPnl: (pos.currentPrice - pos.entryPrice) * pos.amountTokens,
        unrealizedPnlPercent: pos.entryPrice > 0
          ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : 0,
        holdTimeMinutes: Math.round(holdTimeMinutes),
      },
      token,
      analysis,
      holders,
      priceHistory: snapshots.map(s => ({ price: s.price, mcap: s.mcap, time: s.timestamp })),
    };
  }

  private getTradeHistory(limit?: number, mint?: string): any[] {
    return this.memory.getTradeHistory({ limit: limit || 50, mint });
  }

  private getDailyReport(dateStr?: string): any {
    const date = dateStr ? new Date(dateStr) : new Date();
    date.setHours(0, 0, 0, 0);
    const dayStart = date.getTime();
    const dayEnd = dayStart + 86_400_000;

    const trades = this.memory.getTradeHistory({ since: dayStart });
    const todayTrades = trades.filter((t: any) => t.created_at < dayEnd);

    const buys = todayTrades.filter((t: any) => t.action === 'buy' && t.success);
    const sells = todayTrades.filter((t: any) => t.action === 'sell' && t.success);

    const totalBought = buys.reduce((s: number, t: any) => s + (t.amount_sol || 0), 0);
    const totalSold = sells.reduce((s: number, t: any) => s + (t.amount_sol || 0), 0);
    const uniqueTokens = new Set(todayTrades.map((t: any) => t.mint));

    return {
      date: date.toISOString().split('T')[0],
      totalTrades: todayTrades.length,
      buys: buys.length,
      sells: sells.length,
      totalBoughtSol: totalBought,
      totalSoldSol: totalSold,
      netPnlSol: totalSold - totalBought,
      uniqueTokensTraded: uniqueTokens.size,
      openPositions: this.positions.size,
    };
  }

  private getSessionReport(sessionId?: string): any {
    const stats = this.memory.getStats('all');
    const positions = this.getPositions();

    return {
      sessionId: sessionId || 'current',
      stats,
      openPositions: positions.length,
      totalExposure: positions.reduce((s, p) => s + p.amountSolInvested, 0),
      unrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    };
  }

  private checkPositionsHealth(): Array<{
    mint: string;
    symbol: string;
    status: 'healthy' | 'warning' | 'critical';
    alerts: string[];
  }> {
    const results: any[] = [];

    for (const pos of this.positions.values()) {
      const alerts: string[] = [];
      let status: 'healthy' | 'warning' | 'critical' = 'healthy';

      const pnlPct = pos.entryPrice > 0
        ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : 0;
      const holdMin = (Date.now() - pos.openedAt) / 60_000;

      if (pnlPct <= -50) {
        status = 'critical';
        alerts.push(`Down ${pnlPct.toFixed(1)}% — consider cutting losses`);
      } else if (pnlPct <= -30) {
        status = 'warning';
        alerts.push(`Down ${pnlPct.toFixed(1)}%`);
      }

      if (holdMin > 120 && pnlPct < 10) {
        alerts.push(`Held ${Math.round(holdMin)}min with only ${pnlPct.toFixed(1)}% gain`);
        if (status === 'healthy') status = 'warning';
      }

      if (pnlPct >= 100) {
        alerts.push(`Up ${pnlPct.toFixed(0)}% — consider taking partial profit`);
      }

      results.push({ mint: pos.mint, symbol: pos.symbol, status, alerts });
    }

    return results;
  }

  private getBestPerformers(period?: string, limit?: number): any[] {
    const periodMs: Record<string, number> = {
      '24h': 86_400_000,
      '7d': 7 * 86_400_000,
      '30d': 30 * 86_400_000,
      'all': Date.now(),
    };
    const since = Date.now() - (periodMs[period || 'all'] || Date.now());
    const trades = this.memory.getTradeHistory({ since });

    const byToken = new Map<string, { bought: number; sold: number; symbol: string }>();
    for (const t of trades as any[]) {
      if (!t.success) continue;
      const entry = byToken.get(t.mint) || { bought: 0, sold: 0, symbol: t.symbol || '???' };
      if (t.action === 'buy') entry.bought += t.amount_sol || 0;
      if (t.action === 'sell') entry.sold += t.amount_sol || 0;
      byToken.set(t.mint, entry);
    }

    return Array.from(byToken.entries())
      .map(([mint, data]) => ({
        mint,
        symbol: data.symbol,
        bought: data.bought,
        sold: data.sold,
        pnl: data.sold - data.bought,
        roi: data.bought > 0 ? ((data.sold - data.bought) / data.bought) * 100 : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, limit || 10);
  }

  private syncPositions(): void {

    const trades = this.memory.getTradeHistory({ limit: 200 });
    const posMap = new Map<string, { bought: number; sold: number; amountSol: number; lastTrade: any }>();

    for (const t of trades as any[]) {
      if (!t.success || !t.mint) continue;
      const entry = posMap.get(t.mint) || { bought: 0, sold: 0, amountSol: 0, lastTrade: t };
      if (t.action === 'buy') {
        entry.bought += t.amount_tokens || 0;
        entry.amountSol += t.amount_sol || 0;
      }
      if (t.action === 'sell') {
        entry.sold += t.amount_tokens || 0;
      }
      entry.lastTrade = t;
      posMap.set(t.mint, entry);
    }

    for (const [mint, data] of posMap) {
      const remaining = data.bought - data.sold;
      if (remaining > 0 && !this.positions.has(mint)) {
        const token = this.memory.getToken(mint);
        this.positions.set(mint, {
          mint,
          symbol: token?.symbol || '???',
          entryPrice: data.amountSol > 0 && data.bought > 0 ? data.amountSol / data.bought : 0,
          currentPrice: 0,
          amountTokens: remaining,
          amountSolInvested: data.amountSol,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          openedAt: data.lastTrade.created_at || Date.now(),
          lastUpdated: Date.now(),
        });
      }
    }
  }

  private async getWalletActivityGmgn(wallet: string, maxPages?: number, cursor?: string): Promise<any> {
    if (!wallet || wallet.length < 32) {
      return { error: 'Valid Solana wallet address required' };
    }
    try {
      const port = process.env.API_PORT || '3377';
      const pages = Math.min(maxPages || 1, 20);
      const params = new URLSearchParams({
        wallet,
        pages: String(pages),
        limit: '50',
      });
      if (cursor) params.set('cursor', cursor);
      const resp = await fetch(`http://localhost:${port}/api/wallet/activity?${params.toString()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as any;
      const activities = data.activities || [];


      const trades = activities.map((a: any) => ({
        type: a.event_type,
        token: a.token?.symbol || 'Unknown',
        tokenAddress: a.token?.address || '',
        tokenAmount: a.token_amount,
        solAmount: a.quote_amount,
        costUSD: a.cost_usd,
        buyCostUSD: a.buy_cost_usd,
        priceUSD: a.price_usd,
        pnlUSD: a.event_type === 'sell' && a.buy_cost_usd
          ? (Number(a.cost_usd || 0) - Number(a.buy_cost_usd || 0)).toFixed(2)
          : null,
        timestamp: a.timestamp,
        date: new Date(a.timestamp * 1000).toISOString(),
        txHash: a.tx_hash,
        gasFeeSOL: a.gas_native,
        dexFeeSOL: a.dex_native,
        platform: a.launchpad_platform || a.launchpad || '',
        isOpenOrClose: a.is_open_or_close,
      }));

      return {
        wallet,
        tradeCount: trades.length,
        next: data.next || null,
        hasMore: !!data.next,
        trades,
        summary: {
          buys: trades.filter((t: any) => t.type === 'buy').length,
          sells: trades.filter((t: any) => t.type === 'sell').length,
          totalBoughtSOL: trades
            .filter((t: any) => t.type === 'buy')
            .reduce((s: number, t: any) => s + Number(t.solAmount || 0), 0)
            .toFixed(4),
          totalSoldSOL: trades
            .filter((t: any) => t.type === 'sell')
            .reduce((s: number, t: any) => s + Number(t.solAmount || 0), 0)
            .toFixed(4),
        },
      };
    } catch (err: any) {
      this.logger.warn(`getWalletActivityGmgn failed: ${err.message}`);
      return { error: `Failed to fetch GMGN activity: ${err.message}` };
    }
  }
}
