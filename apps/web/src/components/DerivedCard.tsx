// One derived channel's card (Phase 7, plan-7.md §6): the label, the live synthesized value, the
// formula (e.g. "P=V×I"), and a "stale" badge when an input lagged or went non-live. The value is a
// gap (—) when stale or any input is OL. Remove drops the derived channel.

import type { DerivedChannel, Meters } from '@ble-multimeter/react';
import { OP_SYMBOL } from '@ble-multimeter/protocol';

export function DerivedCard({ channel, meters }: { channel: DerivedChannel; meters: Meters }) {
  const r = channel.reading;
  // The input role labels, so the formula reads in domain terms (V × I, not opaque ids).
  const roleOf = (id: string) =>
    meters.meters.find(m => m.id === id)?.role ??
    meters.derived.find(d => d.id === id)?.label ??
    id;
  const formula = `${channel.label} = ${roleOf(channel.aChannelId)} ${OP_SYMBOL[channel.op]} ${roleOf(channel.bChannelId)}`;
  const value = r && r.baseValue !== null ? r.displayText : '—';
  // Prefer the auto-prefixed display unit (mW/kW) when there's a value; fall back to the SI unit.
  const unit = r && r.baseValue !== null ? r.displayUnit : channel.unit;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-violet-900/50 bg-violet-950/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-violet-300">{channel.label}</div>
          <div className="truncate text-xs text-zinc-500">{formula}</div>
        </div>
        <div className="flex items-center gap-1">
          {channel.stale && (
            <span
              className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-500/40 dark:text-amber-300"
              title="An input is not live or lagging — the derived value is held as a gap"
            >
              stale
            </span>
          )}
          <button
            onClick={() => meters.removeDerived(channel.id)}
            aria-label={`Remove ${channel.label}`}
            title="Remove derived channel"
            className="rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-3xl font-bold tabular-nums text-zinc-50">{value}</span>
        {unit && <span className="text-lg text-zinc-400">{unit}</span>}
      </div>
    </div>
  );
}
