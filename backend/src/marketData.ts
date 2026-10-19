import { IBApi, EventName, SecType, Contract } from '@stoqey/ib';

// Live price feed. Prefers IB Gateway / TWS (TWS socket API) when it's running;
// otherwise polls Yahoo. Consumers get one tick stream per symbol regardless of source.

export type LiveSource = 'ibkr' | 'ibkr-delayed' | 'yahoo-poll';
export interface LiveTick {
  symbol: string;
  price: number;
  volume: number; // volume traded since the previous tick (not cumulative)
  time: number; // ms epoch
  source: LiveSource;
}
type Listener = (tick: LiveTick) => void;

const IB_HOST = process.env.IB_HOST || '127.0.0.1';
const IB_PORT = Number(process.env.IB_PORT || 4001); // 4001 = IB Gateway live, 4002 = paper, 7496 = TWS
const IB_CLIENT_ID = Number(process.env.IB_CLIENT_ID || 17);
const YAHOO_POLL_MS = Number(process.env.YAHOO_POLL_MS || 5000);

// Tick types from the TWS API (live and delayed variants)
const TICK = { BID: 1, ASK: 2, LAST: 4, VOLUME: 8, DELAYED_BID: 66, DELAYED_ASK: 67, DELAYED_LAST: 68, DELAYED_VOLUME: 74 };

// Crypto that IBKR trades through PAXOS
const PAXOS_COINS = new Set(['BTC', 'ETH', 'LTC', 'BCH']);

// Map a Yahoo-style symbol to an IBKR contract. Returns null for things we
// don't stream from IBKR (mutual funds, futures, non-US listings, indexes) so
// they fall back to Yahoo.
export function toIbContract(symbol: string): Contract | null {
  const s = symbol.toUpperCase();
  const crypto = s.match(/^([A-Z]+)-USD$/);
  if (crypto && PAXOS_COINS.has(crypto[1])) {
    return { symbol: crypto[1], secType: SecType.CRYPTO, exchange: 'PAXOS', currency: 'USD' };
  }
  const fx = s.match(/^([A-Z]{3})([A-Z]{3})=X$/);
  if (fx) return { symbol: fx[1], secType: SecType.CASH, exchange: 'IDEALPRO', currency: fx[2] };
  // US mutual funds: 5 letters ending in X. NAV prices once a day; nothing to stream.
  if (/^[A-Z]{4}X$/.test(s)) return null;
  // US stocks / ETFs, incl. share classes (Yahoo BRK-B -> IBKR "BRK B")
  if (/^[A-Z]{1,5}(-[A-Z])?$/.test(s)) {
    return { symbol: s.replace('-', ' '), secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
  }
  return null;
}

interface Feed {
  listeners: Set<Listener>;
  stop: () => void;
}

class IbConnection {
  readonly api = new IBApi({ host: IB_HOST, port: IB_PORT });
  connected = false;
  private nextReqId = 1000;
  private handlers = new Map<number, (field: number, value: number) => void>();
  private failures = new Map<number, (msg: string) => void>();
  private onStatusChange: () => void;

  constructor(onStatusChange: () => void) {
    this.onStatusChange = onStatusChange;
    this.api.on(EventName.connected, () => {
      this.connected = true;
      // 3 = delayed if not subscribed, but live data still comes through when the account has it
      this.api.reqMarketDataType(3);
      console.log(`[ibkr] connected to ${IB_HOST}:${IB_PORT}`);
      this.onStatusChange();
    });
    this.api.on(EventName.disconnected, () => {
      if (this.connected) console.log('[ibkr] disconnected');
      this.connected = false;
      this.onStatusChange();
    });
    this.api.on(EventName.tickPrice, (reqId: number, field: number, value: number) => {
      this.handlers.get(reqId)?.(field, value);
    });
    this.api.on(EventName.tickSize, (reqId: number, field: number, value: any) => {
      this.handlers.get(reqId)?.(field, Number(value));
    });
    this.api.on(EventName.error, (err: Error, code: number, reqId: number) => {
      // 2104/2106/2158 etc. are "data farm OK" notices, not errors
      if (code >= 2100 && code < 2200) return;
      if (reqId > 0 && this.failures.has(reqId)) {
        this.failures.get(reqId)!(`${code}: ${err.message}`);
        return;
      }
      if (!this.connected) return; // connection refused while gateway is down; retried below
      console.warn(`[ibkr] ${code}: ${err.message}`);
    });
    this.tryConnect();
    setInterval(() => this.tryConnect(), 15000);
  }

  private tryConnect() {
    if (this.connected) return;
    try {
      this.api.connect(IB_CLIENT_ID);
    } catch {
      /* gateway not running */
    }
  }

  subscribe(contract: Contract, onTick: (field: number, value: number) => void, onFail: (msg: string) => void) {
    const reqId = this.nextReqId++;
    this.handlers.set(reqId, onTick);
    this.failures.set(reqId, onFail);
    this.api.reqMktData(reqId, contract, '', false, false);
    return () => {
      this.handlers.delete(reqId);
      this.failures.delete(reqId);
      if (this.connected) this.api.cancelMktData(reqId);
    };
  }
}

export class LiveHub {
  private feeds = new Map<string, Feed>();
  private ib: IbConnection;

  constructor() {
    // When the gateway comes or goes, rebuild feeds so they move to the best source
    this.ib = new IbConnection(() => this.restartAll());
  }

  status() {
    return { ibkr: this.ib.connected, host: IB_HOST, port: IB_PORT, symbols: [...this.feeds.keys()] };
  }

  subscribe(symbol: string, listener: Listener): () => void {
    const key = symbol.toUpperCase();
    let feed = this.feeds.get(key);
    if (!feed) {
      feed = { listeners: new Set(), stop: () => {} };
      this.feeds.set(key, feed);
      feed.stop = this.startFeed(key, feed);
    }
    feed.listeners.add(listener);
    return () => {
      const f = this.feeds.get(key);
      if (!f) return;
      f.listeners.delete(listener);
      if (f.listeners.size === 0) {
        f.stop();
        this.feeds.delete(key);
      }
    };
  }

  private restartAll() {
    this.feeds.forEach((feed, key) => {
      feed.stop();
      feed.stop = this.startFeed(key, feed);
    });
  }

  private emit(feed: Feed, tick: LiveTick) {
    feed.listeners.forEach((l) => l(tick));
  }

  private startFeed(symbol: string, feed: Feed): () => void {
    const contract = toIbContract(symbol);
    if (contract && this.ib.connected) {
      let stopped = false;
      let fallbackStop: (() => void) | null = null;
      let lastCumVol: number | null = null;
      let pendingVol = 0;
      let bid = 0;
      let ask = 0;
      const unsubscribe = this.ib.subscribe(
        contract,
        (field, value) => {
          if (stopped || !(value > 0)) return;
          const delayed = field >= 66;
          const source: LiveSource = delayed ? 'ibkr-delayed' : 'ibkr';
          switch (field) {
            case TICK.VOLUME:
            case TICK.DELAYED_VOLUME:
              if (lastCumVol !== null && value > lastCumVol) pendingVol += value - lastCumVol;
              lastCumVol = value;
              return;
            case TICK.BID:
            case TICK.DELAYED_BID:
              bid = value;
              break;
            case TICK.ASK:
            case TICK.DELAYED_ASK:
              ask = value;
              break;
            case TICK.LAST:
            case TICK.DELAYED_LAST:
              this.emit(feed, { symbol, price: value, volume: pendingVol, time: Date.now(), source });
              pendingVol = 0;
              return;
            default:
              return;
          }
          // Crypto on PAXOS and FX on IDEALPRO quote but rarely print LAST; chart the midpoint
          if ((contract.secType === SecType.CASH || contract.secType === SecType.CRYPTO) && bid > 0 && ask > 0) {
            this.emit(feed, { symbol, price: (bid + ask) / 2, volume: 0, time: Date.now(), source });
          }
        },
        (msg) => {
          console.warn(`[ibkr] ${symbol} unavailable (${msg}); falling back to Yahoo`);
          if (!stopped && !fallbackStop) fallbackStop = this.startYahooPoll(symbol, feed);
        }
      );
      return () => {
        stopped = true;
        unsubscribe();
        fallbackStop?.();
      };
    }
    return this.startYahooPoll(symbol, feed);
  }

  private startYahooPoll(symbol: string, feed: Feed): () => void {
    let lastCumVol: number | null = null;
    let lastPrice: number | null = null;
    let lastDay = '';
    const poll = async () => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const meta = (await res.json())?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        if (typeof price !== 'number') return;
        const time = (meta.regularMarketTime ?? Date.now() / 1000) * 1000;
        const cumVol = Number(meta.regularMarketVolume ?? 0);
        // Cumulative volume resets each session
        const day = new Date(time).toISOString().slice(0, 10);
        if (day !== lastDay) {
          lastCumVol = null;
          lastDay = day;
        }
        const volume = lastCumVol !== null && cumVol > lastCumVol ? cumVol - lastCumVol : 0;
        lastCumVol = cumVol;
        if (price === lastPrice && volume === 0) return;
        lastPrice = price;
        this.emit(feed, { symbol, price, volume, time, source: 'yahoo-poll' });
      } catch {
        /* transient network error; next poll retries */
      }
    };
    poll();
    const timer = setInterval(poll, YAHOO_POLL_MS);
    return () => clearInterval(timer);
  }
}
