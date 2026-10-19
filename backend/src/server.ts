import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveHub, toIbContract } from './marketData';
import { HistoryStore, INTERVALS, startPrefetcher, scheduleDailyArchive } from './history';
import { openDb, getSetting, setSetting } from './db';
import { MarketPulse } from './marketPulse';

export interface ServerOptions {
  dataDir: string; // where stek.db lives
  port: number; // 0 = any free port
  host?: string;
  archiveDir?: string; // nightly CSV export target (e.g. a NAS mount)
  archiveHour?: number; // local hour for the nightly export
  staticDir?: string; // built frontend to serve (desktop app); dev uses Vite instead
}

export async function startServer(opts: ServerOptions) {
  const db = openDb(opts.dataDir);
  const history = new HistoryStore(db);
  const liveHub = new LiveHub();
  const archiveDir = opts.archiveDir || path.join(opts.dataDir, 'archive');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Charts are served from the database. A symbol's first view fetches its history;
  // after that only new bars are pulled, and only when the last sync is old enough.
  // Watchlist symbols are kept synced in the background, so they skip even that.
  app.get('/api/klines', async (req, res) => {
    const symbol = String(req.query.symbol || 'SPY').toUpperCase();
    const interval = String(req.query.interval || '1D');
    if (!INTERVALS[interval]) return res.status(400).json({ error: `unknown interval ${interval}` });
    try {
      let rows = history.read(symbol, interval);
      if (rows.length < 10 || history.needsSync(symbol, interval)) {
        await history.sync(symbol, interval);
        rows = history.read(symbol, interval);
      }
      res.json(rows);
    } catch (e) {
      console.error('klines error:', e);
      res.status(502).json({ error: 'history unavailable' });
    }
  });

  // The browser keeps the watchlist; it mirrors it here so the prefetcher knows what to keep warm
  app.put('/api/watchlist', (req, res) => {
    const symbols: string[] = Array.isArray(req.body?.symbols)
      ? req.body.symbols.filter((x: unknown) => typeof x === 'string').map((x: string) => x.toUpperCase())
      : [];
    setSetting(db, 'watchlist', symbols);
    res.json({ status: 'ok', symbols: symbols.length });
  });

  const prefetchTimer = startPrefetcher(history, () => getSetting<string[]>(db, 'watchlist', ['SPY']));
  const archiveTimer = scheduleDailyArchive(history, archiveDir, opts.archiveHour ?? 3);

  // Fear & Greed-style market gauges (momentum, new highs/lows, breadth, VIX, ...)
  const pulse = new MarketPulse(history);
  const pulseTimer = pulse.start();
  app.get('/api/market-pulse', (_req, res) => {
    try {
      res.json(pulse.compute());
    } catch (e) {
      console.error('market pulse error:', e);
      res.status(500).json({ ready: false, message: 'Could not compute market data' });
    }
  });

  app.post('/api/archive/run', async (_req, res) => {
    try {
      res.json({ dir: archiveDir, ...(await history.exportArchive(archiveDir)) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Symbol search across stocks, ETFs, mutual funds, indexes, crypto, FX and futures.
  // Proxied server-side because Yahoo doesn't allow browser (CORS) requests.
  const SEARCHABLE_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY', 'CURRENCY', 'FUTURE']);
  const searchCache = new Map<string, { at: number; results: unknown[] }>();

  app.get('/api/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const key = q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < 3600_000) return res.json(hit.results);
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=25&newsCount=0`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data: any = await r.json();
      const results = (data?.quotes || [])
        .filter((x: any) => x.symbol && SEARCHABLE_TYPES.has(x.quoteType))
        .map((x: any) => ({
          symbol: x.symbol,
          name: x.shortname || x.longname || x.symbol,
          type: x.quoteType,
          exchange: x.exchDisp || x.exchange || '',
          live: Boolean(toIbContract(x.symbol)),
        }));
      if (searchCache.size > 500) searchCache.clear();
      searchCache.set(key, { at: Date.now(), results });
      res.json(results);
    } catch (e) {
      console.error('search error:', e);
      res.status(502).json([]);
    }
  });

  app.get('/api/live/status', (_req, res) => res.json(liveHub.status()));

  // Per-symbol drawings
  app.get('/api/workspace/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const row = db.prepare('SELECT timeframe, drawings FROM workspaces WHERE symbol = ?').get(symbol) as
      | { timeframe: string; drawings: string }
      | undefined;
    res.json({ symbol, timeframe: row?.timeframe ?? '1D', drawings: row ? JSON.parse(row.drawings) : [] });
  });

  app.put('/api/workspace/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const { timeframe, drawings } = req.body;
    db.prepare(
      `INSERT INTO workspaces (symbol, timeframe, drawings, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (symbol) DO UPDATE SET
         timeframe = excluded.timeframe, drawings = excluded.drawings, updated_at = excluded.updated_at`
    ).run(symbol, timeframe || '1D', JSON.stringify(drawings || []), Date.now());
    res.json({ status: 'saved' });
  });

  // Desktop app: serve the built frontend from the same origin as the API
  if (opts.staticDir) {
    app.use(express.static(opts.staticDir));
    app.get('*', (_req, res) => res.sendFile(path.join(opts.staticDir!, 'index.html')));
  }

  // Live prices: client sends {"subscribe": "SPY"}; server pushes {"type":"tick", ...}
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    let unsubscribe: (() => void) | null = null;
    socket.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof msg.subscribe !== 'string') return;
      unsubscribe?.();
      unsubscribe = liveHub.subscribe(msg.subscribe, (tick) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tick', ...tick }));
      });
    });
    socket.on('close', () => unsubscribe?.());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    close: () => {
      clearInterval(prefetchTimer);
      clearInterval(archiveTimer);
      clearInterval(pulseTimer);
      wss.close();
      server.close();
      db.close();
    },
  };
}
