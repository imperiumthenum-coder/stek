import pg from 'pg';
import { fileURLToPath } from 'url';
import { openDb } from '../src/db';

// One-time copy from the old Postgres/TimescaleDB setup into the SQLite store.
// Usage: PG_URL=postgresql://user:pass@host:5432/db npm run migrate:postgres
const PG_URL = process.env.PG_URL;
if (!PG_URL) {
  console.error('Set PG_URL to the old database, e.g. postgresql://user:pass@127.0.0.1:5432/opencharts_ta');
  process.exit(1);
}
const dataDir = process.env.STEK_DATA_DIR || fileURLToPath(new URL('../../data', import.meta.url));

const pgClient = new pg.Client(PG_URL);
await pgClient.connect();
const db = openDb(dataDir);

const upsert = db.prepare(
  `INSERT INTO candles (symbol, interval, time, open, high, low, close, volume)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (symbol, interval, time) DO UPDATE SET
   open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`
);

const pairs = await pgClient.query('SELECT DISTINCT symbol, interval FROM ohlcv_candles ORDER BY 1, 2');
let bars = 0;
for (const { symbol, interval } of pairs.rows) {
  const r = await pgClient.query(
    `SELECT (EXTRACT(EPOCH FROM time) * 1000)::BIGINT AS t, open, high, low, close, volume
     FROM ohlcv_candles WHERE symbol = $1 AND interval = $2 ORDER BY time`,
    [symbol, interval]
  );
  db.transaction(() => {
    for (const x of r.rows) upsert.run(symbol, interval, Number(x.t), x.open, x.high, x.low, x.close, x.volume);
  })();
  bars += r.rows.length;
}

const ws = await pgClient.query('SELECT symbol, timeframe, drawings, updated_at FROM ta_workspaces');
const putWs = db.prepare(
  `INSERT INTO workspaces (symbol, timeframe, drawings, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT (symbol) DO UPDATE SET timeframe = excluded.timeframe, drawings = excluded.drawings, updated_at = excluded.updated_at`
);
for (const w of ws.rows) {
  putWs.run(w.symbol, w.timeframe, JSON.stringify(w.drawings ?? []), new Date(w.updated_at).getTime());
}

console.log(`Copied ${bars} bars in ${pairs.rows.length} series and ${ws.rows.length} drawing sets into ${dataDir}/stek.db`);
await pgClient.end();
db.close();
