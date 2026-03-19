import { Database } from './sql-compat';
import { TokenInfo, TokenSnapshot, TokenAnalysis, HolderData } from '../types';

export class TokenStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  store(token: TokenInfo): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tokens (mint, name, symbol, description, dev, twitter, telegram, website, image, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token.mint, token.name, token.symbol, token.description || null,
      token.dev, token.twitter || null, token.telegram || null,
      token.website || null, token.image || null, token.createdAt
    );
  }

  get(mint: string): TokenInfo | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE mint = ?').get(mint) as any;
    if (!row) return null;

    const latestSnapshot = this.db.prepare(
      'SELECT * FROM token_snapshots WHERE mint = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(mint) as any;

    return {
      mint: row.mint,
      name: row.name,
      symbol: row.symbol,
      description: row.description,
      dev: row.dev,
      twitter: row.twitter,
      telegram: row.telegram,
      website: row.website,
      image: row.image,
      createdAt: row.created_at,
      bondingCurveProgress: latestSnapshot?.bonding_progress ?? 0,
      marketCap: latestSnapshot?.mcap ?? 0,
      volume24h: latestSnapshot?.volume_24h ?? 0,
      holders: latestSnapshot?.holders ?? 0,
      price: latestSnapshot?.price ?? 0,
    };
  }

  storeSnapshot(snapshot: TokenSnapshot): void {
    this.db.prepare(`
      INSERT INTO token_snapshots (mint, price, mcap, volume_5m, volume_1h, volume_24h, holders, bonding_progress, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.mint, snapshot.price, snapshot.mcap,
      snapshot.volume5m, snapshot.volume1h, snapshot.volume24h,
      snapshot.holders, snapshot.bondingProgress, snapshot.timestamp
    );
  }

  getSnapshots(mint: string, since?: number): TokenSnapshot[] {
    const sinceTs = since || 0;
    const rows = this.db.prepare(
      'SELECT * FROM token_snapshots WHERE mint = ? AND timestamp >= ? ORDER BY timestamp ASC'
    ).all(mint, sinceTs) as any[];

    return rows.map(r => ({
      mint: r.mint,
      price: r.price,
      mcap: r.mcap,
      volume5m: r.volume_5m,
      volume1h: r.volume_1h,
      volume24h: r.volume_24h,
      holders: r.holders,
      bondingProgress: r.bonding_progress,
      timestamp: r.timestamp,
    }));
  }

  getTopTokens(
    period: '1h' | '4h' | '24h',
    by: 'volume' | 'mcap' | 'holders' | 'mentions',
    limit: number = 20
  ): TokenInfo[] {
    const periodMs: Record<string, number> = {
      '1h': 3_600_000,
      '4h': 14_400_000,
      '24h': 86_400_000,
    };
    const since = Date.now() - (periodMs[period] || 86_400_000);

    const orderCol: Record<string, string> = {
      volume: 'MAX(s.volume_24h)',
      mcap: 'MAX(s.mcap)',
      holders: 'MAX(s.holders)',
      mentions: 'MAX(s.volume_24h)',
    };

    const orderBy = orderCol[by] || 'MAX(s.volume_24h)';

    const rows = this.db.prepare(`
      SELECT t.*, ${orderBy} as sort_val,
        (SELECT price FROM token_snapshots WHERE mint = t.mint ORDER BY timestamp DESC LIMIT 1) as latest_price,
        (SELECT mcap FROM token_snapshots WHERE mint = t.mint ORDER BY timestamp DESC LIMIT 1) as latest_mcap,
        (SELECT volume_24h FROM token_snapshots WHERE mint = t.mint ORDER BY timestamp DESC LIMIT 1) as latest_volume,
        (SELECT holders FROM token_snapshots WHERE mint = t.mint ORDER BY timestamp DESC LIMIT 1) as latest_holders,
        (SELECT bonding_progress FROM token_snapshots WHERE mint = t.mint ORDER BY timestamp DESC LIMIT 1) as latest_bonding
      FROM tokens t
      JOIN token_snapshots s ON s.mint = t.mint AND s.timestamp >= ?
      GROUP BY t.mint
      ORDER BY sort_val DESC
      LIMIT ?
    `).all(since, limit) as any[];

    return rows.map(r => ({
      mint: r.mint,
      name: r.name,
      symbol: r.symbol,
      description: r.description,
      dev: r.dev,
      twitter: r.twitter,
      telegram: r.telegram,
      website: r.website,
      image: r.image,
      createdAt: r.created_at,
      bondingCurveProgress: r.latest_bonding ?? 0,
      marketCap: r.latest_mcap ?? 0,
      volume24h: r.latest_volume ?? 0,
      holders: r.latest_holders ?? 0,
      price: r.latest_price ?? 0,
    }));
  }

  getTrendingTokens(limit: number = 10): Array<{ token: TokenInfo; priceChange: number; volumeGrowth: number }> {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;

    const rows = this.db.prepare(`
      SELECT t.*,
        s_now.price as price_now,
        s_old.price as price_old,
        s_now.volume_1h as vol_now,
        s_old.volume_1h as vol_old,
        s_now.holders as holders_now,
        s_now.mcap as mcap_now,
        s_now.bonding_progress as bonding_now,
        s_now.volume_24h as vol24h_now
      FROM tokens t
      JOIN token_snapshots s_now ON s_now.mint = t.mint AND s_now.id = (
        SELECT id FROM token_snapshots WHERE mint = t.mint ORDER BY timestamp DESC LIMIT 1
      )
      LEFT JOIN token_snapshots s_old ON s_old.mint = t.mint AND s_old.id = (
        SELECT id FROM token_snapshots WHERE mint = t.mint AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1
      )
      WHERE s_now.timestamp >= ?
      ORDER BY CASE WHEN s_old.price > 0 THEN (s_now.price - s_old.price) / s_old.price ELSE 0 END DESC
      LIMIT ?
    `).all(oneHourAgo, oneHourAgo, limit) as any[];

    return rows.map(r => {
      const priceChange = r.price_old > 0 ? ((r.price_now - r.price_old) / r.price_old) * 100 : 0;
      const volumeGrowth = r.vol_old > 0 ? ((r.vol_now - r.vol_old) / r.vol_old) * 100 : 0;

      return {
        token: {
          mint: r.mint,
          name: r.name,
          symbol: r.symbol,
          description: r.description,
          dev: r.dev,
          twitter: r.twitter,
          telegram: r.telegram,
          website: r.website,
          image: r.image,
          createdAt: r.created_at,
          bondingCurveProgress: r.bonding_now ?? 0,
          marketCap: r.mcap_now ?? 0,
          volume24h: r.vol24h_now ?? 0,
          holders: r.holders_now ?? 0,
          price: r.price_now ?? 0,
        },
        priceChange,
        volumeGrowth,
      };
    });
  }

  storeAnalysis(analysis: TokenAnalysis): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO token_analysis (mint, score, rug_score, signals, recommendation, reasoning, analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      analysis.mint, analysis.score, analysis.rugScore,
      JSON.stringify(analysis.signals), analysis.recommendation,
      analysis.reasoning, analysis.analyzedAt
    );
  }

  getAnalysis(mint: string): TokenAnalysis | null {
    const row = this.db.prepare('SELECT * FROM token_analysis WHERE mint = ?').get(mint) as any;
    if (!row) return null;

    return {
      mint: row.mint,
      score: row.score,
      rugScore: row.rug_score,
      signals: JSON.parse(row.signals || '[]'),
      recommendation: row.recommendation,
      reasoning: row.reasoning,
      analyzedAt: row.analyzed_at,
    };
  }

  storeHolderData(data: HolderData): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO holder_data (mint, total_holders, top10_percent, top20_percent, dev_holding_percent, is_bundled, suspicious_wallets, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.mint, data.totalHolders, data.top10Percent, data.top20Percent,
      data.devHoldingPercent, data.isBundled ? 1 : 0,
      JSON.stringify(data.suspiciousWallets), data.checkedAt
    );
  }

  getHolderData(mint: string): HolderData | null {
    const row = this.db.prepare('SELECT * FROM holder_data WHERE mint = ?').get(mint) as any;
    if (!row) return null;

    return {
      mint: row.mint,
      totalHolders: row.total_holders,
      top10Percent: row.top10_percent,
      top20Percent: row.top20_percent,
      devHoldingPercent: row.dev_holding_percent,
      isBundled: !!row.is_bundled,
      suspiciousWallets: JSON.parse(row.suspicious_wallets || '[]'),
      checkedAt: row.checked_at,
    };
  }

  addRugAddress(address: string, reason: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO rug_wallets (address, reason) VALUES (?, ?)'
    ).run(address, reason);
  }

  isKnownRug(address: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM rug_wallets WHERE address = ?').get(address);
    return !!row;
  }

  getTokenCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM tokens').get() as any;
    return row?.cnt || 0;
  }

  getSnapshotCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM token_snapshots').get() as any;
    return row?.cnt || 0;
  }

  cleanup(olderThanMs: number = 7 * 86_400_000): void {
    const cutoff = Date.now() - olderThanMs;
    this.db.prepare('DELETE FROM token_snapshots WHERE timestamp < ?').run(cutoff);
  }
}
