// The multi-series time-series chart (Phase 7, plan-7.md §6). uPlot (canvas) with N series — one
// per channel (meter + derived) — grouped onto shared y-scales by baseUnit (the power demo has V,
// A, W → 3 scales/axes; uPlot supports N). Channels tick on independent clocks, so they almost
// never share a timestamp; uPlot needs ONE aligned x, so we use the sorted union of all channels'
// timestamps and *linearly interpolate* each channel onto it (see buildData). Interpolation only
// re-samples the polyline a line chart already draws between a channel's own points — no value is
// invented beyond it — and it's render-only (CSV still reads full resolution from IndexedDB, §3.3).
//
// Overload / non-numeric / stale samples are nulls → real gaps (not zeros, not bridged): a grid
// point is null wherever the channel has no sample yet (before its first / after its last) or sits
// between two samples one of which is null. Decimation is a render concern only. Replaces the
// single-series LiveChart for both live and the read-only session viewer.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import type { AlignedData, Axis, Options, Scale, Series } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { decimate } from '@ble-multimeter/protocol';
import type { Sample } from '@ble-multimeter/protocol';

const MAX_POINTS = 2000; // render cap per channel; full resolution lives in IndexedDB

const WINDOWS: { label: string; ms: number | null }[] = [
  { label: 'Fit all', ms: null },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '30m', ms: 1_800_000 },
];

// A channel to plot: a label, its base unit (for axis grouping), its samples, and a stroke color.
export interface ChartSeries {
  id: string;
  label: string;
  unit: string; // baseUnit — series sharing a unit share a y-scale/axis
  color: string;
  samples: Sample[];
}

export interface MultiChartHandle {
  toPng: () => Promise<Blob | null>;
}

interface Props {
  series: ChartSeries[];
  dark?: boolean;
  height?: number;
  truncated?: boolean;
}

// Theme-derived chart chrome colors (axis/grid/bg). Series colors come from each ChartSeries.
const chrome = (dark: boolean) =>
  dark
    ? { grid: '#27272a', text: '#71717a', bg: '#09090b' }
    : { grid: '#e4e4e7', text: '#52525b', bg: '#ffffff' };

// Resample one channel's (sorted, decimated) samples onto the shared union grid `xs` by linear
// interpolation. A grid point is:
//   • null  — before the channel's first sample or after its last (it has no reading there yet);
//   • the own value — at an exact own timestamp (may itself be null for OL/stale);
//   • null  — when it falls between two own samples and either bracket is null (a real gap that
//             must not be bridged across an overload/stale run);
//   • the linear interpolation of the two bracketing own values otherwise.
// xs and d are both ascending, so a single forward-moving cursor walks them in O(n+m).
function resampleOntoGrid(d: Sample[], xs: number[]): (number | null)[] {
  const row = new Array<number | null>(xs.length).fill(null);
  if (d.length === 0) return row;
  const first = d[0]!.t;
  const last = d[d.length - 1]!.t;
  let j = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (x < first || x > last) continue; // outside this channel's range → gap
    while (j < d.length - 1 && d[j + 1]!.t <= x) j++;
    const lo = d[j]!;
    if (lo.t === x) {
      row[i] = lo.v;
      continue;
    }
    const hi = d[j + 1]!;
    if (lo.v === null || hi.v === null) continue; // straddles a gap → stay null
    row[i] = lo.v + (hi.v - lo.v) * ((x - lo.t) / (hi.t - lo.t));
  }
  return row;
}

// Build uPlot AlignedData from N channels with independent timestamps: the x axis is the sorted
// union of every channel's sample times; each channel's y row is interpolated onto it so its line
// connects between its own points (instead of being a field of disconnected dots) while genuine
// OL/stale samples remain gaps. See the file header.
function buildData(series: ChartSeries[]): AlignedData {
  // Decimate each channel first (render cap), then union the timestamps.
  const decimated = series.map(s => decimate(s.samples, MAX_POINTS));
  const tset = new Set<number>();
  for (const d of decimated) for (const s of d) tset.add(s.t);
  const xs = [...tset].sort((a, b) => a - b);
  const rows = decimated.map(d => resampleOntoGrid(d, xs));
  return [xs.map(t => t / 1000), ...rows] as AlignedData;
}

// uPlot axis sides: 0 top, 1 right, 2 bottom, 3 left. y-axes alternate left/right.
type Side = 1 | 3;

// Assign each distinct unit a y-scale key ('y', 'y1', 'y2', …) and a side (alternating left/right).
function unitScales(series: ChartSeries[]): Map<string, { scaleKey: string; side: Side }> {
  const map = new Map<string, { scaleKey: string; side: Side }>();
  let n = 0;
  for (const s of series) {
    if (map.has(s.unit)) continue;
    const scaleKey = n === 0 ? 'y' : `y${n}`;
    map.set(s.unit, { scaleKey, side: n % 2 === 0 ? 3 : 1 }); // left then right
    n += 1;
  }
  return map;
}

export const MultiChart = forwardRef<MultiChartHandle, Props>(function MultiChart(
  { series, dark = true, height = 280, truncated },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [windowMs, setWindowMs] = useState<number | null>(null);

  const seriesRef = useRef(series);
  seriesRef.current = series;
  const windowMsRef = useRef(windowMs);
  windowMsRef.current = windowMs;

  // A structural key so the plot is rebuilt only when the *shape* (channels / units / colors)
  // changes, not on every sample tick (those just push new data).
  const shapeKey = useMemo(
    () => series.map(s => `${s.id}:${s.unit}:${s.color}:${s.label}`).join('|'),
    [series],
  );

  // (Re)create the plot when the theme or the series shape changes. uPlot has no restyle API, so a
  // rebuild is the clean way to repaint axes/series; repopulate from the ref so it isn't blank.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cur = seriesRef.current;
    const C = chrome(dark);
    const scales = unitScales(cur);

    // Series: index 0 is x; then one per channel, each on its unit's y-scale.
    const uSeries: Series[] = [
      {},
      ...cur.map(s => ({
        label: s.label,
        stroke: s.color,
        width: 2,
        spanGaps: false,
        points: { show: false },
        scale: scales.get(s.unit)!.scaleKey,
      })),
    ];

    // Axes: x, then one per distinct unit (labelled with the unit, placed left/right alternately).
    const uScales: Record<string, Scale> = { x: { time: true } };
    const uAxes: Axis[] = [
      { stroke: C.text, grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.grid } },
    ];
    for (const [unit, { scaleKey, side }] of scales) {
      uScales[scaleKey] = { auto: true };
      const axis: Axis = {
        scale: scaleKey,
        side,
        stroke: C.text,
        grid: { stroke: C.grid, width: 1 },
        ticks: { stroke: C.grid },
        size: 56,
      };
      if (unit) axis.label = unit;
      uAxes.push(axis);
    }

    const opts: Options = {
      width: host.clientWidth || 600,
      height,
      padding: [12, 8, 0, 0],
      cursor: { y: false },
      legend: { show: cur.length > 1 }, // a legend only earns its space with 2+ series
      scales: uScales,
      axes: uAxes,
      series: uSeries,
    };

    const u = new uPlot(opts, buildData(cur), host);
    plotRef.current = u;
    applyWindow(u, windowMsRef.current);

    const ro = new ResizeObserver(() => u.setSize({ width: host.clientWidth, height }));
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [dark, height, shapeKey]);

  // Feed data on sample change.
  useEffect(() => {
    const u = plotRef.current;
    if (!u) return;
    u.setData(buildData(series), windowMs == null);
    applyWindow(u, windowMs);
  }, [series, windowMs]);

  useImperativeHandle(ref, () => ({
    toPng: () =>
      new Promise<Blob | null>(resolve => {
        const u = plotRef.current;
        if (!u) return resolve(null);
        const src = u.ctx.canvas;
        const out = document.createElement('canvas');
        out.width = src.width;
        out.height = src.height;
        const ctx = out.getContext('2d')!;
        ctx.fillStyle = chrome(dark).bg;
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(src, 0, 0);
        out.toBlob(b => resolve(b), 'image/png');
      }),
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {series.map(s => (
            <span key={s.id} className="inline-flex items-center gap-1.5 text-zinc-400">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
              {s.unit ? ` (${s.unit})` : ''}
            </span>
          ))}
          {truncated && <span className="text-amber-500/80">showing last {MAX_POINTS} pts</span>}
        </div>
        <div className="flex gap-1" role="group" aria-label="Chart time window">
          {WINDOWS.map(w => (
            <button
              key={w.label}
              onClick={() => setWindowMs(w.ms)}
              aria-pressed={windowMs === w.ms}
              className={`rounded px-2 py-0.5 text-xs ${
                windowMs === w.ms
                  ? 'bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500/40 dark:text-emerald-300'
                  : 'text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={hostRef}
        className="w-full"
        role="img"
        aria-label={`Time-series chart of ${series.map(s => s.label).join(', ') || 'no channels'}`}
      />
    </div>
  );
});

// Apply the visible-window choice to the x scale (or autoscale for "fit all").
function applyWindow(u: uPlot, windowMs: number | null): void {
  const xs = u.data[0];
  if (windowMs == null || !xs || xs.length === 0) return;
  const max = xs[xs.length - 1]!;
  u.setScale('x', { min: max - windowMs / 1000, max });
}
