import { Database } from './sql-compat.ts';
import {
  MemoryInterface, TradeResult, TradeIntent, SessionStats,
  TokenInfo, TokenSnapshot, TokenAnalysis, HolderData,
} from '../types.ts';
import { TradeLog } from './trades.ts';
import { TokenStore } from './tokens.ts';

export { createDatabase } from './store.ts';
export { initDatabaseEngine } from './sql-compat.ts';
export { TradeLog } from './trades.ts';
export { TokenStore } from './tokens.ts';
export { ContextualMemory } from './context.ts';

export class Memory implements MemoryInterface {
  private tradeLog: TradeLog;
  private tokenStore: TokenStore;
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.tradeLog = new TradeLog(db);
    this.tokenStore = new TokenStore(db);
  }

  getDb(): Database {
    return this.db;
  }

  getTradeLog(): TradeLog {
    return this.tradeLog;
  }

  getTokenStore(): TokenStore {
    return this.tokenStore;
  }

  recordTrade(trade: TradeResult & { intent: TradeIntent }): void {
    this.tradeLog.record(trade, trade.intent);
  }

  getTradeHistory(opts?: { limit?: number; mint?: string; since?: number }): any[] {
    return this.tradeLog.getHistory(opts);
  }

  getStats(period?: '1h' | '4h' | '24h' | '7d' | 'all'): SessionStats {
    const periodMs: Record<string, number> = {
      '1h': 3_600_000,
      '4h': 14_400_000,
      '24h': 86_400_000,
      '7d': 604_800_000,
      'all': 0,
    };
    const since = period ? Date.now() - (periodMs[period] || 0) : 0;
    return this.tradeLog.getStats(since);
  }

  storeToken(token: TokenInfo): void {
    this.tokenStore.store(token);
  }

  getToken(mint: string): TokenInfo | null {
    return this.tokenStore.get(mint);
  }

  getTopTokens(
    period: '1h' | '4h' | '24h',
    by: 'volume' | 'mcap' | 'holders' | 'mentions',
    limit?: number
  ): TokenInfo[] {
    return this.tokenStore.getTopTokens(period, by, limit);
  }

  storeSnapshot(snapshot: TokenSnapshot): void {
    this.tokenStore.storeSnapshot(snapshot);
  }

  getSnapshots(mint: string, since?: number): TokenSnapshot[] {
    return this.tokenStore.getSnapshots(mint, since);
  }

  storeAnalysis(analysis: TokenAnalysis): void {
    this.tokenStore.storeAnalysis(analysis);
  }

  getAnalysis(mint: string): TokenAnalysis | null {
    return this.tokenStore.getAnalysis(mint);
  }

  storeHolderData(data: HolderData): void {
    this.tokenStore.storeHolderData(data);
  }

  getHolderData(mint: string): HolderData | null {
    return this.tokenStore.getHolderData(mint);
  }

  addRugAddress(address: string, reason: string): void {
    this.tokenStore.addRugAddress(address, reason);
  }

  isKnownRug(address: string): boolean {
    return this.tokenStore.isKnownRug(address);
  }

  saveSession(session: {
    id: string;
    mode: string;
    strategy?: string;
    startedAt: number;
    endedAt?: number;
    status: string;
    stats: SessionStats;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, mode, strategy, started_at, ended_at, status, stats)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.mode,
      session.strategy || null,
      session.startedAt,
      session.endedAt || null,
      session.status,
      JSON.stringify(session.stats),
    );
  }

  getSession(id: string): any | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      ...row,
      stats: JSON.parse(row.stats || '{}'),
    };
  }

  getRecentSessions(limit: number = 10): any[] {
    return (this.db.prepare(
      'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as any[]).map(row => ({
      ...row,
      stats: JSON.parse(row.stats || '{}'),
    }));
  }

  cleanOldSnapshots(olderThanMs: number = 7 * 86_400_000): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db.prepare('DELETE FROM token_snapshots WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }

  recordLearningOutcome(data: {
    mint: string;
    signals: string[];
    outcome: 'win' | 'loss' | 'breakeven';
    pnlSol: number;
    pnlPercent: number;
    pipelineScore: number;
    holdDurationMin: number;
  }): void {
    this.db.prepare(`
      INSERT INTO pipeline_learning (mint, signals, outcome, pnl_sol, pnl_percent, pipeline_score, hold_duration_min)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.mint,
      JSON.stringify(data.signals),
      data.outcome,
      data.pnlSol,
      data.pnlPercent,
      data.pipelineScore,
      data.holdDurationMin,
    );
  }

  getLearningStats(sinceDays: number = 7): {
    winSignals: string[];
    loseSignals: string[];
    winRate: number;
    totalTrades: number;
    avgWinPnl: number;
    avgLossPnl: number;
  } {
    const since = Date.now() - (sinceDays * 86_400_000);

    const rows = this.db.prepare(`
      SELECT signals, outcome, pnl_sol FROM pipeline_learning WHERE created_at > ?
    `).all(since) as any[];

    const wins: string[][] = [];
    const losses: string[][] = [];
    let winPnlSum = 0;
    let lossPnlSum = 0;

    for (const row of rows) {
      const signals = JSON.parse(row.signals) as string[];
      if (row.outcome === 'win') {
        wins.push(signals);
        winPnlSum += row.pnl_sol || 0;
      } else if (row.outcome === 'loss') {
        losses.push(signals);
        lossPnlSum += row.pnl_sol || 0;
      }
    }

    const winSignalFreq = new Map<string, number>();
    const loseSignalFreq = new Map<string, number>();

    for (const sigs of wins) {
      for (const s of sigs) {
        winSignalFreq.set(s, (winSignalFreq.get(s) || 0) + 1);
      }
    }
    for (const sigs of losses) {
      for (const s of sigs) {
        loseSignalFreq.set(s, (loseSignalFreq.get(s) || 0) + 1);
      }
    }

    const winSignals: string[] = [];
    const loseSignals: string[] = [];

    const allSignals = new Set([...winSignalFreq.keys(), ...loseSignalFreq.keys()]);
    for (const sig of allSignals) {
      const wCount = winSignalFreq.get(sig) || 0;
      const lCount = loseSignalFreq.get(sig) || 0;
      if (wCount > lCount) winSignals.push(sig);
      else if (lCount > wCount) loseSignals.push(sig);
    }

    const total = rows.length;
    return {
      winSignals,
      loseSignals,
      winRate: total > 0 ? wins.length / total : 0,
      totalTrades: total,
      avgWinPnl: wins.length > 0 ? winPnlSum / wins.length : 0,
      avgLossPnl: losses.length > 0 ? lossPnlSum / losses.length : 0,
    };
  }

  savePipelineWeights(weights: Record<string, number>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO pipeline_weights (id, socials, bonding_curve, dev_wallet, holders, trending, name_quality, behavioral, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      weights.socials || 1,
      weights.bondingCurve || weights.bonding_curve || 1,
      weights.devWallet || weights.dev_wallet || 1,
      weights.holders || 1,
      weights.trending || 1,
      weights.nameQuality || weights.name_quality || 1,
      weights.behavioral || 1,
      Date.now(),
    );
  }

  loadPipelineWeights(): Record<string, number> | null {
    const row = this.db.prepare('SELECT * FROM pipeline_weights WHERE id = 1').get() as any;
    if (!row) return null;
    return {
      socials: row.socials,
      bondingCurve: row.bonding_curve,
      devWallet: row.dev_wallet,
      holders: row.holders,
      trending: row.trending,
      nameQuality: row.name_quality,
      behavioral: row.behavioral,
    };
  }

  close(): void {
    this.db.close();
  }

  saveAIMemory(category: string, content: string, subject?: string, tags?: string[]): number {
    const result = this.db.prepare(`
      INSERT INTO ai_memory (category, subject, content, tags)
      VALUES (?, ?, ?, ?)
    `).run(category, subject || null, content, tags ? JSON.stringify(tags) : null);
    return Number(result.lastInsertRowid);
  }

  searchAIMemory(query: string, limit: number = 10): any[] {
    const pattern = `%${query}%`;
    return this.db.prepare(`
      SELECT id, category, subject, content, tags, created_at FROM ai_memory
      WHERE content LIKE ? OR subject LIKE ? OR tags LIKE ?
      ORDER BY created_at DESC LIMIT ?
    `).all(pattern, pattern, pattern, limit) as any[];
  }

getAIMemoryByCategory(category: string, subject?: string, limit: number = 20): any[] {
    if (subject) {
      return this.db.prepare(`
        SELECT id, category, subject, content, tags, created_at FROM ai_memory
        WHERE category = ? AND subject = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(category, subject, limit) as any[];
    }
    return this.db.prepare(`
      SELECT id, category, subject, content, tags, created_at FROM ai_memory
      WHERE category = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(category, limit) as any[];
  }

getRecentAIMemories(limit: number = 15): any[] {
    return this.db.prepare(`
      SELECT id, category, subject, content, tags, created_at FROM ai_memory
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];
  }

deleteAIMemory(id: number): boolean {
    const result = this.db.prepare('DELETE FROM ai_memory WHERE id = ?').run(id);
    return result.changes > 0;
  }


storeTokenPattern(pattern: {
    mint: string;
    dev?: string;
    name?: string;
    symbol?: string;
    descriptionWords?: string[];
    twitterHandle?: string;
    telegramHandle?: string;
    websiteDomain?: string;
    websiteContentHash?: string;
    namePattern?: string;
    narrativeTags?: string[];
    score?: number;
    rugScore?: number;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO token_patterns
        (mint, dev, name, symbol, description_words, twitter_handle, telegram_handle, website_domain, website_content_hash, name_pattern, narrative_tags, score, rug_score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pattern.mint,
      pattern.dev || null,
      pattern.name || null,
      pattern.symbol || null,
      pattern.descriptionWords ? JSON.stringify(pattern.descriptionWords) : null,
      pattern.twitterHandle || null,
      pattern.telegramHandle || null,
      pattern.websiteDomain || null,
      pattern.websiteContentHash || null,
      pattern.namePattern || null,
      pattern.narrativeTags ? JSON.stringify(pattern.narrativeTags) : null,
      pattern.score ?? null,
      pattern.rugScore ?? null,
      Date.now(),
    );
  }

findPatternsByDev(dev: string, excludeMint?: string): any[] {
    if (excludeMint) {
      return this.db.prepare(
        'SELECT * FROM token_patterns WHERE dev = ? AND mint != ? ORDER BY created_at DESC'
      ).all(dev, excludeMint) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM token_patterns WHERE dev = ? ORDER BY created_at DESC'
    ).all(dev) as any[];
  }

findPatternsByTwitter(handle: string, excludeMint?: string): any[] {
    if (excludeMint) {
      return this.db.prepare(
        'SELECT * FROM token_patterns WHERE twitter_handle = ? AND mint != ? ORDER BY created_at DESC'
      ).all(handle, excludeMint) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM token_patterns WHERE twitter_handle = ? ORDER BY created_at DESC'
    ).all(handle) as any[];
  }

findPatternsByTelegram(handle: string, excludeMint?: string): any[] {
    if (excludeMint) {
      return this.db.prepare(
        'SELECT * FROM token_patterns WHERE telegram_handle = ? AND mint != ? ORDER BY created_at DESC'
      ).all(handle, excludeMint) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM token_patterns WHERE telegram_handle = ? ORDER BY created_at DESC'
    ).all(handle) as any[];
  }

findPatternsByWebsite(domain: string, excludeMint?: string): any[] {
    if (excludeMint) {
      return this.db.prepare(
        'SELECT * FROM token_patterns WHERE website_domain = ? AND mint != ? ORDER BY created_at DESC'
      ).all(domain, excludeMint) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM token_patterns WHERE website_domain = ? ORDER BY created_at DESC'
    ).all(domain) as any[];
  }

findPatternsByContentHash(hash: string, excludeMint?: string): any[] {
    if (excludeMint) {
      return this.db.prepare(
        'SELECT * FROM token_patterns WHERE website_content_hash = ? AND mint != ? ORDER BY created_at DESC'
      ).all(hash, excludeMint) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM token_patterns WHERE website_content_hash = ? ORDER BY created_at DESC'
    ).all(hash) as any[];
  }

findPatternsByNamePattern(pattern: string, excludeMint?: string): any[] {
    if (excludeMint) {
      return this.db.prepare(
        'SELECT * FROM token_patterns WHERE name_pattern = ? AND mint != ? ORDER BY created_at DESC'
      ).all(pattern, excludeMint) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM token_patterns WHERE name_pattern = ? ORDER BY created_at DESC'
    ).all(pattern) as any[];
  }

getAllPatternsWithDescriptions(excludeMint?: string, limit: number = 500): any[] {
    if (excludeMint) {
      return this.db.prepare(
        'SELECT mint, name, symbol, dev, description_words, score, rug_score, outcome, created_at FROM token_patterns WHERE description_words IS NOT NULL AND mint != ? ORDER BY created_at DESC LIMIT ?'
      ).all(excludeMint, limit) as any[];
    }
    return this.db.prepare(
      'SELECT mint, name, symbol, dev, description_words, score, rug_score, outcome, created_at FROM token_patterns WHERE description_words IS NOT NULL ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as any[];
  }

updatePatternOutcome(mint: string, outcome: string): void {
    this.db.prepare(
      'UPDATE token_patterns SET outcome = ? WHERE mint = ?'
    ).run(outcome, mint);
  }

getPatternStats(): {
    totalPatterns: number;
    devRepeatRate: number;
    avgScoreRepeaters: number;
    avgScoreUnique: number;
    outcomeByRepeat: { repeaters: { win: number; loss: number; rug: number }; unique: { win: number; loss: number; rug: number } };
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM token_patterns').get() as any)?.cnt || 0;


    const devRepeats = this.db.prepare(`
      SELECT dev, COUNT(*) as cnt, AVG(score) as avg_score
      FROM token_patterns WHERE dev IS NOT NULL
      GROUP BY dev HAVING cnt > 1
    `).all() as any[];

    const repeaterMints = new Set<string>();
    for (const d of devRepeats) {
      const mints = this.db.prepare('SELECT mint FROM token_patterns WHERE dev = ?').all(d.dev) as any[];
      for (const m of mints) repeaterMints.add(m.mint);
    }

    const allWithOutcome = this.db.prepare(
      'SELECT mint, score, outcome FROM token_patterns WHERE outcome IS NOT NULL'
    ).all() as any[];

    const outcomeByRepeat = {
      repeaters: { win: 0, loss: 0, rug: 0 },
      unique: { win: 0, loss: 0, rug: 0 },
    };
    let repeaterScoreSum = 0, repeaterCount = 0;
    let uniqueScoreSum = 0, uniqueCount = 0;

    for (const row of allWithOutcome) {
      const bucket = repeaterMints.has(row.mint) ? 'repeaters' : 'unique';
      if (row.outcome === 'win') outcomeByRepeat[bucket].win++;
      else if (row.outcome === 'loss') outcomeByRepeat[bucket].loss++;
      else if (row.outcome === 'rug') outcomeByRepeat[bucket].rug++;
    }

    for (const row of this.db.prepare('SELECT mint, score FROM token_patterns WHERE score IS NOT NULL').all() as any[]) {
      if (repeaterMints.has(row.mint)) { repeaterScoreSum += row.score; repeaterCount++; }
      else { uniqueScoreSum += row.score; uniqueCount++; }
    }

    return {
      totalPatterns: total,
      devRepeatRate: total > 0 ? repeaterMints.size / total : 0,
      avgScoreRepeaters: repeaterCount > 0 ? repeaterScoreSum / repeaterCount : 0,
      avgScoreUnique: uniqueCount > 0 ? uniqueScoreSum / uniqueCount : 0,
      outcomeByRepeat,
    };
  }
}
