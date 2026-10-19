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
      composite: { score: number; rating: Rating; history: Point[] };
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

const CHART_FOR: Record<string, string> = { 'momentum-spy': 'SPY', 'momentum-qqq': 'QQQ', volatility: '^VIX' };

export default function MarketPulse({ open, onClose, onOpenChart }: {
  open: boolean;
  onClose: () => void;
  onOpenChart: (symbol: string) => void;
}) {
  const [data, setData] = useState<Pulse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () =>
      fetch('/api/market-pulse')
        .then((r) => r.json())
        .then((d) => !cancelled && (setData(d), setError(false)))
        .catch(() => !cancelled && setError(true));
    load();
    // Refresh while open; faster while the first download is still filling in
    const t = window.setInterval(load, data && data.ready && data.universe.covered >= data.universe.total ? 300_000 : 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [open, data && data.ready && data.universe.covered >= data.universe.total]);

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
              <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-5 bg-[#1e222d] border border-[#2a2e39] rounded-xl p-4 md:p-5 mb-4">
                <div>
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
                <div>
                  <div className="text-[11px] text-slate-400 mb-1">Past year (50 = neutral)</div>
                  <Sparkline points={data.composite.history} unit="score" zero={false} range={[0, 100]} height={110} />
                </div>
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
