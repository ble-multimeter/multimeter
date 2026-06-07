// Pin session UI (per-item capture). The Pin button captures the current reading into the
// active pin session (auto-starting one on the first pin); Stop finalizes it. A pin session
// is a normal recording, so the finished result lives in Recordings — this panel is just the
// live capture controls plus a running list and the match-spread ("are these matched?") answer.
import type { Reading } from '../ble/types';
import type { PinSession as PinSessionState } from '../hooks/usePinSession';
import { toCsv } from '../lib/csv';
import { downloadText, slug } from '../lib/download';

function fmtNum(v: number): string {
  const abs = Math.abs(v);
  return abs !== 0 && (abs >= 1e6 || abs < 1e-3)
    ? v.toExponential(3)
    : Number(v.toPrecision(5)).toString();
}

// Spread across the numeric captures, on baseValue so a range change mid-batch doesn't skew it.
function matchSummary(readings: Reading[]): { range: number; pct: number; unit: string } | null {
  const vals = readings.filter((r) => r.baseValue !== null).map((r) => r.baseValue as number);
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    range: max - min,
    pct: mean !== 0 ? ((max - min) / Math.abs(mean)) * 100 : 0,
    unit: readings.find((r) => r.baseValue !== null)!.baseUnit,
  };
}

export function PinSession({
  state,
  onPin,
  canPin,
}: {
  state: PinSessionState;
  onPin: () => void;
  canPin: boolean;
}) {
  const { active, readings, undoLast, stop } = state;
  const summary = matchSummary(readings);

  const exportCsv = () => downloadText(toCsv(readings), `${slug('pins')}-${readings.length}.csv`);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onPin}
          disabled={!canPin}
          className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-semibold text-sky-950 hover:bg-sky-400 disabled:opacity-40"
        >
          📌 Pin <span className="font-normal opacity-70">(space)</span>
        </button>

        <span className="text-sm text-zinc-400" role="status">
          {active ? `Pin session · ${readings.length} captured` : 'No active pin session'}
          {summary && (
            <span className="ml-2 text-zinc-500">
              · spread {fmtNum(summary.range)} {summary.unit} ({summary.pct.toFixed(2)}%)
            </span>
          )}
        </span>

        {active && (
          <div className="ml-auto flex gap-1.5">
            <button
              onClick={undoLast}
              disabled={readings.length === 0}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            >
              Undo
            </button>
            <button
              onClick={exportCsv}
              disabled={readings.length === 0}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            >
              CSV
            </button>
            <button
              onClick={stop}
              className="rounded-md bg-zinc-200 px-2.5 py-1 text-xs font-semibold text-zinc-900 hover:bg-white"
            >
              ■ Stop
            </button>
          </div>
        )}
      </div>

      {active && readings.length > 0 && (
        <ol className="flex max-h-48 flex-col gap-1 overflow-auto">
          {readings.map((r, i) => (
            <li
              key={i}
              className="flex items-center gap-3 rounded-md bg-zinc-900 px-2.5 py-1.5 text-sm"
            >
              <span className="w-6 shrink-0 text-right font-mono text-xs text-zinc-500">
                {i + 1}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-zinc-100">
                {r.overload ? 'OL' : r.displayText || '—'}
                {r.displayUnit && <span className="ml-1 text-zinc-400">{r.displayUnit}</span>}
              </span>
              <span className="shrink-0 text-xs uppercase tracking-wider text-zinc-500">
                {r.function}
                {r.acdc ? ` ${r.acdc}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
