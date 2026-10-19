import React, { useEffect, useRef, useState } from 'react';
import { init, dispose, Chart } from 'klinecharts';
import {
  TrendingUp, Magnet, Trash2, Play, Pause, SkipForward,
  Layers, Search, Save, RotateCcw, Lock, Unlock, Maximize2, Eye, EyeOff, ChevronDown, Plus, Minus, Check,
  PenLine, Activity, List, Shapes, X
} from 'lucide-react';
import { registerTradingViewOverlays } from './tvOverlays';

registerTradingViewOverlays();

const DEFAULT_WATCHLIST = [
  { symbol: 'SPY', name: 'S&P 500 ETF' },
  { symbol: 'QQQ', name: 'Nasdaq 100 ETF' },
  { symbol: 'AAPL', name: 'Apple Inc' },
  { symbol: 'TSLA', name: 'Tesla Inc' },
  { symbol: 'NVDA', name: 'NVIDIA Corp' },
  { symbol: 'IBIT', name: 'iShares Bitcoin Trust' },
  { symbol: 'BTC-USD', name: 'Bitcoin / USD' },
  { symbol: 'ETH-USD', name: 'Ethereum / USD' },
  { symbol: 'VFIAX', name: 'Vanguard 500 Index Admiral' },
  { symbol: 'FXAIX', name: 'Fidelity 500 Index' },
  { symbol: '^GSPC', name: 'S&P 500 Index' },
  { symbol: 'GC=F', name: 'Gold Futures' },
  { symbol: 'EURUSD=X', name: 'EUR / USD' },
];

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '1D', '1wk', '1mo'];
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '1D': 86_400_000,
  '1wk': 604_800_000,
};

type SavedDrawing = {
  id: string;
  name: string;
  lock: boolean;
  visible: boolean;
  points: { timestamp?: number; value?: number; frac?: number }[];
};

type Bar = { timestamp: number };

// Average time between recent bars (a daily stock chart is ~1.4 calendar days per bar)
function avgBarGap(list: Bar[]): number {
  const n = Math.min(50, list.length - 1);
  if (n < 1) return 86_400_000;
  return (list[list.length - 1].timestamp - list[list.length - 1 - n].timestamp) / n;
}

// Chart point -> stored point. Points placed in the empty space past the last candle
// have no bar, so klinecharts gives them only a dataIndex; estimate a timestamp from
// the bar spacing so they keep their place in any timeframe.
function toSavedPoint(pt: any, list: Bar[]) {
  let ts: number | undefined = typeof pt.timestamp === 'number' ? pt.timestamp : undefined;
  if (ts === undefined && typeof pt.dataIndex === 'number' && list.length > 0) {
    const last = list.length - 1;
    if (pt.dataIndex > last) ts = list[last].timestamp + (pt.dataIndex - last) * avgBarGap(list);
    else if (pt.dataIndex < 0) ts = list[0].timestamp + pt.dataIndex * avgBarGap(list);
    else ts = list[Math.round(pt.dataIndex)].timestamp;
  }
  return pt.frac != null ? { timestamp: ts, value: pt.value, frac: pt.frac } : { timestamp: ts, value: pt.value };
}

// Stored point -> chart point. Outside the loaded bars klinecharts would snap a timestamp
// to the first/last candle, so those become fractional bar positions instead.
function toChartPoint(pt: SavedDrawing['points'][number], list: Bar[]) {
  const ts = pt.timestamp;
  if (typeof ts !== 'number' || list.length === 0) return { value: pt.value };
  const first = list[0].timestamp;
  const lastIdx = list.length - 1;
  const lastTs = list[lastIdx].timestamp;
  if (ts > lastTs) return { dataIndex: lastIdx + (ts - lastTs) / avgBarGap(list), value: pt.value };
  if (ts < first) return { dataIndex: (ts - first) / avgBarGap(list), value: pt.value };
  return pt.frac != null ? { timestamp: ts, value: pt.value, frac: pt.frac } : { timestamp: ts, value: pt.value };
}

const hasPosition = (d: SavedDrawing) => (d.points || []).every((pt) => typeof pt.timestamp === 'number');
type SearchResult = { symbol: string; name: string; type: string; exchange?: string; live?: boolean };
type LiveSource = 'ibkr' | 'ibkr-delayed' | 'yahoo-poll';
const SOURCE_LABEL: Record<LiveSource, string> = {
  ibkr: 'LIVE · IBKR',
  'ibkr-delayed': 'DELAYED · IBKR',
  'yahoo-poll': 'POLLED · Yahoo',
};
const TYPE_LABEL: Record<string, string> = {
  EQUITY: 'Stock',
  ETF: 'ETF',
  MUTUALFUND: 'Mutual Fund',
  INDEX: 'Index',
  CRYPTOCURRENCY: 'Crypto',
  CURRENCY: 'FX',
  FUTURE: 'Future',
};

// Timestamp of the bar a tick at `time` belongs in, given the chart's last bar
function barTimeFor(last: { timestamp: number }, time: number, interval: string): number {
  if (interval === '1mo') {
    const a = new Date(last.timestamp);
    const b = new Date(time);
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    if (months <= 0) return last.timestamp;
    a.setUTCMonth(a.getUTCMonth() + months);
    return a.getTime();
  }
  const len = INTERVAL_MS[interval];
  if (time < last.timestamp + len) return last.timestamp;
  return last.timestamp + Math.floor((time - last.timestamp) / len) * len;
}
// Per-browser preferences (indicators and watchlist apply to every chart)
function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private window); prefs just won't persist */
  }
}

// Value for <input type="date|datetime-local"> in local time
function toInputValue(ts: number, withTime: boolean): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}
function fromInputValue(v: string, withTime: boolean): number {
  if (withTime) return new Date(v).getTime();
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

const DEFAULT_BAR_SPACE = 8; // klinecharts' default candle spacing (px)

// Turn price auto-scaling back on for every pane. Dragging or scrolling a price axis
// switches it off and pins the range, which then sticks across symbol/timeframe changes.
function resetPriceScale(chart: Chart) {
  // Public route for the candle pane: setting the y-axis type re-enables auto-scale
  chart.setStyles({ yAxis: { type: 'normal' } });
  // Indicator panes have no public switch; reach the axis directly (klinecharts 9.x internals)
  const panes: any[] = (chart as any)._drawPanes ?? [];
  panes.forEach((pane) => pane.getAxisComponent?.()?.setAutoCalcTickFlag?.(true));
  (chart as any).adjustPaneViewport?.(false, true, true, true);
}

const MAIN_INDICATORS = ['MA', 'EMA', 'BOLL', 'SAR'];
const SUB_INDICATORS = ['VOL', 'MACD', 'RSI', 'KDJ', 'OBV', 'CCI', 'WR'];

const TOOL_GROUPS = [
  {
    category: 'Shapes & Domes',
    tools: [
      { id: 'rect', label: 'Rectangle / Box', hint: 'Click and drag rect on chart' },
      { id: 'circle', label: 'Circle / Cycle', hint: 'Click and drag circle on chart' },
      { id: 'halfCircleNorth', label: 'Half Circle (North)', hint: 'Click both ends of the base; arc opens upward' },
      { id: 'halfCircleSouth', label: 'Half Circle (South)', hint: 'Click both ends of the base; arc opens downward' },
      { id: 'triangle', label: 'Triangle / Wedge', hint: 'Click 3 points on chart' },
      { id: 'parallelogram', label: 'Parallelogram', hint: 'Click 3 points on chart' },
    ],
  },
  {
    category: 'Channels & Lines',
    tools: [
      { id: 'parallelStraightLine', label: 'Parallel Channel', hint: 'Click baseline and channel width' },
      { id: 'straightLine', label: 'Straight Line', hint: 'Click two points on chart' },
      { id: 'rayLine', label: 'Ray Line', hint: 'Click origin and direction' },
      { id: 'horizontalStraightLine', label: 'Horizontal Line', hint: 'Click price level' },
    ],
  },
  {
    category: 'Lines & Fibs',
    tools: [
      { id: 'fibonacciLine', label: 'Fib Retracement', hint: 'Click swing high and low' },
      { id: 'segment', label: 'Trendline', hint: 'Click point A to B' },
      { id: 'verticalStraightLine', label: 'Vertical Line', hint: 'Click time bar' },
      { id: 'priceLine', label: 'Price Line', hint: 'Click price level' },
    ],
  },
  {
    category: 'Brush & Measure',
    tools: [
      { id: 'brush', label: 'Brush (Freehand)', hint: 'Click and drag to paint; Esc or click Brush again to stop' },
      { id: 'priceChannelLine', label: 'Price Channel', hint: 'Click channel bounds' },
      { id: 'simpleAnnotation', label: 'Callout Note', hint: 'Click to place note' },
    ],
  },
];

export default function App() {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<Chart | null>(null);
  const fullDataRef = useRef<any[]>([]);
  const loadedKeyRef = useRef(''); // `${symbol}:${interval}` that fullDataRef currently holds
  const indicatorPanesRef = useRef<Map<string, string>>(new Map());
  // Drawings auto-save per symbol. drawingsSymRef is the symbol whose drawings are on
  // the canvas right now ('' while switching, so removals during a switch aren't saved).
  const drawingsSymRef = useRef('');
  const drawingsCacheRef = useRef<Map<string, SavedDrawing[]>>(new Map());
  const unplaceableRef = useRef<SavedDrawing[]>([]); // saved drawings we can't place; kept as-is
  const pendingSaveRef = useRef<{ sym: string; timer: number } | null>(null);

  const [symbol, setSymbol] = useState('SPY');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [watchlist, setWatchlist] = useState<{ symbol: string; name: string }[]>(() =>
    loadPref('oc.watchlist', DEFAULT_WATCHLIST)
  );
  const [symbolName, setSymbolName] = useState('S&P 500 ETF');

  const [interval, setIntervalState] = useState('1D');
  const [activeIndicators, setActiveIndicators] = useState<string[]>(() =>
    loadPref('oc.indicators', ['MA', 'VOL', 'RSI', 'MACD'])
  );
  const [magnetMode, setMagnetMode] = useState<'normal' | 'weak_magnet' | 'strong_magnet'>('weak_magnet');
  const [drawingsList, setDrawingsList] = useState<{ id: string; name: string; lock?: boolean; visible?: boolean }[]>([]);
  const drawingsListRef = useRef(drawingsList);
  drawingsListRef.current = drawingsList;
  const [activeHint, setActiveHint] = useState<string>('Pick a drawing tool, then click or tap the chart');

  const [isManagerOpen, setIsManagerOpen] = useState(false);
  // Phone layout: sidebars become bottom sheets opened from a tab bar
  const [mobilePanel, setMobilePanel] = useState<null | 'tools' | 'indicators' | 'watchlist' | 'objects' | 'replay'>(
    null
  );

  // Freehand brush: a layer over the chart captures the drag, then becomes one 'brush' overlay
  const [brushMode, setBrushMode] = useState(false);
  const [brushPath, setBrushPath] = useState<{ x: number; y: number }[]>([]);
  const brushPathRef = useRef<{ x: number; y: number }[]>([]);

  const [isReplayMode, setIsReplayMode] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState<number>(0); // index of the last bar shown
  const [isReplayPickerOpen, setIsReplayPickerOpen] = useState(false);
  const [replayStart, setReplayStart] = useState('');
  const isReplayRef = useRef(false);
  isReplayRef.current = isReplayMode;

  const [liveSource, setLiveSource] = useState<LiveSource | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 1) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        // Proxied by the backend: Yahoo blocks direct browser requests (CORS)
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
        const data = await res.json();
        if (Array.isArray(data)) setSearchResults(data);
      } catch (e) {
        console.error('Search error:', e);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (!chartContainerRef.current) return;
    const container = chartContainerRef.current;

    const chart = init(container, {
      styles: {
        grid: {
          show: true,
          horizontal: { show: true, size: 1, color: '#182030', style: 'dashed' },
          vertical: { show: true, size: 1, color: '#182030', style: 'dashed' },
        },
        candle: {
          type: 'candle_solid',
          bar: {
            upColor: '#089981',
            downColor: '#f23645',
            upBorderColor: '#089981',
            downBorderColor: '#f23645',
            upWickColor: '#089981',
            downWickColor: '#f23645',
          },
          priceMark: {
            show: true,
            last: { show: true, upColor: '#089981', downColor: '#f23645' },
          },
        },
        xAxis: {
          show: true,
          size: 36,
          axisLine: { show: true, color: '#2a2e39', size: 1 },
          tickLine: { show: true, color: '#2a2e39', size: 1, length: 4 },
          tickText: { show: true, color: '#787b86', size: 11 },
        },
        yAxis: {
          show: true,
          size: 72,
          position: 'right',
          type: 'normal',
          axisLine: { show: true, color: '#2a2e39', size: 1 },
          tickLine: { show: true, color: '#2a2e39', size: 1, length: 4 },
          tickText: { show: true, color: '#787b86', size: 11 },
        },
        separator: { size: 1, color: '#2a2e39', fill: true, activeColor: '#3b82f6' },
      },
    });
    chartInstance.current = chart;
    if (import.meta.env.DEV) (window as any).__chart = chart;

    // Follow the container, not just the window: rotation, phone toolbars and layout changes resize it
    const observer = new ResizeObserver(() => chart?.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      indicatorPanesRef.current.clear();
      dispose(container);
    };
  }, []);

  useEffect(() => savePref('oc.indicators', activeIndicators), [activeIndicators]);
  useEffect(() => {
    savePref('oc.watchlist', watchlist);
    // The backend keeps these symbols' history synced so they open instantly
    fetch('/api/watchlist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: watchlist.map((w) => w.symbol) }),
    }).catch(() => {});
  }, [watchlist]);

  // Sync Active Indicators to Chart Panes
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart) return;

    // Diff against what's on the chart. removeIndicator() needs a paneId in v9,
    // so a blanket clear silently does nothing and panes pile up.
    const panes = indicatorPanesRef.current;
    panes.forEach((paneId, ind) => {
      if (!activeIndicators.includes(ind)) {
        chart.removeIndicator(paneId, ind);
        panes.delete(ind);
      }
    });

    activeIndicators.forEach((ind) => {
      if (panes.has(ind)) return;
      const paneId = MAIN_INDICATORS.includes(ind)
        ? chart.createIndicator(ind, true, { id: 'candle_pane' })
        : chart.createIndicator(ind, false, { height: 90 });
      if (paneId) panes.set(ind, paneId);
    });
  }, [activeIndicators]);

  useEffect(() => {
    async function loadSymbolData() {
      const chart = chartInstance.current;
      if (!chart) return;

      // Write out any unsaved edits for the symbol we're leaving before clearing the canvas
      flushDrawings();
      drawingsSymRef.current = '';

      const [klineRes, wsRes] = await Promise.all([
        fetch(`/api/klines?symbol=${symbol}&interval=${interval}`),
        fetch(`/api/workspace/${symbol}`),
      ]);
      loadedKeyRef.current = '';
      const klines = await klineRes.json();
      const ws = await wsRes.json();
      if (!Array.isArray(klines) || klines.length === 0) {
        chart.applyNewData([]);
        fullDataRef.current = [];
        setActiveHint(
          `No ${interval} data for ${symbol}` +
            (interval.endsWith('m') || interval === '1h' ? ' (mutual funds only have daily NAV; try 1D)' : '')
        );
        return;
      }

      // Yahoo stamps the forming bar with "now"; snap it onto the bar grid so live bars line up
      const len = INTERVAL_MS[interval];
      if (len && klines.length > 1) {
        const prev = klines[klines.length - 2].timestamp;
        const last = klines[klines.length - 1];
        last.timestamp = prev + Math.floor((last.timestamp - prev) / len) * len;
        // Same slot as the previous bar: it's a duplicate of the forming bar, fold it in
        if (last.timestamp === prev) {
          const p = klines[klines.length - 2];
          p.high = Math.max(p.high, last.high);
          p.low = Math.min(p.low, last.low);
          p.close = last.close;
          klines.pop();
        }
      }

      fullDataRef.current = klines;
      loadedKeyRef.current = `${symbol}:${interval}`;
      setLiveSource(null);
      setLastPrice(null);
      setIsReplayMode(false);
      setIsPlaying(false);
      chart.applyNewData(klines);
      // A manual price-axis drag pins the price range; don't carry it onto new data
      resetPriceScale(chart);

      chart.removeOverlay();
      // The in-memory copy wins: it can be newer than what the server has if a save is in flight
      const saved: SavedDrawing[] =
        drawingsCacheRef.current.get(symbol) ?? (Array.isArray(ws.drawings) ? ws.drawings : []);
      const restored: { id: string; name: string; lock?: boolean; visible?: boolean }[] = [];
      const bars = chart.getDataList();
      // Older saves lost the time of points drawn past the last candle. Don't draw those
      // (they'd stretch to the left edge), but keep them stored untouched.
      unplaceableRef.current = saved.filter((d) => !hasPosition(d));
      if (unplaceableRef.current.length > 0) {
        setActiveHint(
          `${unplaceableRef.current.length} saved drawing(s) on ${symbol} lost a point's date and can't be shown; please redraw`
        );
      }
      saved.filter(hasPosition).forEach((d) => {
        const id = d.id || `draw_${Math.random().toString(36).slice(2, 8)}`;
        const visible = d.visible !== false;
        // Points carry timestamps, so they land on the right bars in any timeframe
        const created = chart.createOverlay({
          id,
          name: d.name,
          points: (d.points || []).map((pt) => toChartPoint(pt, bars)),
          lock: Boolean(d.lock),
          visible,
          mode: magnetMode,
          ...drawingCallbacks(id),
        });
        if (created) restored.push({ id, name: d.name, lock: Boolean(d.lock), visible });
      });
      drawingsCacheRef.current.set(symbol, saved);
      setDrawingsList(restored);
      drawingsSymRef.current = symbol;
    }
    loadSymbolData();
  }, [symbol, interval]);

  useEffect(() => {
    if (!isReplayMode || !isPlaying) return;
    const timer = window.setInterval(() => {
      setReplayIndex((prev) => {
        const next = prev + 1;
        if (next >= fullDataRef.current.length) {
          setIsPlaying(false);
          return prev;
        }
        chartInstance.current?.updateData(fullDataRef.current[next]);
        return next;
      });
    }, 450);
    return () => clearInterval(timer);
  }, [isReplayMode, isPlaying]);

  // Stream live prices into the forming bar
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ subscribe: symbol }));
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type !== 'tick' || msg.symbol !== symbol) return;
        setLiveSource(msg.source);
        setLastPrice(msg.price);
        if (isReplayRef.current || loadedKeyRef.current !== `${symbol}:${interval}`) return;

        const data = fullDataRef.current;
        const last = data[data.length - 1];
        if (!last || msg.time < last.timestamp) return;
        const ts = barTimeFor(last, msg.time, interval);
        let bar;
        if (ts === last.timestamp) {
          bar = {
            ...last,
            high: Math.max(last.high, msg.price),
            low: Math.min(last.low, msg.price),
            close: msg.price,
            volume: (last.volume || 0) + msg.volume,
          };
          data[data.length - 1] = bar;
        } else {
          bar = { timestamp: ts, open: msg.price, high: msg.price, low: msg.price, close: msg.price, volume: msg.volume };
          data.push(bar);
        }
        chartInstance.current?.updateData(bar);
      };
      socket.onclose = () => {
        setLiveSource(null);
        if (!closed) retry = window.setTimeout(connect, 3000);
      };
    };
    connect();

    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [symbol, interval]);

  const toggleIndicator = (ind: string) => {
    setActiveIndicators((prev) =>
      prev.includes(ind) ? prev.filter((i) => i !== ind) : [...prev, ind]
    );
  };

  // Snapshot of what's on the canvas now, in the shape the server stores
  const serializeDrawings = (): SavedDrawing[] => {
    const chart = chartInstance.current;
    return drawingsListRef.current
      .map((item) => {
        const ov: any = chart?.getOverlayById(item.id);
        return {
          id: item.id,
          name: item.name,
          lock: Boolean(item.lock),
          visible: item.visible !== false,
          points: (ov?.points || []).map((pt: any) => toSavedPoint(pt, chart?.getDataList() ?? [])),
        };
      })
      .filter((d) => d.points.length > 0)
      .concat(unplaceableRef.current);
  };

  const writeDrawings = (sym: string) => {
    const drawings = serializeDrawings();
    drawingsCacheRef.current.set(sym, drawings);
    fetch(`/api/workspace/${encodeURIComponent(sym)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeframe: interval, drawings }),
      keepalive: true, // lets the save finish if the tab is closing
    }).catch((e) => console.error('Drawing save failed:', e));
    return drawings.length;
  };

  // Debounced so dragging or rapid edits make one request; runs after React commits the list
  const scheduleDrawingsSave = () => {
    const sym = drawingsSymRef.current;
    if (!sym) return;
    if (pendingSaveRef.current) window.clearTimeout(pendingSaveRef.current.timer);
    const timer = window.setTimeout(() => {
      pendingSaveRef.current = null;
      if (drawingsSymRef.current === sym) writeDrawings(sym);
    }, 400);
    pendingSaveRef.current = { sym, timer };
  };

  const flushDrawings = () => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingSaveRef.current = null;
    if (drawingsSymRef.current === pending.sym) writeDrawings(pending.sym);
  };

  // Shared by new and restored drawings so edits to either get saved
  const drawingCallbacks = (id: string) => ({
    onPressedMoveEnd: () => {
      scheduleDrawingsSave();
      return false;
    },
    onRemoved: () => {
      setDrawingsList((prev) => prev.filter((item) => item.id !== id));
      scheduleDrawingsSave();
      return false;
    },
  });

  // Save before the tab closes or reloads
  useEffect(() => {
    const onHide = () => flushDrawings();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  });

  useEffect(() => {
    if (!brushMode) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBrushMode(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [brushMode]);

  const brushPoint = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onBrushDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId); // keep the stroke if the pointer leaves the chart
    } catch {
      /* pointer already gone */
    }
    brushPathRef.current = [brushPoint(e)];
    setBrushPath(brushPathRef.current);
  };

  const onBrushMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const path = brushPathRef.current;
    if (path.length === 0) return;
    const p = brushPoint(e);
    const last = path[path.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return; // thin out the path
    brushPathRef.current = [...path, p];
    setBrushPath(brushPathRef.current);
  };

  const onBrushUp = () => {
    const path = brushPathRef.current;
    brushPathRef.current = [];
    setBrushPath([]);
    const chart = chartInstance.current;
    const data = fullDataRef.current;
    if (!chart || path.length < 2 || data.length === 0) return;

    // Pixel -> fractional bar index + price, then anchor each point to a real bar's
    // timestamp and keep the remainder, so the stroke stays smooth between bars
    const raw = chart.convertFromPixel(path, { paneId: 'candle_pane', absolute: true }) as any[];
    // convertFromPixel only gives whole bar indexes, so measure the sub-bar offset from the bar's pixel x
    const list = chart.getDataList();
    const barSpace = chart.getBarSpace();
    const points = raw
      .map((pt, n) => ({ pt, x: path[n].x }))
      .filter(({ pt }) => typeof pt.dataIndex === 'number' && typeof pt.value === 'number')
      .map(({ pt, x }) => {
        const i = Math.round(pt.dataIndex);
        const barX = (chart.convertToPixel({ dataIndex: i }, { paneId: 'candle_pane' }) as any).x ?? x;
        const f = i + (x - barX) / barSpace; // exact fractional bar position
        if (i < 0 || i > list.length - 1) return { dataIndex: f, value: pt.value }; // past the candles
        return { timestamp: list[i].timestamp, value: pt.value, frac: f - i };
      });
    if (points.length < 2) return;

    const id = `draw_${Date.now()}`;
    const created = chart.createOverlay({ id, name: 'brush', points, mode: 'normal', ...drawingCallbacks(id) });
    if (!created) return;
    setDrawingsList((prev) => [...prev, { id, name: 'brush', lock: false, visible: true }]);
    scheduleDrawingsSave();
  };

  const addDrawing = (toolName: string, hintText: string) => {
    if (toolName === 'brush') {
      setBrushMode((on) => !on);
      setActiveHint(brushMode ? 'Brush off' : `brush: ${hintText}`);
      return;
    }
    setBrushMode(false);
    const chart = chartInstance.current;
    if (!chart) return;
    const id = `draw_${Date.now()}`;
    setActiveHint(`${toolName}: ${hintText}`);

    // Activate native klinecharts drawing mode on canvas
    const created = chart.createOverlay({
      name: toolName,
      id,
      mode: magnetMode,
      visible: true,
      // Only list a drawing once it's finished; picking another tool mid-draw
      // makes klinecharts discard the unfinished one without any callback.
      ...drawingCallbacks(id),
      onDrawEnd: () => {
        setActiveHint(`${toolName}: placed`);
        setDrawingsList((prev) => [...prev, { id, name: toolName, lock: false, visible: true }]);
        scheduleDrawingsSave();
        return false;
      },
    });

    if (!created) {
      setActiveHint(`${toolName}: not a registered overlay`);
    }
  };

  // Apply magnet changes to drawings already on the chart
  useEffect(() => {
    drawingsList.forEach((d) => chartInstance.current?.overrideOverlay({ id: d.id, mode: magnetMode }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magnetMode]);

  const toggleVisibilityDrawing = (id: string) => {
    setDrawingsList((prev) =>
      prev.map((d) => {
        if (d.id === id) {
          const nextVisible = !d.visible;
          chartInstance.current?.overrideOverlay({ id, visible: nextVisible });
          scheduleDrawingsSave();
          return { ...d, visible: nextVisible };
        }
        return d;
      })
    );
  };

  const toggleLockDrawing = (id: string) => {
    setDrawingsList((prev) =>
      prev.map((d) => {
        if (d.id === id) {
          const nextLock = !d.lock;
          chartInstance.current?.overrideOverlay({ id, lock: nextLock });
          scheduleDrawingsSave();
          return { ...d, lock: nextLock };
        }
        return d;
      })
    );
  };

  const clearAllDrawings = () => {
    chartInstance.current?.removeOverlay();
    setDrawingsList([]);
  };

  const resetChartView = () => {
    const chart = chartInstance.current;
    if (!chart) return;
    resetPriceScale(chart);
    chart.setBarSpace(DEFAULT_BAR_SPACE);
    chart.scrollToRealTime();
    setActiveHint('View reset: default zoom, auto price scale, latest bars');
  };

  const selectSecurity = (targetSymbol: string, targetName?: string) => {
    const cleanSym = targetSymbol.toUpperCase();
    setSymbol(cleanSym);
    setSymbolName(targetName ?? watchlist.find((w) => w.symbol === cleanSym)?.name ?? '');
    setSearchQuery('');
    setSearchResults([]);
  };

  const inWatchlist = (sym: string) => watchlist.some((w) => w.symbol === sym.toUpperCase());
  const addToWatchlist = (sym: string, name: string) => {
    const clean = sym.toUpperCase();
    setWatchlist((prev) => (prev.some((w) => w.symbol === clean) ? prev : [...prev, { symbol: clean, name }]));
    setActiveHint(`Added ${clean} to watchlist`);
  };
  const removeFromWatchlist = (sym: string) => {
    setWatchlist((prev) => prev.filter((w) => w.symbol !== sym.toUpperCase()));
    setActiveHint(`Removed ${sym} from watchlist`);
  };

  const replayWithTime = !['1D', '1wk', '1mo'].includes(interval);

  const openReplayPicker = () => {
    const data = fullDataRef.current;
    if (data.length < 2) return;
    // Default to the bar three-quarters of the way through the loaded history
    const def = data[Math.floor(data.length * 0.75)].timestamp;
    setReplayStart(toInputValue(def, replayWithTime));
    setIsReplayPickerOpen(true);
  };

  // Replay from the first bar on/after `startTs`; bars before it are shown as history
  const startReplay = (startTs: number) => {
    const data = fullDataRef.current;
    let cutIndex = data.findIndex((b) => b.timestamp >= startTs);
    if (cutIndex === -1) cutIndex = data.length - 1;
    cutIndex = Math.max(1, cutIndex);
    setReplayIndex(cutIndex - 1);
    setIsReplayMode(true);
    setIsPlaying(false);
    setIsReplayPickerOpen(false);
    chartInstance.current?.applyNewData(data.slice(0, cutIndex));
    setActiveHint(`Replay from ${new Date(data[cutIndex].timestamp).toLocaleString()} — press play or step`);
  };

  const replayPresetTs = (days: number) => Date.now() - days * 86_400_000;

  const stepReplayForward = () => {
    if (!isReplayMode) return;
    const next = replayIndex + 1;
    if (next < fullDataRef.current.length) {
      chartInstance.current?.updateData(fullDataRef.current[next]);
      setReplayIndex(next);
    }
  };

  // Drawings auto-save; the button just forces it now
  const saveWorkspace = () => {
    if (pendingSaveRef.current) window.clearTimeout(pendingSaveRef.current.timer);
    pendingSaveRef.current = null;
    const n = writeDrawings(symbol);
    setActiveHint(`Saved ${n} shapes for ${symbol}`);
  };

  // ---- Panel contents, shared by the desktop sidebars and the phone bottom sheets ----

  const toolsPanel = (
    <>
      <div className="space-y-3">
        {TOOL_GROUPS.map((group) => (
          <div key={group.category} className="space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[#787b86] px-2 py-0.5">
              {group.category}
            </div>
            {group.tools.map((tool) => (
              <button
                key={tool.id}
                onClick={() => {
                  addDrawing(tool.id, tool.hint);
                  setMobilePanel(null); // get the sheet out of the way so you can draw
                }}
                className={`w-full text-left px-2.5 py-2.5 md:py-1.5 text-sm md:text-xs rounded transition flex items-center justify-between ${
                  tool.id === 'brush' && brushMode
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'text-slate-300 hover:bg-[#2a2e39] hover:text-white'
                }`}
              >
                <span>{tool.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="space-y-1.5 border-t border-[#2a2e39] pt-2 mt-2">
        <button
          onClick={() =>
            setMagnetMode((m) => (m === 'normal' ? 'weak_magnet' : m === 'weak_magnet' ? 'strong_magnet' : 'normal'))
          }
          className="w-full flex items-center justify-between px-2.5 py-2.5 md:py-1.5 text-sm md:text-xs rounded bg-[#131722] text-cyan-300 border border-[#363a45]"
        >
          <span className="flex items-center gap-1.5">
            <Magnet className="w-3.5 h-3.5" /> Magnet
          </span>
          <span className="text-[10px] font-mono uppercase">{magnetMode.replace('_magnet', '')}</span>
        </button>

        <button
          onClick={clearAllDrawings}
          className="w-full flex items-center gap-1.5 px-2.5 py-2.5 md:py-1.5 text-sm md:text-xs rounded bg-rose-950/30 text-rose-400 hover:bg-rose-900/40 border border-rose-800/30"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear All
        </button>
      </div>
    </>
  );

  const indicatorChips = (
    <>
      {[...MAIN_INDICATORS, ...SUB_INDICATORS].map((ind) => (
        <button
          key={ind}
          onClick={() => toggleIndicator(ind)}
          className={`px-3 py-2 md:px-2 md:py-0.5 text-sm md:text-[11px] font-mono rounded border transition ${
            activeIndicators.includes(ind)
              ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300'
              : 'bg-[#131722] border-[#2a2e39] text-slate-400 hover:text-slate-200'
          }`}
        >
          {ind}
        </button>
      ))}
    </>
  );

  const watchlistPanel = (
    <>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#787b86]">
          Watchlist ({watchlist.length})
        </span>
        {!inWatchlist(symbol) && (
          <button
            onClick={() => addToWatchlist(symbol, symbolName || symbol)}
            className="flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
            title={`Add ${symbol} to watchlist`}
          >
            <Plus className="w-3 h-3" /> {symbol}
          </button>
        )}
      </div>
      {watchlist.length === 0 && (
        <div className="text-xs text-[#787b86] italic px-1">Empty. Search a symbol and press + to add it.</div>
      )}
      <div className="space-y-1">
        {watchlist.map((item) => (
          <div
            key={item.symbol}
            className={`group flex items-center rounded text-sm md:text-xs transition ${
              symbol === item.symbol
                ? 'bg-[#2a2e39] border border-[#363a45] text-white font-semibold'
                : 'hover:bg-[#131722] text-slate-300'
            }`}
          >
            <button
              onClick={() => {
                selectSecurity(item.symbol, item.name);
                setMobilePanel(null);
              }}
              className="flex-1 min-w-0 flex items-center justify-between pl-2.5 py-3 md:py-2 text-left"
            >
              <span className="font-mono font-bold">{item.symbol}</span>
              <span className="text-xs md:text-[11px] text-[#787b86] truncate ml-2">{item.name}</span>
            </button>
            <button
              onClick={() => removeFromWatchlist(item.symbol)}
              className="w-10 md:w-7 shrink-0 self-stretch flex items-center justify-center text-slate-500 md:opacity-0 md:group-hover:opacity-100 hover:text-rose-400 transition"
              title={`Remove ${item.symbol} from watchlist`}
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </>
  );

  const objectTreePanel = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#787b86] mb-1.5">
        Object Tree ({drawingsList.length} Shapes)
      </div>
      {drawingsList.length === 0 ? (
        <div className="text-xs text-[#787b86] italic">No active overlays on canvas</div>
      ) : (
        <ul className="space-y-1 text-sm md:text-xs font-mono text-slate-300">
          {drawingsList.map((d) => (
            <li
              key={d.id}
              className="flex justify-between items-center bg-[#1e222d] px-2 py-2 md:py-1 rounded border border-[#2a2e39]"
            >
              <span className="truncate">{d.name}</span>
              <div className="flex items-center gap-3 md:gap-1.5">
                <button
                  onClick={() => toggleVisibilityDrawing(d.id)}
                  className="text-slate-300 hover:text-white"
                  title={d.visible !== false ? 'Hide shape' : 'Show shape'}
                >
                  {d.visible !== false ? (
                    <Eye className="w-4 h-4 md:w-3.5 md:h-3.5 text-emerald-400" />
                  ) : (
                    <EyeOff className="w-4 h-4 md:w-3.5 md:h-3.5 text-slate-500" />
                  )}
                </button>
                <button
                  onClick={() => toggleLockDrawing(d.id)}
                  className="text-[#787b86] hover:text-amber-300"
                  title={d.lock ? 'Unlock shape' : 'Lock shape'}
                >
                  {d.lock ? (
                    <Lock className="w-3.5 h-3.5 md:w-3 md:h-3 text-amber-400" />
                  ) : (
                    <Unlock className="w-3.5 h-3.5 md:w-3 md:h-3" />
                  )}
                </button>
                <button
                  onClick={() => {
                    chartInstance.current?.removeOverlay(d.id);
                    setDrawingsList((prev) => prev.filter((item) => item.id !== d.id));
                  }}
                  className="text-rose-400 hover:text-rose-300 text-xs md:text-[10px]"
                >
                  del
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const replayPicker = (
    <div className="space-y-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#787b86]">Replay start ({interval})</div>
      <input
        type={replayWithTime ? 'datetime-local' : 'date'}
        value={replayStart}
        min={fullDataRef.current[1] ? toInputValue(fullDataRef.current[1].timestamp, replayWithTime) : undefined}
        max={toInputValue(fullDataRef.current[fullDataRef.current.length - 1]?.timestamp ?? Date.now(), replayWithTime)}
        onChange={(e) => setReplayStart(e.target.value)}
        className="w-full bg-[#131722] border border-[#363a45] rounded px-2 py-2 md:py-1 text-base md:text-xs text-white font-mono [color-scheme:dark]"
      />
      <div className="flex flex-wrap gap-1.5 md:gap-1">
        {[
          ['1W', 7],
          ['1M', 30],
          ['3M', 91],
          ['6M', 182],
          ['1Y', 365],
          ['5Y', 1826],
        ].map(([label, days]) => (
          <button
            key={label}
            onClick={() => setReplayStart(toInputValue(replayPresetTs(days as number), replayWithTime))}
            className="px-3 py-1.5 md:px-2 md:py-0.5 text-sm md:text-[11px] rounded bg-[#131722] border border-[#2a2e39] text-slate-300 hover:text-white"
            title={`${label} ago`}
          >
            −{label}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={() => {
            setIsReplayPickerOpen(false);
            setMobilePanel(null);
          }}
          className="text-sm md:text-[11px] text-slate-400 hover:text-white px-2"
        >
          Cancel
        </button>
        <button
          disabled={!replayStart}
          onClick={() => {
            startReplay(fromInputValue(replayStart, replayWithTime));
            setMobilePanel(null);
          }}
          className="flex items-center gap-1 bg-amber-500/80 hover:bg-amber-500 text-black font-medium px-3 py-1.5 md:px-2.5 md:py-1 rounded text-sm md:text-xs disabled:opacity-40"
        >
          <Play className="w-3 h-3" /> Start
        </button>
      </div>
    </div>
  );

  const MOBILE_TABS = [
    { id: 'tools', label: 'Draw', icon: PenLine },
    { id: 'indicators', label: 'Indicators', icon: Activity },
    { id: 'watchlist', label: 'Watchlist', icon: List },
    { id: 'objects', label: 'Objects', icon: Shapes },
    { id: 'replay', label: 'Replay', icon: RotateCcw },
  ] as const;

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[#131722] text-[#d1d4dc] select-none overflow-hidden">
      <header className="h-12 border-b border-[#2a2e39] bg-[#1e222d] px-3 flex items-center justify-between gap-2 md:gap-4 shrink-0 relative">
        <div className="flex items-center gap-2 md:gap-3 min-w-0 flex-1 md:flex-none">
          <div className="flex items-center gap-1.5 font-bold text-blue-500 tracking-tight shrink-0">
            <TrendingUp className="w-5 h-5 text-emerald-400" />
            <span className="text-white hidden sm:inline">Stek</span>
          </div>

          <div className="relative min-w-0 flex-1 md:flex-none">
            <div className="flex items-center bg-[#131722] rounded px-2 py-1 border border-[#363a45] w-full md:w-48">
              <Search className="w-3.5 h-3.5 text-slate-400 mr-1.5 shrink-0" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchQuery.trim()) {
                    const hit = searchResults[0];
                    selectSecurity(hit?.symbol ?? searchQuery.trim(), hit?.name);
                  }
                  if (e.key === 'Escape') setSearchQuery('');
                }}
                placeholder={`Search ${symbol}...`}
                // 16px on phones stops iOS Safari from zooming in when the field is focused
                className="bg-transparent text-base md:text-xs font-mono uppercase w-full focus:outline-none text-white"
              />
            </div>

            {searchResults.length > 0 && (
              <div className="fixed left-2 right-2 top-12 md:absolute md:left-0 md:right-auto md:top-10 md:w-80 bg-[#1e222d] border border-[#2a2e39] rounded shadow-2xl z-50 max-h-[70vh] md:max-h-96 overflow-y-auto">
                <div className="text-[10px] font-semibold uppercase text-slate-500 px-2.5 py-1 bg-[#131722]">
                  Global Security Search Results
                </div>
                {searchResults.map((res) => (
                  <div
                    key={res.symbol}
                    className="flex items-stretch border-b border-[#2a2e39]/50 hover:bg-[#2962ff]/20 transition"
                  >
                    <button
                      onClick={() => selectSecurity(res.symbol, res.name)}
                      className="flex-1 min-w-0 text-left px-2.5 py-2.5 md:py-2 flex items-center justify-between"
                    >
                      <div className="min-w-0">
                        <div className="font-mono font-bold text-white text-sm md:text-xs">{res.symbol}</div>
                        <div className="text-xs md:text-[11px] text-slate-400 truncate max-w-[180px]">{res.name}</div>
                      </div>
                      <div className="flex flex-col items-end gap-0.5 shrink-0">
                        <span className="text-[10px] bg-[#131722] text-blue-400 px-1.5 py-0.5 rounded font-mono">
                          {TYPE_LABEL[res.type] || res.type}
                        </span>
                        <span className="text-[9px] text-slate-500">
                          {res.exchange}
                          {res.live ? ' · IBKR' : ''}
                        </span>
                      </div>
                    </button>
                    <button
                      onClick={() =>
                        inWatchlist(res.symbol) ? removeFromWatchlist(res.symbol) : addToWatchlist(res.symbol, res.name)
                      }
                      className={`w-11 md:w-9 shrink-0 flex items-center justify-center border-l border-[#2a2e39]/50 transition group ${
                        inWatchlist(res.symbol)
                          ? 'text-emerald-400 hover:text-rose-400 hover:bg-rose-950/40'
                          : 'text-slate-400 hover:text-emerald-300 hover:bg-emerald-950/40'
                      }`}
                      title={inWatchlist(res.symbol) ? 'Remove from watchlist' : 'Add to watchlist'}
                    >
                      {inWatchlist(res.symbol) ? (
                        <>
                          <Check className="w-4 h-4 group-hover:hidden" />
                          <Minus className="w-4 h-4 hidden group-hover:block" />
                        </>
                      ) : (
                        <Plus className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="hidden md:flex items-center gap-1 bg-[#131722] p-1 rounded border border-[#2a2e39]">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                onClick={() => setIntervalState(tf)}
                className={`px-2 py-0.5 text-xs font-medium rounded transition ${
                  interval === tf ? 'bg-[#2962ff] text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          <select
            value={interval}
            onChange={(e) => setIntervalState(e.target.value)}
            className="md:hidden shrink-0 bg-[#2962ff] text-white text-base font-medium rounded px-2 py-0.5 border-0 focus:outline-none"
            aria-label="Timeframe"
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </div>

        <div className="hidden md:flex items-center gap-1 overflow-x-auto">
          <Layers className="w-4 h-4 text-slate-400 mr-1 shrink-0" />
          {indicatorChips}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={resetChartView}
            className="hidden md:flex items-center gap-1 bg-[#2a2e39] hover:bg-[#363a45] text-slate-200 px-2.5 py-1 rounded text-xs font-medium border border-[#363a45]"
            title="Reset Chart View & Bring Focus to Live Candles"
          >
            <Maximize2 className="w-3.5 h-3.5 text-blue-400" />
            Reset View
          </button>

          {!isReplayMode ? (
            <div className="relative hidden md:block">
              <button
                onClick={() => (isReplayPickerOpen ? setIsReplayPickerOpen(false) : openReplayPicker())}
                className="flex items-center gap-1 bg-amber-500/15 border border-amber-500/40 text-amber-300 px-2.5 py-1 rounded text-xs hover:bg-amber-500/25"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Bar Replay
              </button>
              {isReplayPickerOpen && (
                <div className="absolute right-0 top-9 w-64 bg-[#1e222d] border border-[#2a2e39] rounded shadow-2xl z-50 p-3">
                  {replayPicker}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1 bg-amber-950/40 border border-amber-600/40 px-1 md:px-2 py-0.5 rounded">
              <span className="text-[10px] font-mono text-amber-200/80 px-1 hidden sm:inline" title="Last replayed bar">
                {fullDataRef.current[replayIndex]
                  ? toInputValue(fullDataRef.current[replayIndex].timestamp, replayWithTime).replace('T', ' ')
                  : ''}
              </span>
              <button onClick={() => setIsPlaying(!isPlaying)} className="p-1.5 md:p-1 text-amber-300 hover:text-white">
                {isPlaying ? <Pause className="w-4 h-4 md:w-3.5 md:h-3.5" /> : <Play className="w-4 h-4 md:w-3.5 md:h-3.5" />}
              </button>
              <button onClick={stepReplayForward} className="p-1.5 md:p-1 text-amber-300 hover:text-white" title="Next Bar">
                <SkipForward className="w-4 h-4 md:w-3.5 md:h-3.5" />
              </button>
              <button
                onClick={() => {
                  setIsReplayMode(false);
                  setIsPlaying(false);
                  chartInstance.current?.applyNewData(fullDataRef.current);
                }}
                className="text-xs md:text-[11px] text-rose-400 px-1.5 hover:underline"
              >
                Exit
              </button>
            </div>
          )}

          <button
            onClick={saveWorkspace}
            className="hidden md:flex items-center gap-1 bg-[#2962ff] hover:bg-[#1e53e5] text-white px-2.5 py-1 rounded text-xs font-medium"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="hidden md:flex w-48 border-r border-[#2a2e39] bg-[#1e222d] p-2 flex-col justify-between overflow-y-auto shrink-0">
          {toolsPanel}
        </aside>

        <main className="flex-1 min-w-0 flex flex-col relative bg-[#131722] overflow-hidden">
          {/* Top-Left Chart Dropdown: Indicator & Drawing Visibility Manager (desktop; phones use the Objects tab) */}
          <div className="absolute top-2 left-2 z-20 hidden md:block">
            <button
              onClick={() => setIsManagerOpen(!isManagerOpen)}
              className="flex items-center gap-1.5 bg-[#1e222d]/90 hover:bg-[#2a2e39] text-[#d1d4dc] px-2.5 py-1.5 rounded border border-[#2a2e39] shadow-lg text-xs font-medium backdrop-blur-sm transition"
            >
              <Layers className="w-3.5 h-3.5 text-blue-400" />
              <span>Visible Items</span>
              <span className="bg-[#131722] text-blue-400 px-1 rounded text-[10px] font-mono">
                {activeIndicators.length + drawingsList.length}
              </span>
              <ChevronDown className="w-3 h-3 text-slate-400 ml-0.5" />
            </button>

            {isManagerOpen && (
              <div className="absolute left-0 top-9 w-64 bg-[#1e222d] border border-[#2a2e39] rounded shadow-2xl z-30 p-2 space-y-3 max-h-96 overflow-y-auto">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#787b86] px-1 mb-1">
                    Active Indicators ({activeIndicators.length})
                  </div>
                  <div className="space-y-1">
                    {activeIndicators.map((ind) => (
                      <div
                        key={ind}
                        className="flex items-center justify-between bg-[#131722] px-2 py-1 rounded text-xs font-mono"
                      >
                        <span>{ind}</span>
                        <button
                          onClick={() => toggleIndicator(ind)}
                          className="text-rose-400 hover:text-rose-300 text-[10px] px-1 py-0.5 bg-rose-950/40 rounded border border-rose-800/30"
                          title="Turn indicator off"
                        >
                          Turn Off
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-[#2a2e39] pt-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#787b86] px-1 mb-1">
                    Chart Drawings ({drawingsList.length})
                  </div>
                  {drawingsList.length === 0 ? (
                    <div className="text-xs text-[#787b86] italic px-1">No active drawings</div>
                  ) : (
                    <div className="space-y-1">
                      {drawingsList.map((d) => (
                        <div
                          key={d.id}
                          className="flex items-center justify-between bg-[#131722] px-2 py-1 rounded text-xs font-mono"
                        >
                          <span className="truncate max-w-[120px]">{d.name}</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => toggleVisibilityDrawing(d.id)}
                              className="text-slate-300 hover:text-white"
                              title={d.visible !== false ? 'Hide shape' : 'Show shape'}
                            >
                              {d.visible !== false ? (
                                <Eye className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <EyeOff className="w-3.5 h-3.5 text-slate-500" />
                              )}
                            </button>
                            <button
                              onClick={() => {
                                chartInstance.current?.removeOverlay(d.id);
                                setDrawingsList((prev) => prev.filter((item) => item.id !== d.id));
                              }}
                              className="text-rose-400 hover:text-rose-300 text-[10px]"
                            >
                              del
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="relative flex-1 min-h-0">
            <div ref={chartContainerRef} className="absolute inset-0" />
            {brushMode && (
              <div
                className="absolute inset-0 z-10 cursor-crosshair touch-none"
                onPointerDown={onBrushDown}
                onPointerMove={onBrushMove}
                onPointerUp={onBrushUp}
                onPointerCancel={onBrushUp}
              >
                {brushPath.length > 1 && (
                  <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    <polyline
                      points={brushPath.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            )}
          </div>
          <div className="h-6 bg-[#1e222d] border-t border-[#2a2e39] px-3 flex items-center justify-between gap-3 text-[11px] text-[#787b86] font-mono shrink-0">
            <span className="truncate min-w-0">{activeHint}</span>
            <span className="flex items-center gap-3 shrink-0">
              <span
                className={liveSource === 'ibkr' ? 'text-emerald-400' : liveSource ? 'text-amber-400' : 'text-slate-500'}
                title="Live price source"
              >
                ● <span className="hidden sm:inline">{liveSource ? SOURCE_LABEL[liveSource as LiveSource] : 'No live feed'}</span>
              </span>
              <span>
                <span className="hidden md:inline">Active Symbol: </span>
                <strong className="text-white">{symbol}</strong>
                {lastPrice !== null && <span className="text-white ml-2">{lastPrice}</span>}
              </span>
            </span>
          </div>
        </main>

        <aside className="hidden md:flex w-60 border-l border-[#2a2e39] bg-[#1e222d] flex-col justify-between shrink-0">
          <div className="p-2.5 overflow-y-auto">{watchlistPanel}</div>
          <div className="p-2.5 border-t border-[#2a2e39] bg-[#131722] h-56 overflow-y-auto shrink-0">{objectTreePanel}</div>
        </aside>
      </div>

      {/* Phone: tab bar + bottom sheets */}
      <nav className="md:hidden flex border-t border-[#2a2e39] bg-[#1e222d] shrink-0 pb-[env(safe-area-inset-bottom)]">
        {MOBILE_TABS.map(({ id, label, icon: Icon }) => {
          const active = mobilePanel === id || (id === 'tools' && brushMode);
          return (
            <button
              key={id}
              onClick={() => {
                if (mobilePanel === id) return setMobilePanel(null);
                if (id === 'replay') openReplayPicker();
                setMobilePanel(id);
              }}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] ${
                active ? 'text-[#2962ff]' : 'text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              {label}
            </button>
          );
        })}
      </nav>

      {mobilePanel && (
        <div className="md:hidden fixed inset-0 z-40" onClick={() => setMobilePanel(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="absolute left-0 right-0 bottom-0 max-h-[75dvh] flex flex-col bg-[#1e222d] border-t border-[#2a2e39] rounded-t-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
              <span className="text-sm font-semibold text-white">
                {MOBILE_TABS.find((t) => t.id === mobilePanel)?.label}
              </span>
              <button onClick={() => setMobilePanel(null)} className="p-1 text-slate-400" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
              {mobilePanel === 'tools' && toolsPanel}
              {mobilePanel === 'indicators' && <div className="flex flex-wrap gap-2">{indicatorChips}</div>}
              {mobilePanel === 'watchlist' && watchlistPanel}
              {mobilePanel === 'objects' && objectTreePanel}
              {mobilePanel === 'replay' &&
                (isReplayMode ? (
                  <div className="text-sm text-slate-400">Replay is running; use the controls at the top.</div>
                ) : (
                  replayPicker
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
