import { registerOverlay, OverlayTemplate } from 'klinecharts';

// KLineChart v9 ships line/fib/annotation overlays, but not filled shapes.
// These register the shape tools used by the sidebar.

const SHAPE_STYLE = { style: 'stroke_fill' as const };

const rect: OverlayTemplate = {
  name: 'rect',
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  styles: { polygon: { color: 'rgba(41, 98, 255, 0.15)', borderColor: '#2962ff', borderSize: 1 } },
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    return [
      {
        type: 'polygon',
        attrs: { coordinates: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }] },
        styles: SHAPE_STYLE,
      },
    ];
  },
};

const circle: OverlayTemplate = {
  name: 'circle',
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  styles: { circle: { color: 'rgba(41, 98, 255, 0.15)', borderColor: '#2962ff', borderSize: 1 } },
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    const [c, edge] = coordinates;
    const r = Math.hypot(edge.x - c.x, edge.y - c.y);
    return [{ type: 'circle', attrs: { ...c, r }, styles: SHAPE_STYLE }];
  },
};

const triangle: OverlayTemplate = {
  name: 'triangle',
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  styles: { polygon: { color: 'rgba(41, 98, 255, 0.15)', borderColor: '#2962ff', borderSize: 1 } },
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    // While placing the 2nd point, show a line; close the triangle once 3 exist.
    if (coordinates.length === 2) {
      return [{ type: 'line', attrs: { coordinates } }];
    }
    return [{ type: 'polygon', attrs: { coordinates }, styles: SHAPE_STYLE }];
  },
};

const parallelogram: OverlayTemplate = {
  name: 'parallelogram',
  totalStep: 4,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  styles: { polygon: { color: 'rgba(41, 98, 255, 0.15)', borderColor: '#2962ff', borderSize: 1 } },
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) return [];
    if (coordinates.length === 2) {
      return [{ type: 'line', attrs: { coordinates } }];
    }
    // Fourth corner completes the parallelogram: D = A + (C - B)
    const [a, b, c] = coordinates;
    const d = { x: a.x + (c.x - b.x), y: a.y + (c.y - b.y) };
    return [{ type: 'polygon', attrs: { coordinates: [a, b, c, d] }, styles: SHAPE_STYLE }];
  },
};

// Half circle on the chord between the two clicks. The arc bulges toward the
// screen top ('north') or bottom ('south'), whatever the chord's tilt.
function halfCircle(name: string, side: 'north' | 'south'): OverlayTemplate {
  return {
    name,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    styles: { polygon: { color: 'rgba(41, 98, 255, 0.15)', borderColor: '#2962ff', borderSize: 1 } },
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      const [a, b] = coordinates;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const r = Math.hypot(b.x - a.x, b.y - a.y) / 2;
      if (r === 0) return [];
      const theta = Math.atan2(b.y - a.y, b.x - a.x);
      // Sweeping +π from the chord puts the arc's apex at theta + π/2; flip if that's the wrong side
      const apexY = cy + r * Math.sin(theta + Math.PI / 2);
      const apexIsUp = apexY < cy || (apexY === cy && side === 'north');
      const dir = (side === 'north') === apexIsUp ? 1 : -1;
      const steps = 48;
      const arc = [];
      for (let i = 0; i <= steps; i++) {
        const phi = theta + dir * (Math.PI * i) / steps;
        arc.push({ x: cx + r * Math.cos(phi), y: cy + r * Math.sin(phi) });
      }
      return [{ type: 'polygon', attrs: { coordinates: arc }, styles: SHAPE_STYLE }];
    },
  };
}

const halfCircleNorth = halfCircle('halfCircleNorth', 'north');
const halfCircleSouth = halfCircle('halfCircleSouth', 'south');

// Freehand stroke. Created in one go from a captured mouse path (see App's brush layer),
// never click-by-click. Points are anchored to a bar's timestamp plus `frac`, the
// offset in bars from it, because klinecharts snaps timestamps to whole bars.
const brush: OverlayTemplate = {
  name: 'brush',
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  styles: { line: { color: '#f59e0b', size: 2 } },
  createPointFigures: ({ overlay, coordinates, barSpace }) => {
    if (coordinates.length < 2) return [];
    const pts = coordinates.map((c, i) => ({
      x: c.x + ((overlay.points[i] as any)?.frac ?? 0) * barSpace.bar,
      y: c.y,
    }));
    return [{ type: 'line', attrs: { coordinates: pts } }];
  },
};

let registered = false;

export function registerTradingViewOverlays() {
  if (registered) return;
  registered = true;
  [rect, circle, halfCircleNorth, halfCircleSouth, triangle, parallelogram, brush].forEach((t) => registerOverlay(t));
}
