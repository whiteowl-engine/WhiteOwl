import { Database } from './sql-compat.ts';
import { NewsItem, NewsCategory, NewsSentiment, NewsSentimentSummary } from '../types.ts';

const NEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS news_headlines (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  summary_ru TEXT,
  url TEXT,
  source TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  sentiment TEXT NOT NULL DEFAULT 'neutral',
  relevance_score INTEGER NOT NULL DEFAULT 50,
  mentioned_tokens TEXT DEFAULT '[]',
  priority REAL NOT NULL DEFAULT 0,
  votes_bullish INTEGER DEFAULT 0,
  votes_bearish INTEGER DEFAULT 0,
  votes_important INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_news_category_priority ON news_headlines(category, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_created ON news_headlines(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_source ON news_headlines(source);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_headlines(published_at DESC);
`;

const PURGE_AGE_MS = 48 * 60 * 60 * 1000;

export class NewsStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(NEWS_SCHEMA);

    try { this.db.exec('ALTER TABLE news_headlines ADD COLUMN content_hash TEXT'); } catch (_) {  }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_news_content_hash ON news_headlines(content_hash)');
  }

  store(item: NewsItem, contentHash?: string): boolean {
    const existing = this.db.prepare('SELECT id FROM news_headlines WHERE id = ?').get(item.id);
    if (existing) return false;

    this.db.prepare(`
      INSERT INTO news_headlines
        (id, title, summary, summary_ru, url, source, published_at, category, sentiment,
         relevance_score, mentioned_tokens, priority, votes_bullish, votes_bearish, votes_important, created_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.title,
      item.summary || null,
      item.summary_ru || null,
      item.url || null,
      item.source,
      item.published_at,
      item.category,
      item.sentiment,
      item.relevance_score,
      JSON.stringify(item.mentioned_tokens || []),
      item.priority,
      item.votes?.bullish || 0,
      item.votes?.bearish || 0,
      item.votes?.important || 0,
      item.created_at || Date.now(),
      contentHash || null
    );
    return true;
  }

  updateEnrichment(id: string, data: {
    sentiment?: NewsSentiment;
    relevance_score?: number;
    category?: NewsCategory;
    mentioned_tokens?: string[];
    summary_ru?: string;
    priority?: number;
  }): void {
    const sets: string[] = [];
    const params: any[] = [];

    if (data.sentiment !== undefined) { sets.push('sentiment = ?'); params.push(data.sentiment); }
    if (data.relevance_score !== undefined) { sets.push('relevance_score = ?'); params.push(data.relevance_score); }
    if (data.category !== undefined) { sets.push('category = ?'); params.push(data.category); }
    if (data.mentioned_tokens !== undefined) { sets.push('mentioned_tokens = ?'); params.push(JSON.stringify(data.mentioned_tokens)); }
    if (data.summary_ru !== undefined) { sets.push('summary_ru = ?'); params.push(data.summary_ru); }
    if (data.priority !== undefined) { sets.push('priority = ?'); params.push(data.priority); }

    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE news_headlines SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  getItems(opts?: {
    limit?: number;
    offset?: number;
    category?: NewsCategory | 'all';
    since?: number;
    source?: string;
  }): NewsItem[] {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const since = opts?.since ?? 0;

    const oneHourAgo = Date.now() - 3600_000;
    const effectiveSince = Math.max(since, oneHourAgo);

    let sql = 'SELECT * FROM news_headlines WHERE created_at > ?';
    const params: any[] = [effectiveSince];

    if (opts?.category && opts.category !== 'all') {
      sql += ' AND category = ?';
      params.push(opts.category);
    }
    if (opts?.source) {
      sql += ' AND source = ?';
      params.push(opts.source);
    }

    sql += ' ORDER BY published_at DESC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.rowToItem(r));
  }

  getUnenriched(limit: number = 20): NewsItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM news_headlines WHERE summary_ru IS NULL ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(r => this.rowToItem(r));
  }

  getTopByPriority(limit: number = 5, sinceMs: number = 3_600_000): NewsItem[] {
    const since = Date.now() - sinceMs;
    const rows = this.db.prepare(
      `SELECT * FROM news_headlines WHERE created_at > ? ORDER BY priority DESC LIMIT ?`
    ).all(since, limit) as any[];
    return rows.map(r => this.rowToItem(r));
  }

  getSentimentSummary(sinceMs: number = 3_600_000): NewsSentimentSummary {
    const since = Date.now() - sinceMs;
    const rows = this.db.prepare(
      `SELECT sentiment, COUNT(*) as cnt FROM news_headlines WHERE created_at > ? GROUP BY sentiment`
    ).all(since) as any[];

    let bullish = 0, bearish = 0, neutral = 0;
    for (const r of rows) {
      if (r.sentiment === 'bullish') bullish = r.cnt;
      else if (r.sentiment === 'bearish') bearish = r.cnt;
      else neutral = r.cnt;
    }

    const total = bullish + bearish + neutral;
    let trend: NewsSentimentSummary['trend'] = 'neutral';
    if (total > 0) {
      if (bullish > bearish * 1.5) trend = 'bullish';
      else if (bearish > bullish * 1.5) trend = 'bearish';
      else if (total > 2) trend = 'mixed';
    }

    return { bullish, bearish, neutral, trend, updated_at: Date.now() };
  }

  search(query: string, limit: number = 20): NewsItem[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM news_headlines WHERE title LIKE ? OR summary LIKE ? OR summary_ru LIKE ?
       ORDER BY priority DESC, created_at DESC LIMIT ?`
    ).all(pattern, pattern, pattern, limit) as any[];
    return rows.map(r => this.rowToItem(r));
  }

  hasItem(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM news_headlines WHERE id = ?').get(id);
  }

  hasContentHash(hash: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM news_headlines WHERE content_hash = ?').get(hash);
  }

  purgeOld(): number {
    const cutoff = Date.now() - PURGE_AGE_MS;
    const result = this.db.prepare('DELETE FROM news_headlines WHERE created_at < ?').run(cutoff);
    return (result as any).changes || 0;
  }

  getCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM news_headlines').get() as any;
    return row?.cnt || 0;
  }

  private rowToItem(r: any): NewsItem {
    return {
      id: r.id,
      title: r.title,
      summary: r.summary,
      summary_ru: r.summary_ru,
      url: r.url,
      source: r.source,
      published_at: r.published_at,
      category: r.category as NewsCategory,
      sentiment: r.sentiment as NewsSentiment,
      relevance_score: r.relevance_score,
      mentioned_tokens: JSON.parse(r.mentioned_tokens || '[]'),
      priority: r.priority,
      votes: { bullish: r.votes_bullish || 0, bearish: r.votes_bearish || 0, important: r.votes_important || 0 },
      created_at: r.created_at,
    };
  }
}
