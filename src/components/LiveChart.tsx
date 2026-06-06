// The live time-series chart (PLAN §3.2). uPlot (canvas) because it stays smooth on
// multi-hour streams where SVG libs choke. It plots the current segment's normalized
// baseValue vs time — range changes (kΩ↔MΩ) are a continuous curve, a quantity change
// starts a fresh segment (§3.4, handled upstream by useRecorder resetting `samples`).
// Overload / non-numeric samples are nulls → real gaps, not zeros. Decimation is a render
// concern only; CSV export reads full resolution from IndexedDB (§3.3).

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import uPlot from 'uplot';
import type { AlignedData, Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { decimate } from '../lib/decimate';
import type { Sample } from '../ble/types';
import type { SegmentInfo } from '../hooks/useRecorder';

const MAX_POINTS = 2000; // render cap; full resolution lives in IndexedDB

const WINDOWS: { label: string; ms: number | null }[] = [
  { label: 'Fit all', ms: null },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: '30m', ms: 1_800_000 },
];

export interface LiveChartHandle {
  toPng: () => Promise<Blob | null>;
}

interface Props {
  samples: Sample[];
  segment: SegmentInfo | null;
  truncated?: boolean;
  height?: number;
  dark?: boolean;
  strokeColor?: string;
}

// uPlot paints to a canvas, so its colors are JS, not Tailwind classes — they can't ride
// the CSS variable swap and must be chosen per theme here. `stroke` (the line) is overridable
// via the chart-color preference (already resolved per-theme by the caller); grid/text/bg
// stay theme-derived. The built-in default line goes a shade darker in light mode for
// contrast on white.
const colors = (dark: boolean, stroke?: string) => {
  const base = dark
    ? { stroke: '#34d399', grid: '#27272a', text: '#71717a', bg: '#09090b' }
    : { stroke: '#059669', grid: '#e4e4e7', text: '#52525b', bg: '#ffffff' };
  return stroke ? { ...base, stroke } : base;
};

// Push the current data into a plot instance, honoring the visible-window choice.
function draw(u: uPlot, samples: Sample[], windowMs: number | null) {
  const pts = decimate(samples, MAX_POINTS);
  const xs = pts.map((s) => s.t / 1000);
  const ys = pts.map((s) => s.v);
  const data: AlignedData = [xs, ys];
  if (windowMs == null || xs.length === 0) {
    u.setData(data); // fit all (autoscale x + y)
  } else {
    u.setData(data, false);
    const max = xs[xs.length - 1];
    u.setScale('x', { min: max - windowMs / 1000, max });
  }
}

export const LiveChart = forwardRef<LiveChartHandle, Props>(function LiveChart(
  { samples, segment, truncated, height = 280, dark = true, strokeColor },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [windowMs, setWindowMs] = useState<number | null>(null);

  // Latest data/window for the (re)build effect, which can't depend on them directly
  // without recreating the plot on every sample.
  const samplesRef = useRef(samples);
  samplesRef.current = samples;
  const windowMsRef = useRef(windowMs);
  windowMsRef.current = windowMs;

  // Create the plot, and recreate it on a theme change (uPlot has no public restyle API,
  // so a rebuild is the clean way to repaint axes/series in the new colors). Repopulate
  // from the refs so the rebuilt chart isn't blank until the next sample.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const C = colors(dark, strokeColor);

    const opts: Options = {
      width: host.clientWidth || 600,
      height,
      padding: [12, 12, 0, 0],
      cursor: { y: false },
      legend: { show: false },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [
        { stroke: C.text, grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.grid } },
        {
          stroke: C.text,
          grid: { stroke: C.grid, width: 1 },
          ticks: { stroke: C.grid },
          size: 56,
        },
      ],
      series: [{}, { stroke: C.stroke, width: 2, spanGaps: false, points: { show: false } }],
    };

    const u = new uPlot(opts, [[], []], host);
    plotRef.current = u;
    draw(u, samplesRef.current, windowMsRef.current);

    const ro = new ResizeObserver(() => u.setSize({ width: host.clientWidth, height }));
    ro.observe(host);
    return () => {
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [height, dark, strokeColor]);

  // Feed data on change.
  useEffect(() => {
    const u = plotRef.current;
    if (u) draw(u, samples, windowMs);
  }, [samples, windowMs]);

  useImperativeHandle(ref, () => ({
    toPng: () =>
      new Promise<Blob | null>((resolve) => {
        const u = plotRef.current;
        if (!u) return resolve(null);
        // uPlot draws everything to one canvas; composite it over the page bg so the PNG
        // isn't transparent.
        const src = u.ctx.canvas;
        const out = document.createElement('canvas');
        out.width = src.width;
        out.height = src.height;
        const ctx = out.getContext('2d')!;
        ctx.fillStyle = colors(dark).bg;
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(src, 0, 0);
        out.toBlob((b) => resolve(b), 'image/png');
      }),
  }));

  const unit = segment?.unit ? ` (${segment.unit})` : '';
  const label = segment ? `${segment.function}${segment.acdc ? ' ' + segment.acdc : ''}${unit}` : '—';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {label}
          {truncated && (
            <span className="ml-2 font-normal normal-case text-amber-500/80">
              showing last {MAX_POINTS} pts
            </span>
          )}
        </div>
        <div className="flex gap-1" role="group" aria-label="Chart time window">
          {WINDOWS.map((w) => (
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
      <div ref={hostRef} className="w-full" role="img" aria-label={`Time-series chart of ${label}`} />
    </div>
  );
});
