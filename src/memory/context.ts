
import { Database } from './sql-compat.ts';

export const CONTEXT_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS dev_wallet_memory (
  address TEXT PRIMARY KEY,
  total_launches INTEGER DEFAULT 0,
  rug_count INTEGER DEFAULT 0,
  clean_count INTEGER DEFAULT 0,
  avg_token_lifetime_min REAL DEFAULT 0,
  avg_mcap_peak REAL DEFAULT 0,
  last_seen INTEGER,
  reputation TEXT DEFAULT 'unknown',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS hourly_performance (
  hour INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  total_trades INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl_sol REAL DEFAULT 0,
  PRIMARY KEY (hour, day_of_week)
);

CREATE TABLE IF NOT EXISTS pattern_memory (
  pattern TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  occurrences INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  avg_pnl_percent REAL DEFAULT 0,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS narrative_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  narrative TEXT NOT NULL,
  keywords TEXT NOT NULL,
  tokens_matched INTEGER DEFAULT 0,
  tokens_bought INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl_sol REAL DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  expired_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dev_wallet_rep ON dev_wallet_memory(reputation);
CREATE INDEX IF NOT EXISTS idx_pattern_cat ON pattern_memory(category);
`;

export class ContextualMemory {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(CONTEXT_MEMORY_SCHEMA);
  }

  recordDevLaunch(address: string, data: {
    isRug: boolean;
    lifetimeMin: number;
    peakMcap: number;
  }): void {
    const existing = this.db.prepare('SELECT * FROM dev_wallet_memory WHERE address = ?').get(address) as any;

    if (!existing) {
      this.db.prepare(`
        INSERT INTO dev_wallet_memory (address, total_launches, rug_count, clean_count, avg_token_lifetime_min, avg_mcap_peak, last_seen, reputation)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        address,
        data.isRug ? 1 : 0,
        data.isRug ? 0 : 1,
        data.lifetimeMin,
        data.peakMcap,
        Date.now(),
        data.isRug ? 'suspicious' : 'unknown',
      );
    } else {
      const total = existing.total_launches + 1;
      const rugs = existing.rug_count + (data.isRug ? 1 : 0);
      const clean = existing.clean_count + (data.isRug ? 0 : 1);
      const avgLife = ((existing.avg_token_lifetime_min * existing.total_launches) + data.lifetimeMin) / total;
      const avgMcap = ((existing.avg_mcap_peak * existing.total_launches) + data.peakMcap) / total;

      let rep = 'unknown';
      if (rugs >= 3 || (total >= 3 && rugs / total > 0.6)) rep = 'serial_rugger';
      else if (clean >= 3 && rugs === 0) rep = 'trusted';
      else if (rugs > 0 && clean > rugs) rep = 'mixed';
      else if (rugs > 0) rep = 'suspicious';

      this.db.prepare(`
        UPDATE dev_wallet_memory SET
          total_launches = ?, rug_count = ?, clean_count = ?,
          avg_token_lifetime_min = ?, avg_mcap_peak = ?,
          last_seen = ?, reputation = ?
        WHERE address = ?
      `).run(total, rugs, clean, avgLife, avgMcap, Date.now(), rep, address);
    }
  }

  getDevReputation(address: string): {
    reputation: string;
    totalLaunches: number;
    rugRate: number;
    avgLifetimeMin: number;
    avgMcapPeak: number;
  } | null {
    const row = this.db.prepare('SELECT * FROM dev_wallet_memory WHERE address = ?').get(address) as any;
    if (!row) return null;
    return {
      reputation: row.reputation,
      totalLaunches: row.total_launches,
      rugRate: row.total_launches > 0 ? row.rug_count / row.total_launches : 0,
      avgLifetimeMin: row.avg_token_lifetime_min,
      avgMcapPeak: row.avg_mcap_peak,
    };
  }

  getSerialRuggers(minRugs: number = 3): Array<{ address: string; rugCount: number; totalLaunches: number }> {
    return (this.db.prepare(
      'SELECT address, rug_count, total_launches FROM dev_wallet_memory WHERE rug_count >= ? ORDER BY rug_count DESC'
    ).all(minRugs) as any[]).map(r => ({
      address: r.address,
      rugCount: r.rug_count,
      totalLaunches: r.total_launches,
    }));
  }

  recordHourlyOutcome(pnlSol: number, isWin: boolean): void {
    const now = new Date();
    const hour = now.getUTCHours();
    const dow = now.getUTCDay();

    const existing = this.db.prepare(
      'SELECT * FROM hourly_performance WHERE hour = ? AND day_of_week = ?'
    ).get(hour, dow) as any;

    if (!existing) {
      this.db.prepare(`
        INSERT INTO hourly_performance (hour, day_of_week, total_trades, wins, losses, total_pnl_sol)
        VALUES (?, ?, 1, ?, ?, ?)
      `).run(hour, dow, isWin ? 1 : 0, isWin ? 0 : 1, pnlSol);
    } else {
      this.db.prepare(`
        UPDATE hourly_performance SET
          total_trades = total_trades + 1,
          wins = wins + ?,
          losses = losses + ?,
          total_pnl_sol = total_pnl_sol + ?
        WHERE hour = ? AND day_of_week = ?
      `).run(isWin ? 1 : 0, isWin ? 0 : 1, pnlSol, hour, dow);
    }
  }

  getBestTradingHours(minTrades: number = 5): Array<{
    hour: number;
    dayOfWeek: number;
    winRate: number;
    avgPnl: number;
    totalTrades: number;
  }> {
    return (this.db.prepare(`
      SELECT * FROM hourly_performance WHERE total_trades >= ? ORDER BY (CAST(wins AS REAL) / total_trades) DESC LIMIT 10
    `).all(minTrades) as any[]).map(r => ({
      hour: r.hour,
      dayOfWeek: r.day_of_week,
      winRate: r.total_trades > 0 ? r.wins / r.total_trades : 0,
      avgPnl: r.total_trades > 0 ? r.total_pnl_sol / r.total_trades : 0,
      totalTrades: r.total_trades,
    }));
  }

  getWorstTradingHours(minTrades: number = 5): Array<{
    hour: number;
    dayOfWeek: number;
    winRate: number;
    avgPnl: number;
  }> {
    return (this.db.prepare(`
      SELECT * FROM hourly_performance WHERE total_trades >= ? ORDER BY (CAST(wins AS REAL) / total_trades) ASC LIMIT 10
    `).all(minTrades) as any[]).map(r => ({
      hour: r.hour,
      dayOfWeek: r.day_of_week,
      winRate: r.total_trades > 0 ? r.wins / r.total_trades : 0,
      avgPnl: r.total_trades > 0 ? r.total_pnl_sol / r.total_trades : 0,
    }));
  }

  recordPattern(pattern: string, category: string, pnlPercent: number, isWin: boolean): void {
    const existing = this.db.prepare('SELECT * FROM pattern_memory WHERE pattern = ?').get(pattern) as any;

    if (!existing) {
      this.db.prepare(`
        INSERT INTO pattern_memory (pattern, category, occurrences, wins, losses, avg_pnl_percent, last_seen)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(pattern, category, isWin ? 1 : 0, isWin ? 0 : 1, pnlPercent, Date.now());
    } else {
      const newOcc = existing.occurrences + 1;
      const newAvg = ((existing.avg_pnl_percent * existing.occurrences) + pnlPercent) / newOcc;
      this.db.prepare(`
        UPDATE pattern_memory SET
          occurrences = ?, wins = wins + ?, losses = losses + ?,
          avg_pnl_percent = ?, last_seen = ?
        WHERE pattern = ?
      `).run(newOcc, isWin ? 1 : 0, isWin ? 0 : 1, newAvg, Date.now(), pattern);
    }
  }

  getProfitablePatterns(category: string, minOccurrences: number = 3): Array<{
    pattern: string;
    winRate: number;
    avgPnl: number;
    occurrences: number;
  }> {
    return (this.db.prepare(`
      SELECT * FROM pattern_memory
      WHERE category = ? AND occurrences >= ?
      ORDER BY avg_pnl_percent DESC LIMIT 20
    `).all(category, minOccurrences) as any[]).map(r => ({
      pattern: r.pattern,
      winRate: r.occurrences > 0 ? r.wins / r.occurrences : 0,
      avgPnl: r.avg_pnl_percent,
      occurrences: r.occurrences,
    }));
  }

  recordNarrativeOutcome(narrative: string, keywords: string[], tokensBought: number, wins: number, losses: number, pnlSol: number): void {
    this.db.prepare(`
      INSERT INTO narrative_outcomes (narrative, keywords, tokens_bought, wins, losses, total_pnl_sol)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(narrative, JSON.stringify(keywords), tokensBought, wins, losses, pnlSol);
  }

  getBestNarratives(limit: number = 10): Array<{
    narrative: string;
    tokensBought: number;
    wins: number;
    losses: number;
    totalPnl: number;
  }> {
    return (this.db.prepare(`
      SELECT narrative, SUM(tokens_bought) as tb, SUM(wins) as w, SUM(losses) as l, SUM(total_pnl_sol) as pnl
      FROM narrative_outcomes
      GROUP BY narrative
      ORDER BY pnl DESC LIMIT ?
    `).all(limit) as any[]).map(r => ({
      narrative: r.narrative,
      tokensBought: r.tb,
      wins: r.w,
      losses: r.l,
      totalPnl: r.pnl,
    }));
  }

  buildContextSummary(): string {
    const parts: string[] = ['[CONTEXTUAL MEMORY]'];

    const ruggers = this.getSerialRuggers(2);
    if (ruggers.length > 0) {
      parts.push(`Known serial ruggers: ${ruggers.length} wallets (${ruggers.slice(0, 3).map(r => r.address.slice(0, 8) + '...' + r.rugCount + 'rugs').join(', ')})`);
    }


    const bestHours = this.getBestTradingHours(3);
    if (bestHours.length > 0) {
      const best = bestHours[0];
      parts.push(`Best trading: UTC ${best.hour}:00 Day${best.dayOfWeek} (${(best.winRate * 100).toFixed(0)}% WR, avg ${best.avgPnl.toFixed(3)} SOL)`);
    }
    const worstHours = this.getWorstTradingHours(3);
    if (worstHours.length > 0) {
      const worst = worstHours[0];
      parts.push(`Worst trading: UTC ${worst.hour}:00 Day${worst.dayOfWeek} (${(worst.winRate * 100).toFixed(0)}% WR)`);
    }


    const namePatterns = this.getProfitablePatterns('name', 2);
    if (namePatterns.length > 0) {
      parts.push(`Profitable name patterns: ${namePatterns.slice(0, 3).map(p => `"${p.pattern}" ${(p.winRate * 100).toFixed(0)}%WR`).join(', ')}`);
    }

    const narrs = this.getBestNarratives(3);
    if (narrs.length > 0) {
      parts.push(`Best narratives: ${narrs.map(n => `"${n.narrative}" ${n.totalPnl.toFixed(2)}SOL`).join(', ')}`);
    }

    return parts.join('\n');
  }
}
