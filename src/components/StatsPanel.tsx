// Statistics for the live window or a reopened session (PLAN §3.2): min / max / avg /
// peak-to-peak / stddev / count / duration / current. This is the meter's MIN/MAX/REL,
// but better — and reset-able on demand. Values are in the normalized base unit (same as
// the chart) so they stay consistent across range changes.

import type { Stats } from '../lib/stats';

interface Props {
  stats: Stats;
  unit: string; // base unit, e.g. "Ω", "V"
  durationMs: number;
  onReset?: () => void;
}

function fmt(v: number | null, unit: string): string {
  if (v === null) return '—';
  const abs = Math.abs(v);
  // Keep it readable across the huge dynamic range of base units (mV → MΩ).
  const s =
    abs !== 0 && (abs >= 1e6 || abs < 1e-3)
      ? v.toExponential(3)
      : Number(v.toPrecision(5)).toString();
  return unit ? `${s} ${unit}` : s;
}

function dur(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-lg bg-zinc-900 px-3 py-2">
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <span className="font-mono text-sm tabular-nums text-zinc-100">{value}</span>
    </div>
  );
}

export function StatsPanel({ stats, unit, durationMs, onReset }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Statistics</h2>
        {onReset && (
          <button
            onClick={onReset}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Reset
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Current" value={fmt(stats.last, unit)} />
        <Stat label="Min" value={fmt(stats.min, unit)} />
        <Stat label="Max" value={fmt(stats.max, unit)} />
        <Stat label="Average" value={fmt(stats.avg, unit)} />
        <Stat label="Peak-peak" value={fmt(stats.p2p, unit)} />
        <Stat label="Std dev" value={fmt(stats.stddev, unit)} />
        <Stat label="Samples" value={`${stats.count}${stats.nullCount ? ` (+${stats.nullCount} OL)` : ''}`} />
        <Stat label="Duration" value={dur(durationMs)} />
      </div>
    </div>
  );
}
