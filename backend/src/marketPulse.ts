import { HistoryStore, Candle } from './history';

// Market Pulse: Fear & Greed-style sentiment gauges built from daily bars.
// Each component is scored 0-100 by where today's reading sits within its own
// past year (percentile), and the composite is the average of those scores.

// Breadth universe: ~100 large-cap US stocks (roughly the S&P 100). A proxy for the
// whole NYSE, which would need a paid breadth feed. Edit freely; the gauges adapt.
export const UNIVERSE = [
  'AAPL', 'ABBV', 'ABT', 'ACN', 'ADBE', 'AIG', 'AMD', 'AMGN', 'AMT', 'AMZN',
  'AVGO', 'AXP', 'BA', 'BAC', 'BNY', 'BKNG', 'BLK', 'BMY', 'BRK-B', 'C',
  'CAT', 'CHTR', 'CL', 'CMCSA', 'COF', 'COP', 'COST', 'CRM', 'CSCO', 'CVS',
  'CVX', 'DE', 'DHR', 'DIS', 'DUK', 'EMR', 'F', 'FDX', 'GD', 'GE',
  'GILD', 'GM', 'GOOGL', 'GS', 'HD', 'HON', 'IBM', 'INTC', 'INTU', 'ISRG',
  'JNJ', 'JPM', 'KO', 'LIN', 'LLY', 'LMT', 'LOW', 'MA', 'MCD', 'MDLZ',
  'MDT', 'MET', 'META', 'MMM', 'MO', 'MRK', 'MS', 'MSFT', 'NEE', 'NFLX',
  'NKE', 'NOW', 'NVDA', 'ORCL', 'PEP', 'PFE', 'PG', 'PLTR', 'PM', 'PYPL',
  'QCOM', 'RTX', 'SBUX', 'SCHW', 'SO', 'SPG', 'T', 'TGT', 'TMO', 'TMUS',
  'TSLA', 'TXN', 'UBER', 'UNH', 'UNP', 'UPS', 'USB', 'V', 'VZ', 'WFC',
  'WMT', 'XOM',
];
// Indexes and ETFs behind the other gauges
const MARKET = ['SPY', 'QQQ', '^VIX', 'TLT', 'HYG', 'IEF'];

const YEAR = 252; // trading days
const SYNC_RANGE = '3y'; // enough for a 1-year history of 52-week (252-day) lookbacks

export interface Point {
  t: number;
  v: number;
}
export interface Component {
  id: string;
  name: string;
  description: string;
  unit: '%' | 'pts';
  value: number; // today's reading
  score: number; // 0-100, higher = greedier
  rating: Rating;
  history: Point[]; // last ~year of readings
  detail?: Record<string, number>;
  inComposite: boolean;
}
type Rating = 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';

export function rating(score: number): Rating {
  if (score < 25) return 'Extreme Fear';
  if (score < 45) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

function sma(values: number[], i: number, n: number) {
  if (i + 1 < n) return NaN;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) sum += values[k];
  return sum / n;
}

// Percentile of `x` within `window` (0-100). Ties count half, so a flat series sits at 50.
function percentile(window: number[], x: number) {
  if (window.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const w of window) {
    if (w < x) below++;
    else if (w === x) equal++;
  }
  return ((below + equal / 2) / window.length) * 100;
}

// Map a series of dated readings onto `days`, carrying the last value over gaps
function align(series: Map<string, number>, days: string[]) {
  let last = NaN;
  return days.map((d) => {
    const v = series.get(d);
    if (v !== undefined && Number.isFinite(v)) last = v;
    return last;
  });
}

export class MarketPulse {
  private cache: { at: number; data: unknown } | null = null;
  private syncing = false;

  constructor(private history: HistoryStore) {}

  // Keep the market symbols and the breadth universe synced (daily bars only)
  start() {
    const run = async () => {
      if (this.syncing) return;
      this.syncing = true;
      try {
        for (const s of [...MARKET, ...UNIVERSE]) {
          if (!this.history.needsSync(s, '1D')) continue;
          await this.history.sync(s, '1D', SYNC_RANGE);
          await new Promise((r) => setTimeout(r, 300)); // be gentle with Yahoo
        }
        this.cache = null;
      } finally {
        this.syncing = false;
      }
    };
    run();
    return setInterval(run, 15 * 60_000);
  }

  compute() {
    if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.data;

    const bars = (s: string): Candle[] => this.history.read(s, '1D', YEAR * 3);
    const spy = bars('SPY');
    if (spy.length < YEAR + 125) {
      return { ready: false, message: 'Downloading market data… this takes about a minute the first time.' };
    }
    // Trading calendar: SPY's last year of sessions
    const days = spy.slice(-YEAR * 2).map((b) => dayKey(b.timestamp));
    const shown = days.slice(-YEAR);

    const closeSeries = (s: string) => new Map(bars(s).map((b) => [dayKey(b.timestamp), b.close]));

    // % above/below an n-day moving average
    const vsSma = (s: string, n: number) => {
      const b = bars(s);
      const closes = b.map((x) => x.close);
      return new Map(b.map((x, i) => [dayKey(x.timestamp), (closes[i] / sma(closes, i, n) - 1) * 100]));
    };
    // n-day % return
    const ret = (s: string, n: number) => {
      const b = bars(s);
      return new Map(b.map((x, i) => [dayKey(x.timestamp), i >= n ? (x.close / b[i - n].close - 1) * 100 : NaN]));
    };
    const diff = (a: Map<string, number>, b: Map<string, number>) => {
      const out = new Map<string, number>();
      a.forEach((v, k) => {
        const w = b.get(k);
        if (w !== undefined) out.set(k, v - w);
      });
      return out;
    };

    // Breadth across the universe: net new 52-week highs/lows and % above 50-day average
    const highs = new Map<string, number>();
    const lows = new Map<string, number>();
    const counted = new Map<string, number>();
    const above50 = new Map<string, number>();
    const counted50 = new Map<string, number>();
    let covered = 0;
    for (const s of UNIVERSE) {
      const b = bars(s);
      if (b.length < YEAR + 20) continue;
      covered++;
      const closes = b.map((x) => x.close);
      for (let i = YEAR - 1; i < b.length; i++) {
        const k = dayKey(b[i].timestamp);
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - YEAR + 1; j < i; j++) {
          if (b[j].high > hi) hi = b[j].high;
          if (b[j].low < lo) lo = b[j].low;
        }
        counted.set(k, (counted.get(k) ?? 0) + 1);
        if (b[i].high >= hi) highs.set(k, (highs.get(k) ?? 0) + 1);
        if (b[i].low <= lo) lows.set(k, (lows.get(k) ?? 0) + 1);
      }
      for (let i = 49; i < b.length; i++) {
        const k = dayKey(b[i].timestamp);
        counted50.set(k, (counted50.get(k) ?? 0) + 1);
        if (closes[i] > sma(closes, i, 50)) above50.set(k, (above50.get(k) ?? 0) + 1);
      }
    }
    // Daily net new highs is spiky; a 10-day average reads like the trend it is
    const netDaily = days.map((d) => {
      const n = counted.get(d) ?? 0;
      return n ? (((highs.get(d) ?? 0) - (lows.get(d) ?? 0)) / n) * 100 : NaN;
    });
    const netSmoothed = new Map(days.map((d, i) => [d, sma(netDaily, i, 10)]));
    const pctAbove50 = new Map(days.map((d) => {
      const n = counted50.get(d) ?? 0;
      return [d, n ? ((above50.get(d) ?? 0) / n) * 100 : NaN];
    }));

    const today = days[days.length - 1];
    const build = (
      id: string,
      name: string,
      description: string,
      unit: '%' | 'pts',
      series: Map<string, number>,
      opts: { invert?: boolean; inComposite?: boolean; detail?: Record<string, number> } = {}
    ): Component | null => {
      const all = align(series, days);
      const value = all[all.length - 1];
      if (!Number.isFinite(value)) return null;
      const past = all.slice(-YEAR).filter(Number.isFinite);
      let score = percentile(past, value);
      if (opts.invert) score = 100 - score;
      return {
        id,
        name,
        description,
        unit,
        value,
        score: Math.round(score),
        rating: rating(score),
        history: shown
          .map((d, i) => ({ t: Date.parse(d), v: all[days.length - YEAR + i] }))
          .filter((p) => Number.isFinite(p.v)),
        detail: opts.detail,
        inComposite: opts.inComposite ?? true,
      };
    };

    const sources = {
      momSpy: vsSma('SPY', 125),
      momQqq: vsSma('QQQ', 125),
      vix: vsSma('^VIX', 50),
      safeHaven: diff(ret('SPY', 20), ret('TLT', 20)),
      junkBond: diff(ret('HYG', 20), ret('IEF', 20)),
    };
    const specs: [string, string, string, '%' | 'pts', Map<string, number>, Parameters<typeof build>[5]?][] = [
      ['momentum-spy', 'Market Momentum · SPY', 'S&P 500 ETF vs its 125-day moving average', '%', sources.momSpy],
      ['momentum-qqq', 'Market Momentum · QQQ', 'Nasdaq-100 ETF vs its 125-day moving average', '%', sources.momQqq],
      [
        'strength',
        'Stock Price Strength',
        `Net new 52-week highs minus lows, % of ${covered} large caps (10-day avg)`,
        '%',
        netSmoothed,
        { detail: { newHighs: highs.get(today) ?? 0, newLows: lows.get(today) ?? 0, stocks: counted.get(today) ?? 0 } },
      ],
      ['breadth', 'Stock Price Breadth', `% of ${covered} large caps above their 50-day average`, '%', pctAbove50],
      [
        'volatility',
        'Market Volatility',
        'VIX vs its 50-day moving average (higher = more fear)',
        '%',
        sources.vix,
        { invert: true, detail: { vix: closeSeries('^VIX').get(today) ?? NaN } },
      ],
      ['safe-haven', 'Safe Haven Demand', 'SPY minus TLT (Treasuries) 20-day return', 'pts', sources.safeHaven],
      ['junk-bond', 'Junk Bond Demand', 'HYG (high yield) minus IEF (Treasuries) 20-day return', 'pts', sources.junkBond],
    ];
    const built = specs
      .map(([id, name, desc, unit, series, opts]) => ({ c: build(id, name, desc, unit, series, opts), series, invert: !!opts?.invert }))
      .filter((x): x is { c: Component; series: Map<string, number>; invert: boolean } => x.c !== null);
    const components = built.map((x) => x.c);

    // Composite history: each day, average every component's percentile within its trailing year
    const scored = built.filter((x) => x.c.inComposite).map((x) => ({ ...x, aligned: align(x.series, days) }));
    const compositeHistory: Point[] = [];
    for (let i = days.length - YEAR; i < days.length; i++) {
      const scores: number[] = [];
      for (const x of scored) {
        const v = x.aligned[i];
        if (!Number.isFinite(v)) continue;
        const p = percentile(x.aligned.slice(Math.max(0, i - YEAR + 1), i + 1).filter(Number.isFinite), v);
        scores.push(x.invert ? 100 - p : p);
      }
      if (scores.length) compositeHistory.push({ t: Date.parse(days[i]), v: scores.reduce((a, b) => a + b, 0) / scores.length });
    }
    const compositeScore = scored.reduce((a, x) => a + x.c.score, 0) / (scored.length || 1);

    const data = {
      ready: true,
      asOf: Date.parse(today),
      universe: { covered, total: UNIVERSE.length },
      composite: {
        score: Math.round(compositeScore),
        rating: rating(compositeScore),
        history: compositeHistory,
      },
      components,
    };
    this.cache = { at: Date.now(), data };
    return data;
  }
}
