/**
 * sql-compat.ts — Drop-in replacement for better-sqlite3 using sql.js (pure WASM).
 *
 * Provides the same synchronous API surface used by the codebase:
 *   db.prepare(sql).run(...params)   → { changes, lastInsertRowid }
 *   db.prepare(sql).get(...params)   → row object | undefined
 *   db.prepare(sql).all(...params)   → row object[]
 *   db.exec(sql)
 *   db.pragma(str)
 *   db.close()
 */

import initSqlJs, { Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

let SQL: SqlJsStatic | null = null;

/** Must be called once before createDatabase(). */
export async function initDatabaseEngine(): Promise<void> {
  if (SQL) return;
  SQL = await initSqlJs();
}

export function getSqlEngine(): SqlJsStatic {
  if (!SQL) throw new Error('Database engine not initialized. Call initDatabaseEngine() first.');
  return SQL;
}

// ---------------------------------------------------------------------------

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface Statement {
  run(...params: any[]): RunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export class Database {
  private _db: SqlJsDatabase;
  private _filePath: string | null;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath?: string) {
    const engine = getSqlEngine();

    if (filePath && fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      this._db = new engine.Database(buf);
    } else {
      this._db = new engine.Database();
    }
    this._filePath = filePath || null;
  }

  /** Mimic better-sqlite3 prepare().run/get/all */
  prepare(sql: string): Statement {
    const db = this._db;
    const self = this;

    return {
      run(...params: any[]): RunResult {
        const flat = flattenParams(params);
        db.run(sql, flat);
        self._scheduleSave();
        // sql.js doesn't expose changes/lastInsertRowid directly per statement,
        // but we can query them right after.
        const changesRow = db.exec('SELECT changes() as c, last_insert_rowid() as r');
        const changes = changesRow.length > 0 ? (changesRow[0].values[0]?.[0] as number) ?? 0 : 0;
        const lastId = changesRow.length > 0 ? (changesRow[0].values[0]?.[1] as number) ?? 0 : 0;
        return { changes, lastInsertRowid: lastId };
      },

      get(...params: any[]): any {
        const flat = flattenParams(params);
        const stmt = db.prepare(sql);
        stmt.bind(flat);
        if (stmt.step()) {
          const cols = stmt.getColumnNames();
          const vals = stmt.get();
          stmt.free();
          const row: any = {};
          for (let i = 0; i < cols.length; i++) {
            row[cols[i]] = vals[i];
          }
          return row;
        }
        stmt.free();
        return undefined;
      },

      all(...params: any[]): any[] {
        const flat = flattenParams(params);
        const results = db.exec(sql, flat);
        if (results.length === 0) return [];
        const cols = results[0].columns;
        return results[0].values.map(vals => {
          const row: any = {};
          for (let i = 0; i < cols.length; i++) {
            row[cols[i]] = vals[i];
          }
          return row;
        });
      },
    };
  }

  exec(sql: string): void {
    this._db.run(sql);
    this._scheduleSave();
  }

  pragma(str: string): any {
    const sql = `PRAGMA ${str}`;
    const result = this._db.exec(sql);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }
    return undefined;
  }

  close(): void {
    this._flushSave();
    this._db.close();
  }

  /** Force-save to disk now. */
  private _flushSave(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveToDisk();
  }

  /** Debounced save — writes to disk at most every 2 seconds. */
  private _scheduleSave(): void {
    if (!this._filePath) return;
    if (this._saveTimer) return; // already scheduled
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveToDisk();
    }, 2000);
  }

  private _saveToDisk(): void {
    if (!this._filePath) return;
    try {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this._filePath, buffer);
    } catch {
      // Silently ignore write errors during close/shutdown
    }
  }
}

/** Flatten args: better-sqlite3 takes .run(a, b, c) while sql.js takes arrays */
function flattenParams(params: any[]): any[] {
  if (params.length === 0) return [];
  // If single array argument, use it directly
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

// Re-export as default namespace-like for type compat: Database.Database
export default Database;
(Database as any).Database = Database;

export namespace Database {
  export type Database = InstanceType<typeof import('./sql-compat').Database>;
}
