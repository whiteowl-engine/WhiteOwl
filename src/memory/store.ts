import { Database } from './sql-compat';
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA = `
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
  created_at INTEGER,
  first_seen_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  graduated INTEGER DEFAULT 0,
  graduated_at INTEGER
);

CREATE TABLE IF NOT EXISTS token_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  price REAL,
  mcap REAL,
  volume_5m REAL,
  volume_1h REAL,
  volume_24h REAL,
  holders INTEGER,
  bonding_progress REAL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_mint_time ON token_snapshots(mint, timestamp);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON token_snapshots(timestamp);

CREATE TABLE IF NOT EXISTS token_analysis (
  mint TEXT PRIMARY KEY,
  score INTEGER,
  rug_score INTEGER,
  signals TEXT,
  recommendation TEXT,
  reasoning TEXT,
  analyzed_at INTEGER,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE TABLE IF NOT EXISTS holder_data (
  mint TEXT PRIMARY KEY,
  total_holders INTEGER,
  top10_percent REAL,
  top20_percent REAL,
  dev_holding_percent REAL,
  is_bundled INTEGER DEFAULT 0,
  suspicious_wallets TEXT,
  checked_at INTEGER,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  agent_id TEXT,
  action TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  amount_sol REAL,
  amount_tokens REAL,
  price REAL,
  slippage_bps INTEGER,
  priority_fee REAL,
  tx_hash TEXT,
  success INTEGER DEFAULT 0,
  reason TEXT,
  error TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(created_at);

CREATE TABLE IF NOT EXISTS positions (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  entry_price REAL,
  current_price REAL,
  amount_tokens REAL,
  amount_sol_invested REAL,
  opened_at INTEGER,
  last_updated INTEGER
);

CREATE TABLE IF NOT EXISTS rug_wallets (
  address TEXT PRIMARY KEY,
  reason TEXT,
  added_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS token_patterns (
  mint TEXT PRIMARY KEY,
  dev TEXT,
  name TEXT,
  symbol TEXT,
  description_words TEXT,
  twitter_handle TEXT,
  telegram_handle TEXT,
  website_domain TEXT,
  website_content_hash TEXT,
  name_pattern TEXT,
  narrative_tags TEXT,
  score INTEGER,
  rug_score INTEGER,
  outcome TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_patterns_dev ON token_patterns(dev);
CREATE INDEX IF NOT EXISTS idx_patterns_twitter ON token_patterns(twitter_handle);
CREATE INDEX IF NOT EXISTS idx_patterns_telegram ON token_patterns(telegram_handle);
CREATE INDEX IF NOT EXISTS idx_patterns_website ON token_patterns(website_domain);
CREATE INDEX IF NOT EXISTS idx_patterns_name_pattern ON token_patterns(name_pattern);
CREATE INDEX IF NOT EXISTS idx_patterns_content_hash ON token_patterns(website_content_hash);
CREATE INDEX IF NOT EXISTS idx_patterns_time ON token_patterns(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT,
  strategy TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  status TEXT,
  stats TEXT
);

CREATE TABLE IF NOT EXISTS pipeline_learning (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  signals TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('win', 'loss', 'breakeven')),
  pnl_sol REAL,
  pnl_percent REAL,
  pipeline_score INTEGER,
  hold_duration_min INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_learning_outcome ON pipeline_learning(outcome);
CREATE INDEX IF NOT EXISTS idx_learning_time ON pipeline_learning(created_at);

CREATE TABLE IF NOT EXISTS pipeline_weights (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  socials REAL DEFAULT 1.0,
  bonding_curve REAL DEFAULT 1.0,
  dev_wallet REAL DEFAULT 1.0,
  holders REAL DEFAULT 1.0,
  trending REAL DEFAULT 1.0,
  name_quality REAL DEFAULT 1.0,
  behavioral REAL DEFAULT 1.0,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS ai_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  subject TEXT,
  content TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ai_memory_category ON ai_memory(category);
CREATE INDEX IF NOT EXISTS idx_ai_memory_subject ON ai_memory(subject);
CREATE INDEX IF NOT EXISTS idx_ai_memory_time ON ai_memory(created_at);
`;

export function createDatabase(dbPath: string): Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);

  return db;
}
