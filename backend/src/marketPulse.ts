import { HistoryStore, Candle } from './history';

// Market Pulse: Fear & Greed-style sentiment gauges built from daily bars.
// Each component is scored 0-100 by where that day's reading sits within its own
// trailing year (percentile); the composite is the average of those scores.
// Everything is computed for every trading day back HISTORY_YEARS, so any range
// can be charted against a broad US index.

// Breadth universe: ~100 large-cap US stocks (roughly the S&P 100). A proxy for the
// whole NYSE, which would need a paid breadth feed. Edit freely; the gauges adapt.
// Note for long histories: it's today's large caps, so earlier years carry survivorship bias.
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
// The broad US index charted under the score
export const INDEX = { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF' };
// Indexes and ETFs behind the gauges
const MARKET = ['SPY', 'QQQ', '^VIX', 'TLT', 'HYG', 'IEF', INDEX.symbol];

const YEAR = 252; // trading days
const HISTORY_YEARS = 25;
const YEAR_MS = 365.25 * 86_400_000;
// Each day's score needs a trailing year of readings, which need up to a year of bars
const BACKFILL_YEARS = HISTORY_YEARS + 2;

export const RANGES: Record<string, number> = { '1M': 21, '6M': 126, '1Y': 252, '5Y': 1260, '10Y': 2520, '25Y': 6300 };
const MAX_POINTS = 420; // long ranges are thinned to keep responses small

export interface Point {
  t: number;
  v: number;
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

// Percentile of `x` within values (0-100). Ties count half, so a flat series sits at 50.
function percentile(values: ArrayLike<number>, from: number, to: number, x: number) {
  let below = 0;
  let equal = 0;
  let n = 0;
  for (let k = from; k <= to; k++) {
    const w = values[k];
    if (!Number.isFinite(w)) continue;
    n++;
    if (w < x) below++;
    else if (w === x) equal++;
  }
  return n ? ((below + equal / 2) / n) * 100 : NaN;
}

// Rolling n-bar mean; NaN unless the whole window has values (gaps don't poison later windows)
function rollingMean(v: number[], n: number) {
  const out = new Array<number>(v.length).fill(NaN);
  let sum = 0;
  let missing = 0;
  for (let i = 0; i < v.length; i++) {
    if (Number.isFinite(v[i])) sum += v[i];
    else missing++;
    if (i >= n) {
      if (Number.isFinite(v[i - n])) sum -= v[i - n];
      else missing--;
    }
    if (i >= n - 1 && missing === 0) out[i] = sum / n;
  }
  return out;
}

interface Series {
  id: string;
  name: string;
  description: string;
  unit: '%' | 'pts';
  invert: boolean;
  values: Float64Array; // reading per calendar day (NaN = not available)
  scores: Float64Array; // 0-100 percentile score per day
  detail?: Record<string, number>;
}

interface Full {
  days: number[]; // calendar (SPY sessions), ms
  first: number; // index of the first day shown in histories
  series: Series[];
  composite: Float64Array;
  index: Float64Array; // INDEX closes per day
  covered: number;
}

export class MarketPulse {
  private cache: { at: number; full: Full } | null = null;
  private syncing = false;

  constructor(private history: HistoryStore) {}

  // Keep market symbols and the breadth universe synced, and extend them back 25+ years
  start() {
    const run = async () => {
      if (this.syncing) return;
      this.syncing = true;
      const from = Date.now() - BACKFILL_YEARS * YEAR_MS;
      try {
        for (const s of [...MARKET, ...UNIVERSE]) {
          let fetched = false;
          if (this.history.needsSync(s, '1D')) {
            await this.history.sync(s, '1D', '3y');
            fetched = true;
          }
          if (await this.history.backfill(s, '1D', from)) fetched = true;
          if (fetched) {
            this.cache = null;
            await new Promise((r) => setTimeout(r, 300)); // be gentle with Yahoo
          }
        }
      } finally {
        this.syncing = false;
      }
    };
    run();
    return setInterval(run, 15 * 60_000);
  }

  private computeFull(): Full | null {
    if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.full;

    const bars = (s: string): Candle[] => this.history.read(s, '1D', 8000);
    const spy = bars('SPY');
    if (spy.length < YEAR + 125) return null;

    const showFrom = Date.now() - HISTORY_YEARS * YEAR_MS;
    // Start the calendar a year early: day one of the history needs a trailing year
    const calFrom = showFrom - 1.1 * YEAR_MS;
    const days = spy.filter((b) => b.timestamp >= calFrom).map((b) => b.timestamp);
    const dayIdx = new Map(days.map((t, i) => [dayKey(t), i]));
    const N = days.length;
    const first = Math.max(0, days.findIndex((t) => t >= showFrom));

    // Put a per-bar series onto the calendar, carrying the last value over gaps
    const onCalendar = (b: Candle[], v: number[]) => {
      const out = new Float64Array(N).fill(NaN);
      b.forEach((bar, i) => {
        const k = dayIdx.get(dayKey(bar.timestamp));
        if (k !== undefined && Number.isFinite(v[i])) out[k] = v[i];
      });
      let seen = false;
      for (let i = 0; i < N; i++) {
        if (Number.isFinite(out[i])) seen = true;
        else if (seen) out[i] = out[i - 1];
      }
      return out;
    };
    const vsSma = (s: string, n: number) => {
      const b = bars(s);
      const c = b.map((x) => x.close);
      const m = rollingMean(c, n);
      return onCalendar(b, c.map((x, i) => (x / m[i] - 1) * 100));
    };
    const ret = (s: string, n: number) => {
      const b = bars(s);
      return onCalendar(b, b.map((x, i) => (i >= n ? (x.close / b[i - n].close - 1) * 100 : NaN)));
    };
    const minus = (a: Float64Array, b: Float64Array) => a.map((x, i) => x - b[i]);

    // Breadth across the universe: new 52-week highs/lows and % above the 50-day average
    const highs = new Float64Array(N);
    const lows = new Float64Array(N);
    const counted = new Float64Array(N);
    const above50 = new Float64Array(N);
    const counted50 = new Float64Array(N);
    let covered = 0;
    for (const s of UNIVERSE) {
      const b = bars(s);
      if (b.length < 60) continue;
      if (dayKey(b[b.length - 1].timestamp) === dayKey(days[N - 1])) covered++;
      const idx = b.map((x) => dayIdx.get(dayKey(x.timestamp)));
      // Sliding max/min of the previous YEAR-1 bars via monotonic deques: O(n)
      const maxQ: number[] = [];
      const minQ: number[] = [];
      for (let i = 0; i < b.length; i++) {
        const k = idx[i];
        if (i >= YEAR - 1 && k !== undefined) {
          while (maxQ.length && maxQ[0] < i - YEAR + 1) maxQ.shift();
          while (minQ.length && minQ[0] < i - YEAR + 1) minQ.shift();
          counted[k]++;
          if (b[i].high >= b[maxQ[0]].high) highs[k]++;
          if (b[i].low <= b[minQ[0]].low) lows[k]++;
        }
        while (maxQ.length && b[maxQ[maxQ.length - 1]].high <= b[i].high) maxQ.pop();
        maxQ.push(i);
        while (minQ.length && b[minQ[minQ.length - 1]].low >= b[i].low) minQ.pop();
        minQ.push(i);
      }
      const m50 = rollingMean(b.map((x) => x.close), 50);
      b.forEach((x, i) => {
        const k = idx[i];
        if (k === undefined || !Number.isFinite(m50[i])) return;
        counted50[k]++;
        if (x.close > m50[i]) above50[k]++;
      });
    }
    const netDaily = Array.from({ length: N }, (_, i) => (counted[i] >= 20 ? ((highs[i] - lows[i]) / counted[i]) * 100 : NaN));
    // Daily net new highs is spiky; a 10-day average reads like the trend it is
    const netSmoothed = Float64Array.from(rollingMean(netDaily, 10));
    const pctAbove50 = Float64Array.from({ length: N }, (_, i) => (counted50[i] >= 20 ? (above50[i] / counted50[i]) * 100 : NaN));

    const vixBars = bars('^VIX');
    const vixClose = onCalendar(vixBars, vixBars.map((x) => x.close));
    const last = N - 1;

    const defs: Omit<Series, 'scores'>[] = [
      { id: 'momentum-spy', name: 'Market Momentum · SPY', description: 'S&P 500 ETF vs its 125-day moving average', unit: '%', invert: false, values: vsSma('SPY', 125) },
      { id: 'momentum-qqq', name: 'Market Momentum · QQQ', description: 'Nasdaq-100 ETF vs its 125-day moving average', unit: '%', invert: false, values: vsSma('QQQ', 125) },
      {
        id: 'strength',
        name: 'Stock Price Strength',
        description: `Net new 52-week highs minus lows, % of ${covered} large caps (10-day avg)`,
        unit: '%',
        invert: false,
        values: netSmoothed,
        detail: { newHighs: highs[last], newLows: lows[last], stocks: counted[last] },
      },
      { id: 'breadth', name: 'Stock Price Breadth', description: `% of ${covered} large caps above their 50-day average`, unit: '%', invert: false, values: pctAbove50 },
      {
        id: 'volatility',
        name: 'Market Volatility',
        description: 'VIX vs its 50-day moving average (higher = more fear)',
        unit: '%',
        invert: true,
        values: vsSma('^VIX', 50),
        detail: { vix: vixClose[last] },
      },
      { id: 'safe-haven', name: 'Safe Haven Demand', description: 'SPY minus TLT (Treasuries) 20-day return', unit: 'pts', invert: false, values: minus(ret('SPY', 20), ret('TLT', 20)) },
      { id: 'junk-bond', name: 'Junk Bond Demand', description: 'HYG (high yield) minus IEF (Treasuries) 20-day return', unit: 'pts', invert: false, values: minus(ret('HYG', 20), ret('IEF', 20)) },
    ];

    // Score every day against its own trailing year; average into the composite.
    // Components that didn't exist yet (e.g. HYG before 2007) just sit out those days.
    const series: Series[] = defs.map((d) => {
      const scores = new Float64Array(N).fill(NaN);
      for (let i = 0; i < N; i++) {
        const v = d.values[i];
        if (!Number.isFinite(v)) continue;
        const p = percentile(d.values, Math.max(0, i - YEAR + 1), i, v);
        scores[i] = d.invert ? 100 - p : p;
      }
      return { ...d, scores };
    });
    const composite = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      let n = 0;
      for (const s of series) {
        if (Number.isFinite(s.scores[i])) {
          sum += s.scores[i];
          n++;
        }
      }
      if (n >= 3) composite[i] = sum / n; // need a few gauges before the score means much
    }

    const idxBars = bars(INDEX.symbol);
    const index = onCalendar(idxBars, idxBars.map((x) => x.close));

    const full: Full = { days, first, series, composite, index, covered };
    this.cache = { at: Date.now(), full };
    return full;
  }

  compute(range = '1Y') {
    const full = this.computeFull();
    if (!full) return { ready: false, message: 'Downloading market data… this takes about a minute the first time.' };
    const { days, first, series, composite, index, covered } = full;
    const N = days.length;
    const last = N - 1;
    const span = RANGES[range] ?? RANGES['1Y'];
    const from = Math.max(first, N - span);
    // Thin long ranges to about MAX_POINTS, in buckets ending on the latest day.
    // Gauges are averaged per bucket (sampling a fast-moving daily series aliases
    // into noise); prices take the bucket's last close.
    const step = Math.max(1, Math.ceil((N - from) / MAX_POINTS));
    const buckets: [number, number][] = [];
    for (let end = last; end >= from; end -= step) buckets.unshift([Math.max(from, end - step + 1), end]);
    const pts = (v: ArrayLike<number>, how: 'mean' | 'last' = 'mean') =>
      buckets.flatMap(([a, b]) => {
        let sum = 0;
        let n = 0;
        let lastV = NaN;
        for (let i = a; i <= b; i++) {
          if (!Number.isFinite(v[i])) continue;
          sum += v[i];
          n++;
          lastV = v[i];
        }
        if (!n) return [];
        return [{ t: days[b], v: how === 'last' ? lastV : sum / n }];
      });

    const score = composite[last];
    return {
      ready: true,
      asOf: days[last],
      range,
      ranges: Object.keys(RANGES),
      universe: { covered, total: UNIVERSE.length },
      composite: { score: Math.round(score), rating: rating(score), history: pts(composite) },
      index: { ...INDEX, history: pts(index, 'last') },
      components: series
        .filter((s) => Number.isFinite(s.values[last]))
        .map((s) => {
          const firstValid = s.values.findIndex(Number.isFinite);
          return {
            id: s.id,
            name: s.name,
            description: s.description,
            unit: s.unit,
            value: s.values[last],
            score: Math.round(s.scores[last]),
            rating: rating(s.scores[last]),
            history: pts(s.values),
            detail: s.detail,
            since: days[Math.max(firstValid, first)],
          };
        }),
    };
  }
}
