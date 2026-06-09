// The meter card's annunciator strip — reflects the meter's current settings the way an LCD's
// status legends do: the active mode (e.g. "DC Voltage", clarifying what SELECT landed on) on the
// left, and the toggle states (AUTO range, HOLD, REL, MAX, MIN) on the right, lit when engaged and
// dimmed when not. So you can *see* that HOLD is on, not just press it.

import type { ReactNode } from 'react';
import { modeLabel, type Reading } from '@ble-multimeter/protocol';

function Ann({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className={on ? 'text-emerald-400' : 'text-zinc-700'} aria-hidden={!on}>
      {children}
    </span>
  );
}

export function Annunciators({ reading }: { reading: Reading }) {
  const f = reading.flags;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-xs font-medium text-zinc-300">{modeLabel(reading)}</span>
      <div className="flex shrink-0 gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
        <Ann on={f.auto}>Auto</Ann>
        <Ann on={f.hold}>Hold</Ann>
        <Ann on={f.rel}>REL</Ann>
        <Ann on={f.max || f.peakMax}>Max</Ann>
        <Ann on={f.min || f.peakMin}>Min</Ann>
        {f.hvWarning && <span className="text-red-500">⚡HV</span>}
      </div>
    </div>
  );
}
