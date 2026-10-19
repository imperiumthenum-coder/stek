import { useEffect, useRef, useState } from 'react';
import { Gauge, X, TrendingUp, TrendingDown, Minus, LineChart } from 'lucide-react';

// Market Pulse: Fear & Greed-style gauges served by /api/market-pulse.

type Rating = 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';
type Point = { t: number; v: number };
type Component = {
  id: string;
  name: string;
  description: string;
  unit: '%' | 'pts';
  value: number;
  score: number;
  rating: Rating;
  history: Point[];
  detail?: Record<string, number>;
};
type Pulse =
  | { ready: false; message: string }
  | {
      ready: true;
      asOf: number;
      universe: { covered: number; total: number };
      range: string;
      ranges: string[];
      composite: { score: number; rating: Rating; history: Point[] };
      index: { symbol: string; name: string; history: Point[] };
      components: Component[];
    };

// Diverging red <-> blue with a gray midpoint; the rating text always rides along
const RATING_COLOR: Record<Rating, string> = {
  'Extreme Fear': '#d03b3b',
  Fear: '#ec835a',
  Neutral: '#9ca3af',
  Greed: '#5b9cf0',
  'Extreme Greed': '#3987e5',
};
const LINE = '#3987e5';

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// Changes get a sign; levels (like % of stocks above their average) don't
const fmtValue = (v: number, unit: '%' | 'pts', level = false) =>
  `${v >= 0 && !level ? '+' : ''}${v.toFixed(level ? 1 : 2)}${unit === '%' ? '%' : ' pts'}`;
const LEVELS = new Set(['breadth']);

function RatingBadge({ rating }: { rating: Rating }) {
  const Icon = rating.includes('Greed') ? TrendingUp : rating.includes('Fear') ? TrendingDown : Minus;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded border"
      style={{ color: RATING_COLOR[rating], borderColor: `${RATING_COLOR[rating]}66` }}
    >
      <Icon className="w-3 h-3" />
      {rating}
    </span>
  );
}

// One-series history line with a crosshair + tooltip on hover/touch
function Sparkline({ points, unit, zero = true, height = 56, range, level = false }: {
  points: Point[];
  unit: '%' | 'pts' | 'score';
  zero?: boolean;
  height?: number;
  range?: [number, number];
  level?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (points.length < 2) return <div style={{ height }} />;

  const W = 300;
  const H = height;
  const pad = 4;
  const vals = points.map((p) => p.v);
  let lo = range ? range[0] : Math.min(...vals, zero ? 0 : Infinity);
  let hi = range ? range[1] : Math.max(...vals, zero ? 0 : -Infinity);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (H - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

  const onMove = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((clientX - r.left) / r.width) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const hp = hover !== null ? points[hover] : null;
  const label = (v: number) => (unit === 'score' ? `${Math.round(v)}/100` : fmtValue(v, unit, level));

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full block touch-none cursor-crosshair"
        style={{ height: H }}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
        role="img"
        aria-label={`History from ${fmtDate(points[0].t)} to ${fmtDate(points[points.length - 1].t)}`}
      >
        {zero && lo < 0 && hi > 0 && (
          <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="#4b5563" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
        {unit === 'score' && (
          <line x1="0" x2={W} y1={y(50)} y2={y(50)} stroke="#4b5563" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
        <path d={d} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {hp && (
          <line x1={x(hover!)} x2={x(hover!)} y1="0" y2={H} stroke="#9ca3af" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {hp && (
        <>
          <div
            className="absolute w-2.5 h-2.5 rounded-full border-2 pointer-events-none"
            style={{ left: `calc(${(hover! / (points.length - 1)) * 100}% - 5px)`, top: y(hp.v) - 5, background: LINE, borderColor: '#161b26' }}
          />
          <div
            className="absolute -top-8 px-2 py-1 rounded bg-[#0b0e14] border border-[#2a2e39] text-[11px] font-mono text-white whitespace-nowrap pointer-events-none z-10"
            style={{
              left: `${(hover! / (points.length - 1)) * 100}%`,
              transform: `translateX(${hover! > points.length / 2 ? '-100%' : '0'})`,
            }}
          >
            <span className="text-slate-400">{fmtDate(hp.t)}</span> {label(hp.v)}
          </div>
        </>
      )}
    </div>
  );
}

function Meter({ score }: { score: number }) {
  return (
    <div>
      <div
        className="relative h-2.5 rounded-full"
        style={{ background: 'linear-gradient(90deg, #d03b3b 0%, #ec835a 30%, #4b5563 50%, #5b9cf0 70%, #3987e5 100%)' }}
      >
        <div
          className="absolute top-1/2 w-4 h-4 rounded-full bg-white border-2 border-[#161b26] shadow"
          style={{ left: `calc(${score}% - 8px)`, transform: 'translateY(-50%)' }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 mt-1.5">
        <span>Extreme Fear</span>
        <span>Neutral</span>
        <span>Extreme Greed</span>
      </div>
    </div>
  );
}

const RANGE_LABEL: Record<string, string> = {
  '1M': 'Past month', '6M': 'Past 6 months', '1Y': 'Past year', '5Y': 'Past 5 years', '10Y': 'Past 10 years', '25Y': 'Past 25 years',
};
const INDEX_COLOR = '#f59e0b';

// Nearest point to time t (points sorted by t)
function nearest(points: Point[], t: number) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? points[lo] : points[hi];
}

// Fear & Greed score above, a US index below: separate y-scales (never one dual-axis
// chart), one shared time axis and crosshair so you can read both on any day.
function ScoreVsIndex({ score, index, symbol, range }: { score: Point[]; index: Point[]; symbol: string; range: string }) {
  const [hoverT, setHoverT] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  if (score.length < 2) return null;

  const t0 = Math.min(score[0].t, index[0]?.t ?? Infinity);
  const t1 = Math.max(score[score.length - 1].t, index[index.length - 1]?.t ?? -Infinity);
  const W = 600;
  const pct = (t: number) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const x = (t: number) => (pct(t) / 100) * W;

  const pane = (points: Point[], H: number, lo: number, hi: number, color: string, refs: number[], log = false, overlay?: Point[]) => {
    const f = (v: number) => (log ? Math.log(v) : v);
    const y = (v: number) => 4 + (1 - (f(v) - f(lo)) / (f(hi) - f(lo) || 1)) * (H - 8);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    return { y, H, svg: (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height: H }} aria-hidden="true">
        {refs.map((r) => (
          <line key={r} x1="0" x2={W} y1={y(r)} y2={y(r)} stroke="#374151" strokeWidth="1" strokeDasharray={r === 50 ? '3 3' : undefined} vectorEffect="non-scaling-stroke" />
        ))}
        <path d={d} fill="none" stroke={color} strokeWidth={overlay ? 1.25 : 2} strokeOpacity={overlay ? 0.4 : 1} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {overlay && overlay.length > 1 && (
          <path
            d={overlay.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}
            fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
          />
        )}
        {hoverT !== null && <line x1={x(hoverT)} x2={x(hoverT)} y1="0" y2={H} stroke="#9ca3af" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
    ) };
  };

  // Over years, compounding squashes early prices on a linear scale; log shows equal % moves equally
  const logScale = ['5Y', '10Y', '25Y'].includes(range);
  // The score turns over every few weeks; over years a 3-month average shows the regimes
  const smooth = logScale
    ? score.map((p) => {
        const win = score.filter((q) => q.t <= p.t && q.t > p.t - 91 * 86_400_000);
        return { t: p.t, v: win.reduce((a, q) => a + q.v, 0) / win.length };
      })
    : undefined;
  const iv = index.map((p) => p.v);
  const iLo = Math.min(...iv);
  const iHi = Math.max(...iv);
  const [bLo, bHi] = logScale ? [iLo / 1.04, iHi * 1.04] : [iLo - (iHi - iLo) * 0.06, iHi + (iHi - iLo) * 0.06];
  const top = pane(score, 130, 0, 100, LINE, [25, 50, 75], false, smooth);
  const bottom = index.length > 1 ? pane(index, 100, bLo, bHi, INDEX_COLOR, [], logScale) : null;
  const change = index.length > 1 ? (index[index.length - 1].v / index[0].v - 1) * 100 : NaN;

  const sp = hoverT !== null ? nearest(score, hoverT) : null;
  const avgP = hoverT !== null && smooth ? nearest(smooth, hoverT) : null;
  const ip = hoverT !== null && index.length ? nearest(index, hoverT) : null;
  const onMove = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setHoverT(nearest(score, t0 + f * (t1 - t0)).t);
  };
  // A few dated ticks along the shared axis
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0));
  const long = ['5Y', '10Y', '25Y'].includes(range);
  const tickLabel = (t: number) =>
    new Date(t).toLocaleDateString(undefined, long ? { year: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <div>
      <div
        ref={ref}
        className="relative touch-none cursor-crosshair select-none"
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHoverT(null)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={() => setHoverT(null)}
        role="img"
        aria-label={`Fear and Greed score and ${symbol} price, ${RANGE_LABEL[range]?.toLowerCase()}`}
      >
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5 rounded" style={{ background: LINE, opacity: smooth ? 0.4 : 1 }} /> Fear &amp; Greed score
            {smooth && (
              <>
                <span className="inline-block w-3 h-[3px] rounded ml-2" style={{ background: LINE }} /> 3-month average
              </>
            )}
          </span>
          <span className="text-slate-500">25 fear · 50 neutral · 75 greed</span>
        </div>
        <div className="relative">
          {top.svg}
          {sp && (
            <div className="absolute w-2.5 h-2.5 rounded-full border-2 pointer-events-none"
              style={{ left: `calc(${pct(sp.t)}% - 5px)`, top: top.y(sp.v) - 5, background: LINE, borderColor: '#1e222d' }} />
          )}
        </div>
        {bottom && (
          <>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-3 mb-1">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-0.5 rounded" style={{ background: INDEX_COLOR }} /> {symbol} price
                {logScale && <span className="text-slate-500">(log scale)</span>}
              </span>
              <span className="tabular-nums text-slate-400">
                {Number.isFinite(change) && `${change >= 0 ? '+' : ''}${change.toFixed(1)}% over ${range}`}
              </span>
            </div>
            <div className="relative">
              {bottom.svg}
              {ip && (
                <div className="absolute w-2.5 h-2.5 rounded-full border-2 pointer-events-none"
                  style={{ left: `calc(${pct(ip.t)}% - 5px)`, top: bottom.y(ip.v) - 5, background: INDEX_COLOR, borderColor: '#1e222d' }} />
              )}
            </div>
          </>
        )}
        <div className="relative h-4 mt-1 text-[10px] text-slate-500">
          {ticks.map((t, i) => (
            <span key={i} className="absolute whitespace-nowrap"
              style={{ left: `${(i / 4) * 100}%`, transform: `translateX(${i === 0 ? '0' : i === 4 ? '-100%' : '-50%'})` }}>
              {tickLabel(t)}
            </span>
          ))}
        </div>

        {sp && (
          <div
            className="absolute top-5 px-2.5 py-1.5 rounded bg-[#0b0e14] border border-[#2a2e39] text-[11px] text-white whitespace-nowrap pointer-events-none z-10 space-y-0.5"
            style={{ left: `${pct(sp.t)}%`, transform: `translateX(${pct(sp.t) > 55 ? 'calc(-100% - 10px)' : '10px'})` }}
          >
            <div className="text-slate-400">{fmtDate(sp.t)}</div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: LINE }} />
              Score <span className="font-semibold tabular-nums">{Math.round(sp.v)}</span>
              <span className="text-slate-400">{scoreRating(sp.v)}</span>
            </div>
            {avgP && (
              <div className="text-slate-400 pl-3.5">
                3-mo avg <span className="text-white tabular-nums">{Math.round(avgP.v)}</span>
              </div>
            )}
            {ip && (
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: INDEX_COLOR }} />
                {symbol} <span className="font-semibold tabular-nums">${ip.v.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function scoreRating(v: number): Rating {
  if (v < 25) return 'Extreme Fear';
  if (v < 45) return 'Fear';
  if (v <= 55) return 'Neutral';
  if (v <= 75) return 'Greed';
  return 'Extreme Greed';
}

const CHART_FOR: Record<string, string> = { 'momentum-spy': 'SPY', 'momentum-qqq': 'QQQ', volatility: '^VIX' };

export default function MarketPulse({ open, onClose, onOpenChart }: {
  open: boolean;
  onClose: () => void;
  onOpenChart: (symbol: string) => void;
}) {
  const [data, setData] = useState<Pulse | null>(null);
  const [error, setError] = useState(false);
  const [range, setRange] = useState(() => {
    try {
      return localStorage.getItem('oc.pulseRange') || '1Y';
    } catch {
      return '1Y';
    }
  });
  const [loadingRange, setLoadingRange] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/market-pulse?range=${range}`)
        .then((r) => r.json())
        .then((d) => !cancelled && (setData(d), setError(false), setLoadingRange(false)))
        .catch(() => !cancelled && (setError(true), setLoadingRange(false)));
    load();
    // Refresh while open; faster while the first download is still filling in
    const t = window.setInterval(load, data && data.ready && data.universe.covered >= data.universe.total ? 300_000 : 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [open, range, data && data.ready && data.universe.covered >= data.universe.total]);

  const pickRange = (r: string) => {
    if (r === range) return;
    setLoadingRange(true);
    setRange(r);
    try {
      localStorage.setItem('oc.pulseRange', r);
    } catch {
      /* prefs just won't persist */
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex md:items-center md:justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full h-full md:h-auto md:max-h-[92vh] md:max-w-5xl md:rounded-2xl bg-[#131722] md:border border-[#2a2e39] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Market Pulse"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2e39] shrink-0">
          <div className="flex items-center gap-2 text-white font-semibold">
            <Gauge className="w-5 h-5 text-[#3987e5]" /> Market Pulse
          </div>
          <div className="flex items-center gap-3">
            {data?.ready && <span className="text-[11px] text-slate-500 hidden sm:inline">Latest session: {fmtDate(data.asOf)}</span>}
            <button onClick={onClose} className="p-1 text-slate-400 hover:text-white" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-4 md:p-5 pb-[calc(env(safe-area-inset-bottom)+16px)]">
          {error && <div className="text-sm text-rose-400">Couldn't reach the Stek backend.</div>}
          {!data && !error && <div className="text-sm text-slate-400">Loading…</div>}
          {data && !data.ready && <div className="text-sm text-slate-400">{data.message}</div>}

          {data?.ready && (
            <>
              {data.universe.covered < data.universe.total && (
                <div className="mb-4 text-xs text-amber-300 bg-amber-950/30 border border-amber-800/40 rounded px-3 py-2">
                  Downloading stock history for breadth gauges: {data.universe.covered} of {data.universe.total} stocks so far.
                  Strength and breadth fill in as it finishes.
                </div>
              )}

              {/* Composite */}
              <div className="bg-[#1e222d] border border-[#2a2e39] rounded-xl p-4 md:p-5 mb-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-[220px] flex-1 max-w-sm">
                    <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Fear &amp; Greed score</div>
                    <div className="flex items-end gap-3 mt-1">
                      <span className="text-6xl font-bold text-white leading-none tabular-nums">{data.composite.score}</span>
                      <span className="mb-1.5">
                        <RatingBadge rating={data.composite.rating} />
                      </span>
                    </div>
                    <div className="mt-4">
                      <Meter score={data.composite.score} />
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 bg-[#131722] p-1 rounded-lg border border-[#2a2e39]" role="group" aria-label="History range">
                    {(data.ranges ?? ['1M', '6M', '1Y', '5Y', '10Y', '25Y']).map((r) => (
                      <button
                        key={r}
                        onClick={() => pickRange(r)}
                        aria-pressed={range === r}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
                          range === r ? 'bg-[#2962ff] text-white' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={`mt-5 transition-opacity ${loadingRange ? 'opacity-40' : ''}`}>
                  <ScoreVsIndex score={data.composite.history} index={data.index.history} symbol={data.index.symbol} range={data.range} />
                </div>
                {['10Y', '25Y'].includes(data.range) && (
                  <p className="text-[11px] text-slate-500 mt-3">
                    Older years use the gauges that existed then (junk-bond demand starts in 2007) and today's large caps for
                    breadth, so the early score is an approximation.
                  </p>
                )}
              </div>

              {/* Components */}
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.components.map((c) => (
                  <div key={c.id} className="bg-[#1e222d] border border-[#2a2e39] rounded-xl p-4 flex flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white">{c.name}</div>
                        <div className="text-[11px] text-slate-400 leading-snug mt-0.5">{c.description}</div>
                      </div>
                      {CHART_FOR[c.id] && (
                        <button
                          onClick={() => onOpenChart(CHART_FOR[c.id])}
                          className="shrink-0 p-1 text-slate-400 hover:text-white"
                          title={`Open ${CHART_FOR[c.id]} chart`}
                          aria-label={`Open ${CHART_FOR[c.id]} chart`}
                        >
                          <LineChart className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-3">
                      <span className="text-2xl font-semibold text-white tabular-nums">{fmtValue(c.value, c.unit, LEVELS.has(c.id))}</span>
                      <RatingBadge rating={c.rating} />
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Score {c.score}/100
                      {c.id === 'strength' && c.detail && ` · today ${c.detail.newHighs} new highs, ${c.detail.newLows} new lows`}
                      {c.id === 'volatility' && c.detail && Number.isFinite(c.detail.vix) && ` · VIX ${c.detail.vix.toFixed(2)}`}
                    </div>
                    <div className="mt-auto pt-6">
                      <Sparkline points={c.history} unit={c.unit} zero={!LEVELS.has(c.id)} level={LEVELS.has(c.id)} />
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-[11px] text-slate-500 mt-4 leading-relaxed">
                Each gauge is scored by where today's reading ranks within its own past year (0 = lowest, 100 = highest; volatility
                is inverted). The Fear &amp; Greed score averages them. Breadth gauges use ~100 large-cap US stocks as a stand-in
                for the whole market. For research, not investment advice.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
