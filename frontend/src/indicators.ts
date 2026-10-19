import { registerIndicator, IndicatorTemplate, KLineData } from 'klinecharts';

// Custom indicators on top of klinecharts' built-ins.

// Rolling simple average of closes; undefined until there are n bars
function rollingSma(data: KLineData[], n: number) {
  let sum = 0;
  return data.map((k, i) => {
    sum += k.close;
    if (i >= n) sum -= data[i - n].close;
    return i >= n - 1 ? sum / n : undefined;
  });
}

// The 125-day moving average itself, drawn on the price chart
const sma125: IndicatorTemplate = {
  name: 'SMA125',
  shortName: 'SMA',
  calcParams: [125],
  precision: 2,
  figures: [{ key: 'sma', title: 'SMA125: ', type: 'line' }],
  styles: { lines: [{ color: '#f59e0b', size: 2, style: 'solid' as any, smooth: false, dashedValue: [] }] },
  calc: (data, indicator) => rollingSma(data, indicator.calcParams[0] as number).map((v) => ({ sma: v })),
};

// Market momentum: % the close sits above (+) or below (-) its 125-day moving average
const mom125: IndicatorTemplate = {
  name: 'MOM125',
  shortName: 'MOM125',
  calcParams: [125],
  precision: 2,
  figures: [
    {
      key: 'mom',
      title: 'vs 125d MA %: ',
      type: 'bar',
      baseValue: 0,
      styles: (data) => {
        const v = (data.current.indicatorData as { mom?: number } | undefined)?.mom ?? 0;
        const color = v >= 0 ? 'rgba(8, 153, 129, 0.7)' : 'rgba(242, 54, 69, 0.7)';
        return { color, borderColor: color };
      },
    },
  ],
  calc: (data, indicator) => {
    const n = indicator.calcParams[0] as number;
    const avg = rollingSma(data, n);
    return data.map((k, i) => (avg[i] === undefined ? {} : { mom: (k.close / avg[i]! - 1) * 100 }));
  },
};

let registered = false;
export function registerCustomIndicators() {
  if (registered) return;
  registered = true;
  [sma125, mom125].forEach((t) => registerIndicator(t));
}
