import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { Db } from './db';

// Price history: Yahoo is the source, the SQLite candles table is the store we serve from.
// Charts read straight from the DB; syncs only fetch bars newer than what's stored.

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface IntervalCfg {
  yahoo: string; // Yahoo's interval name
  initial: string; // range for a symbol's first fetch ('all' = everything Yahoo has)
  periodMs: number; // bar length; months use 31d as an upper bound
  syncEveryMs: number; // minimum time between Yahoo syncs for one symbol
}

export const INTERVALS: Record<string, IntervalCfg> = {
  '1m': { yahoo: '1m', initial: '7d', periodMs: 60_000, syncEveryMs: 60_000 },
  '5m': { yahoo: '5m', initial: '60d', periodMs: 300_000, syncEveryMs: 2 * 60_000 },
  '15m': { yahoo: '15m', initial: '60d', periodMs: 900_000, syncEveryMs: 5 * 60_000 },
  '30m': { yahoo: '30m', initial: '60d', periodMs: 1_800_000, syncEveryMs: 10 * 60_000 },
  '1h': { yahoo: '1h', initial: '730d', periodMs: 3_600_000, syncEveryMs: 10 * 60_000 },
  '1D': { yahoo: '1d', initial: 'all', periodMs: 86_400_000, syncEveryMs: 10 * 60_000 },
  '1wk': { yahoo: '1wk', initial: 'all', periodMs: 604_800_000, syncEveryMs: 60 * 60_000 },
  '1mo': { yahoo: '1mo', initial: 'all', periodMs: 31 * 86_400_000, syncEveryMs: 6 * 3600_000 },
};
export const MAX_BARS = 5000;

const sameMonth = (a: number, b: number) => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth();
};

// Yahoo tends to (a) repeat the current period as an extra bar stamped "now" and
// (b) stamp the forming bar with "now" instead of the period start. Fix both so the
// forming bar has a stable key and upserts in place as it updates.
function normalizeTail(candles: Candle[], interval: string) {
  if (candles.length < 2) return;
  const len = INTERVALS[interval].periodMs;
  const prev = candles[candles.length - 2];
  const last = candles[candles.length - 1];
  const samePeriod = interval === '1mo' ? sameMonth(prev.timestamp, last.timestamp) : last.timestamp - prev.timestamp < len;
  if (samePeriod) {
    prev.high = Math.max(prev.high, last.high);
    prev.low = Math.min(prev.low, last.low);
    prev.close = last.close;
    prev.volume = Math.max(prev.volume, last.volume);
    candles.pop();
    return;
  }
  if (interval === '1mo') {
    const d = new Date(prev.timestamp);
    const l = new Date(last.timestamp);
    d.setUTCMonth(d.getUTCMonth() + (l.getUTCFullYear() - d.getUTCFullYear()) * 12 + (l.getUTCMonth() - d.getUTCMonth()));
    last.timestamp = d.getTime();
  } else {
    last.timestamp = prev.timestamp + Math.floor((last.timestamp - prev.timestamp) / len) * len;
  }
}

export class RateLimitedError extends Error {}

// Fetch bars. With `toMs` (a past window) Yahoo still appends its latest bar, so that's
// clipped off; the forming-bar fix only applies to windows that run up to now.
async function fetchYahoo(symbol: string, interval: string, span: string, toMs?: number): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${span}&interval=${INTERVALS[interval].yahoo}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (res.status === 429) throw new RateLimitedError('Yahoo rate limit');
  const json: any = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.timestamp) return [];
  const quote = result.indicators.quote[0];
  const candles: Candle[] = [];
  result.timestamp.forEach((t: number, i: number) => {
    if (quote.open[i] == null || quote.close[i] == null) return;
    // Full precision: sub-penny assets (SHIB, FX pairs) collapse to 0 if rounded
    candles.push({
      timestamp: t * 1000,
      open: quote.open[i],
      high: quote.high[i],
      low: quote.low[i],
      close: quote.close[i],
      volume: Number(quote.volume[i] || 0),
    });
  });
  if (toMs !== undefined) return candles.filter((c) => c.timestamp <= toMs);
  normalizeTail(candles, interval);
  return candles;
}

// range=max makes Yahoo downsample (daily -> quarterly); explicit periods keep full resolution
const periodSpan = (fromMs: number, toMs = Date.now()) =>
  `period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(toMs / 1000)}`;

export class HistoryStore {
  private lastSync = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private pausedUntil = 0; // set when Yahoo rate-limits us
  private backfilled = new Set<string>(); // 1m backfill attempted this run

  private q: Record<string, import('better-sqlite3').Statement>;

  constructor(private db: Db) {
    this.q = {
      // Newest first, then flip, so long histories show the recent end
      read: db.prepare(
        `SELECT time AS timestamp, open, high, low, close, volume FROM candles
         WHERE symbol = ? AND interval = ? ORDER BY time DESC LIMIT ?`
      ),
      newest: db.prepare('SELECT max(time) AS t FROM candles WHERE symbol = ? AND interval = ?'),
      oldest: db.prepare('SELECT min(time) AS t FROM candles WHERE symbol = ? AND interval = ?'),
      timesIn: db.prepare('SELECT time FROM candles WHERE symbol = ? AND interval = ? AND time BETWEEN ? AND ?'),
      del: db.prepare('DELETE FROM candles WHERE symbol = ? AND interval = ? AND time = ?'),
      upsert: db.prepare(
        `INSERT INTO candles (symbol, interval, time, open, high, low, close, volume)
         VALUES (@symbol, @interval, @timestamp, @open, @high, @low, @close, @volume)
         ON CONFLICT (symbol, interval, time) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`
      ),
      pairs: db.prepare('SELECT DISTINCT symbol, interval FROM candles ORDER BY 1, 2'),
      series: db.prepare('SELECT time, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = ? ORDER BY time'),
    };
  }

  read(symbol: string, interval: string, limit = MAX_BARS): Candle[] {
    return (this.q.read.all(symbol, interval, limit) as Candle[]).reverse();
  }

  // Upsert bars. Yahoo's answer is complete for the window it covers, so stored bars
  // inside that window that it didn't return are stale (e.g. a forming bar stamped at
  // a different time, or a daily bar that moved an hour across a DST change) and go.
  private store(symbol: string, interval: string, candles: Candle[], window?: { from: number; to: number }) {
    if (candles.length === 0) return;
    const ts = new Set(candles.map((c) => c.timestamp));
    // Never prune outside what we asked for, even if Yahoo's answer reaches further
    const lo = Math.max(candles[0].timestamp, window?.from ?? -Infinity);
    const hi = Math.min(candles[candles.length - 1].timestamp, window?.to ?? Infinity);
    this.db.transaction(() => {
      for (const { time } of this.q.timesIn.all(symbol, interval, lo, hi) as { time: number }[]) {
        if (!ts.has(time)) this.q.del.run(symbol, interval, time);
      }
      for (const c of candles) this.q.upsert.run({ symbol, interval, ...c });
    })();
  }

  needsSync(symbol: string, interval: string) {
    const last = this.lastSync.get(`${symbol}:${interval}`) ?? 0;
    return Date.now() - last >= INTERVALS[interval].syncEveryMs;
  }

  // Bring stored history up to date. Only fetches bars since the newest stored one
  // (plus a few periods of overlap so the forming bar gets its final values).
  // `initialRange` limits a symbol's first fetch (e.g. '3y' instead of all history)
  sync(symbol: string, interval: string, initialRange?: string): Promise<void> {
    const key = `${symbol}:${interval}`;
    const running = this.inflight.get(key);
    if (running) return running;
    if (Date.now() < this.pausedUntil) return Promise.resolve();

    const job = (async () => {
      const cfg = INTERVALS[interval];
      const newestTs = (this.q.newest.get(symbol, interval) as { t: number | null }).t ?? 0;
      let span: string;
      if (!newestTs) {
        const initial = initialRange ?? cfg.initial;
        span = initial === 'all' ? periodSpan(0) : `range=${initial}`;
      } else {
        span = periodSpan(newestTs - 6 * cfg.periodMs);
      }
      try {
        this.store(symbol, interval, await fetchYahoo(symbol, interval, span));
        this.lastSync.set(key, Date.now());
        if (interval === '1m' && !this.backfilled.has(symbol)) {
          this.backfilled.add(symbol);
          this.backfill1m(symbol).catch((e) => console.warn(`[history] 1m backfill ${symbol}:`, e.message));
        }
      } catch (e) {
        if (e instanceof RateLimitedError) {
          this.pausedUntil = Date.now() + 5 * 60_000;
          console.warn('[history] Yahoo rate limit hit; pausing syncs for 5 minutes');
        } else {
          console.warn(`[history] sync ${key} failed:`, (e as Error).message);
        }
      }
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, job);
    return job;
  }

  // Yahoo only serves 1m bars in ≤7-day windows going back ~30 days. Pull the older
  // windows once; after that, stored history keeps growing past Yahoo's limit.
  private async backfill1m(symbol: string) {
    const day = 86_400_000;
    const oldest = (this.q.oldest.get(symbol, '1m') as { t: number | null }).t ?? Date.now();
    if (oldest < Date.now() - 25 * day) return; // already deep enough
    for (let back = 7; back < 28; back += 7) {
      const to = Date.now() - back * day;
      const from = Math.max(to - 7 * day, Date.now() - 29 * day);
      this.store(symbol, '1m', await fetchYahoo(symbol, '1m', periodSpan(from, to), to), { from, to });
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Write every stored series to gzip CSVs: <dir>/<interval>/<symbol>.csv.gz.
  // Each file holds the full history, so the latest export is a complete copy.
  async exportArchive(dir: string) {
    const pairs = this.q.pairs.all() as { symbol: string; interval: string }[];
    let rows = 0;
    for (const { symbol, interval } of pairs) {
      const series = this.q.series.all(symbol, interval) as { time: number; open: number; high: number; low: number; close: number; volume: number }[];
      const csv =
        'timestamp_ms,open,high,low,close,volume\n' +
        series.map((x) => `${x.time},${x.open},${x.high},${x.low},${x.close},${x.volume}`).join('\n') +
        '\n';
      const out = path.join(dir, interval, `${symbol.replace(/[^A-Za-z0-9._=^-]/g, '_')}.csv.gz`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // Write then rename so a crash never leaves a half-written archive file
      fs.writeFileSync(out + '.tmp', zlib.gzipSync(csv));
      fs.renameSync(out + '.tmp', out);
      rows += series.length;
      await new Promise((r) => setImmediate(r)); // let requests through between series
    }
    return { series: pairs.length, rows };
  }
}

// Keeps watchlist symbols synced on every timeframe so they open instantly
export function startPrefetcher(store: HistoryStore, getSymbols: () => string[]) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const symbol of getSymbols()) {
        for (const interval of Object.keys(INTERVALS)) {
          if (!store.needsSync(symbol, interval)) continue;
          await store.sync(symbol, interval);
          await new Promise((r) => setTimeout(r, 250)); // be gentle with Yahoo
        }
      }
    } catch (e) {
      console.warn('[prefetch]', (e as Error).message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, 30_000);
}

// Run the archive export once a day at the given local hour
export function scheduleDailyArchive(store: HistoryStore, dir: string, hour: number) {
  let lastRunDay = '';
  const check = async () => {
    const now = new Date();
    const day = now.toDateString();
    if (now.getHours() !== hour || day === lastRunDay) return;
    lastRunDay = day;
    try {
      const r = await store.exportArchive(dir);
      console.log(`[archive] exported ${r.series} series / ${r.rows} bars to ${dir}`);
    } catch (e) {
      console.error('[archive] export failed:', (e as Error).message);
    }
  };
  return setInterval(check, 5 * 60_000);
}
