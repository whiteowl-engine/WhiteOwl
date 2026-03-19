import { Database } from './sql-compat';
import { TradeResult, TradeIntent, SessionStats } from '../types';

export class TradeLog {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  record(result: TradeResult, intent: TradeIntent, sessionId?: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO trades (id, session_id, agent_id, action, mint, symbol, amount_sol, amount_tokens, price, slippage_bps, priority_fee, tx_hash, success, reason, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.intentId,
      sessionId || null,
      intent.agentId,
      intent.action,
      intent.mint,
      intent.symbol || null,
      result.amountSol || intent.amountSol || null,
      result.amountTokens || null,
      result.price || null,
      intent.slippageBps,
      intent.priorityFeeSol,
      result.txHash || null,
      result.success ? 1 : 0,
      intent.reason,
      result.error || null,
      result.timestamp,
    );
  }

  getHistory(opts?: {
    limit?: number;
    mint?: string;
    since?: number;
    agentId?: string;
    sessionId?: string;
  }): any[] {
    let sql = 'SELECT * FROM trades WHERE 1=1';
    const params: any[] = [];

    if (opts?.mint) {
      sql += ' AND mint = ?';
      params.push(opts.mint);
    }
    if (opts?.since) {
      sql += ' AND created_at >= ?';
      params.push(opts.since);
    }
    if (opts?.agentId) {
      sql += ' AND agent_id = ?';
      params.push(opts.agentId);
    }
    if (opts?.sessionId) {
      sql += ' AND session_id = ?';
      params.push(opts.sessionId);
    }

    sql += ' ORDER BY created_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    return this.db.prepare(sql).all(...params);
  }

  getStats(since?: number): SessionStats {
    const sinceTs = since || 0;

    const trades = this.db.prepare(`
      SELECT action, success, amount_sol, price FROM trades
      WHERE created_at >= ? AND success = 1
    `).all(sinceTs) as any[];

    // Group buys and sells per mint to calculate P&L
    const buys = trades.filter(t => t.action === 'buy');
    const sells = trades.filter(t => t.action === 'sell');

    const totalBuySol = buys.reduce((s, t) => s + (t.amount_sol || 0), 0);
    const totalSellSol = sells.reduce((s, t) => s + (t.amount_sol || 0), 0);
    const pnl = totalSellSol - totalBuySol;

    return {
      tokensScanned: 0,
      signalsGenerated: 0,
      tradesExecuted: trades.length,
      tradesWon: sells.filter(t => (t.amount_sol || 0) > 0).length,
      tradesLost: 0,
      totalPnlSol: pnl,
      peakPnlSol: Math.max(pnl, 0),
      worstDrawdownSol: Math.min(pnl, 0),
    };
  }

  getPnlByToken(): Array<{ mint: string; symbol: string; bought: number; sold: number; pnl: number }> {
    const rows = this.db.prepare(`
      SELECT mint, symbol,
        SUM(CASE WHEN action = 'buy' THEN amount_sol ELSE 0 END) as bought,
        SUM(CASE WHEN action = 'sell' THEN amount_sol ELSE 0 END) as sold
      FROM trades WHERE success = 1
      GROUP BY mint
    `).all() as any[];

    return rows.map(r => ({
      mint: r.mint,
      symbol: r.symbol || '???',
      bought: r.bought,
      sold: r.sold,
      pnl: r.sold - r.bought,
    }));
  }
}
