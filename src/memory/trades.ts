import { Database } from './sql-compat.ts';
import { TradeResult, TradeIntent, SessionStats } from '../types.ts';

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
      SELECT action, success, amount_sol, price, mint FROM trades
      WHERE created_at >= ? AND success = 1
    `).all(sinceTs) as any[];

    const byMint = new Map<string, { bought: number; sold: number }>();
    for (const t of trades) {
      const entry = byMint.get(t.mint) || { bought: 0, sold: 0 };
      if (t.action === 'buy') entry.bought += (t.amount_sol || 0);
      else if (t.action === 'sell') entry.sold += (t.amount_sol || 0);
      byMint.set(t.mint, entry);
    }

    let tradesWon = 0;
    let tradesLost = 0;
    let totalPnl = 0;
    for (const [, entry] of byMint) {
      const pnl = entry.sold - entry.bought;
      totalPnl += pnl;
      if (entry.sold > 0 && entry.bought > 0) {

        if (pnl > 0) tradesWon++;
        else tradesLost++;
      }
    }

    const completedTrades = tradesWon + tradesLost;
    const winRate = completedTrades > 0 ? tradesWon / completedTrades : 0;

    return {
      tokensScanned: 0,
      signalsGenerated: 0,
      tradesExecuted: trades.length,
      tradesWon,
      tradesLost,
      totalPnlSol: totalPnl,
      peakPnlSol: Math.max(totalPnl, 0),
      worstDrawdownSol: Math.min(totalPnl, 0),
      winRate,
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
