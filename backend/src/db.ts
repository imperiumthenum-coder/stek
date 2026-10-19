import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Everything Stek stores lives in one SQLite file: price bars, per-symbol drawings
// and small settings (like the watchlist the prefetcher keeps warm).
export type Db = Database.Database;

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'stek.db'));
  db.pragma('journal_mode = WAL'); // readers don't block the background sync writer
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol   TEXT    NOT NULL,
      interval TEXT    NOT NULL,
      time     INTEGER NOT NULL, -- bar start, ms since epoch
      open     REAL    NOT NULL,
      high     REAL    NOT NULL,
      low      REAL    NOT NULL,
      close    REAL    NOT NULL,
      volume   REAL    NOT NULL,
      PRIMARY KEY (symbol, interval, time)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS workspaces (
      symbol     TEXT PRIMARY KEY,
      timeframe  TEXT NOT NULL DEFAULT '1D',
      drawings   TEXT NOT NULL DEFAULT '[]', -- JSON
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL -- JSON
    );
  `);
  return db;
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(db: Db, key: string, value: unknown) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}
