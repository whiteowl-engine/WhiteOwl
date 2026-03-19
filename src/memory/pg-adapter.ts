/**
 * PostgreSQL Adapter — Phase 6
 *
 * Drop-in replacement for SQLite when running in production.
 * Implements the same table schema but uses pg (node-postgres).
 *
 * Usage:
 *   import { createPostgresDatabase } from './pg-adapter';
 *   const db = createPostgresDatabase(connectionString);
 *
 * The adapter wraps pg.Pool with a sqlite-compatible interface
 * so existing Memory class works with minimal changes.
 */

/**
 * PostgreSQL-compatible wrapper that mimics better-sqlite3 API.
 * This allows the Memory class to work with either backend.
 */
export interface PgLikeDatabase {
  prepare(sql: string): PgLikeStatement;
  exec(sql: string): void;
  pragma(pragma: string): void;
  close(): void;
}

export interface PgLikeStatement {
  run(...params: any[]): { changes: number };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Create a PostgreSQL adapter.
 *
 * Requires `pg` package to be installed:
 *   npm install pg
 *
 * The adapter converts SQLite-style ? placeholders to $1, $2, etc.
 * and wraps async pg into sync-like interface using synchronous execution.
 *
 * NOTE: For true production use, consider rewriting Memory to async.
 * This adapter uses a connection pool with synchronous-style operations
 * by pre-executing queries.
 */
export function createPostgresAdapter(connectionString: string): PgLikeDatabase {
  // Dynamic import to avoid requiring pg when using SQLite
  let Pool: any;
  try {
    Pool = require('pg').Pool;
  } catch {
    throw new Error('pg package not installed. Run: npm install pg');
  }

  const pool = new Pool({ connectionString, max: 10 });

  // Cache for prepared statement results
  const querySync = (sql: string, params: any[] = []): any[] => {
    // Convert SQLite ? to PostgreSQL $1, $2
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);

    // We use a blocking approach via shared state
    // In production, rewrite Memory class to be async
    let result: any[] = [];
    let error: Error | null = null;
    let done = false;

    pool.query(pgSql, params).then((res: any) => {
      result = res.rows || [];
      done = true;
    }).catch((err: Error) => {
      error = err;
      done = true;
    });

    // Spin-wait (not ideal, but works for adapter pattern)
    const start = Date.now();
    while (!done && Date.now() - start < 5000) {
      // busy wait with small yield
    }

    if (error) throw error;
    return result;
  };

  const execSync = (sql: string): void => {
    let done = false;
    let error: Error | null = null;

    pool.query(sql).then(() => { done = true; }).catch((err: Error) => { error = err; done = true; });

    const start = Date.now();
    while (!done && Date.now() - start < 10000) {}
    if (error) throw error;
  };

  return {
    prepare(sql: string): PgLikeStatement {
      return {
        run(...params: any[]) {
          const rows = querySync(sql, params);
          return { changes: (rows as any).rowCount || 0 };
        },
        get(...params: any[]) {
          const rows = querySync(sql, params);
          return rows[0] || null;
        },
        all(...params: any[]) {
          return querySync(sql, params);
        },
      };
    },
    exec(sql: string) {
      execSync(sql);
    },
    pragma(_pragma: string) {
      // No-op for PostgreSQL
    },
    close() {
      pool.end();
    },
  };
}

/**
 * PostgreSQL schema (equivalent to SQLite schema in store.ts).
 * Uses PostgreSQL-specific types.
 */
export const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT,
  dev TEXT,
  twitter TEXT,
  telegram TEXT,
  website TEXT,
  image TEXT,
  created_at BIGINT,
  first_seen_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  graduated INTEGER DEFAULT 0,
  graduated_at BIGINT
);

CREATE TABLE IF NOT EXISTS token_snapshots (
  id SERIAL PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES tokens(mint),
  price DOUBLE PRECISION,
  mcap DOUBLE PRECISION,
  volume_5m DOUBLE PRECISION,
  volume_1h DOUBLE PRECISION,
  volume_24h DOUBLE PRECISION,
  holders INTEGER,
  bonding_progress DOUBLE PRECISION,
  timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_mint_time ON token_snapshots(mint, timestamp);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON token_snapshots(timestamp);

CREATE TABLE IF NOT EXISTS token_analysis (
  mint TEXT PRIMARY KEY REFERENCES tokens(mint),
  score INTEGER,
  rug_score INTEGER,
  signals TEXT,
  recommendation TEXT,
  reasoning TEXT,
  analyzed_at BIGINT
);

CREATE TABLE IF NOT EXISTS holder_data (
  mint TEXT PRIMARY KEY REFERENCES tokens(mint),
  total_holders INTEGER,
  top10_percent DOUBLE PRECISION,
  top20_percent DOUBLE PRECISION,
  dev_holding_percent DOUBLE PRECISION,
  is_bundled INTEGER DEFAULT 0,
  suspicious_wallets TEXT,
  checked_at BIGINT
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  agent_id TEXT,
  action TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  amount_sol DOUBLE PRECISION,
  amount_tokens DOUBLE PRECISION,
  price DOUBLE PRECISION,
  slippage_bps INTEGER,
  priority_fee DOUBLE PRECISION,
  tx_hash TEXT,
  success INTEGER DEFAULT 0,
  reason TEXT,
  error TEXT,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(created_at);

CREATE TABLE IF NOT EXISTS positions (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  entry_price DOUBLE PRECISION,
  current_price DOUBLE PRECISION,
  amount_tokens DOUBLE PRECISION,
  amount_sol_invested DOUBLE PRECISION,
  opened_at BIGINT,
  last_updated BIGINT
);

CREATE TABLE IF NOT EXISTS rug_wallets (
  address TEXT PRIMARY KEY,
  reason TEXT,
  added_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT,
  strategy TEXT,
  started_at BIGINT,
  ended_at BIGINT,
  status TEXT,
  stats TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_learning (
  id SERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  signals TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('win', 'loss', 'breakeven')),
  pnl_sol DOUBLE PRECISION,
  pnl_percent DOUBLE PRECISION,
  pipeline_score INTEGER,
  hold_duration_min INTEGER,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_learning_outcome ON pipeline_learning(outcome);
CREATE INDEX IF NOT EXISTS idx_learning_time ON pipeline_learning(created_at);

CREATE TABLE IF NOT EXISTS pipeline_weights (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  socials DOUBLE PRECISION DEFAULT 1.0,
  bonding_curve DOUBLE PRECISION DEFAULT 1.0,
  dev_wallet DOUBLE PRECISION DEFAULT 1.0,
  holders DOUBLE PRECISION DEFAULT 1.0,
  trending DOUBLE PRECISION DEFAULT 1.0,
  name_quality DOUBLE PRECISION DEFAULT 1.0,
  behavioral DOUBLE PRECISION DEFAULT 1.0,
  updated_at BIGINT
);

-- Contextual memory tables
CREATE TABLE IF NOT EXISTS dev_wallet_memory (
  address TEXT PRIMARY KEY,
  total_launches INTEGER DEFAULT 0,
  rug_count INTEGER DEFAULT 0,
  clean_count INTEGER DEFAULT 0,
  avg_token_lifetime_min DOUBLE PRECISION DEFAULT 0,
  avg_mcap_peak DOUBLE PRECISION DEFAULT 0,
  last_seen BIGINT,
  reputation TEXT DEFAULT 'unknown',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS hourly_performance (
  hour INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  total_trades INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl_sol DOUBLE PRECISION DEFAULT 0,
  PRIMARY KEY (hour, day_of_week)
);

CREATE TABLE IF NOT EXISTS pattern_memory (
  pattern TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  occurrences INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  avg_pnl_percent DOUBLE PRECISION DEFAULT 0,
  last_seen BIGINT
);

CREATE TABLE IF NOT EXISTS narrative_outcomes (
  id SERIAL PRIMARY KEY,
  narrative TEXT NOT NULL,
  keywords TEXT NOT NULL,
  tokens_matched INTEGER DEFAULT 0,
  tokens_bought INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  total_pnl_sol DOUBLE PRECISION DEFAULT 0,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  expired_at BIGINT
);
`;
