// One meter channel's card (Phase 7, plan-7.md §6): an editable role/label, the live value, a
// connection status that doubles as the connect/disconnect control, the meter's front-panel
// controls, and a remove button. The card backs a MeterSession (via the MetersSession coordinator),
// so connect/reconnect/disconnect/controls drive the real (or demo) connection. Reuses the existing
// ConnectionStatus + MeterControls by adapting the channel + session into a Meter shape. (Backlight
// now lives in the MeterControls "Light" button, so the old per-card kebab/DeviceMenu is gone.)

import { useState } from 'react';
import type { MeterChannel, Meters } from '@ble-multimeter/react';
import type { Meter, MeterControl } from '@ble-multimeter/react';
import { gaugeFraction, gaugeFullScale } from '@ble-multimeter/protocol';
import { ConnectionStatus } from './ConnectionChip';
import { MeterControls } from './MeterControls';
import { DialGauge } from './DialGauge';
import { Annunciators } from './Annunciators';

// Adapt a MeterChannel + its backing session into the `Meter` shape ConnectionStatus/MeterControls
// expect, so those components are reused unchanged across one-or-many meters.
function asMeter(channel: MeterChannel, meters: Meters): Meter {
  const session = meters.meterSession(channel.id);
  return {
    state: channel.state,
    reading: channel.reading,
    deviceName: channel.deviceName,
    error: channel.error,
    controls: channel.controls,
    connect: () => session?.connect(),
    reconnect: () => session?.reconnect(),
    disconnect: () => session?.disconnect(),
    toggleBacklight: () => session?.toggleBacklight(),
    sendControl: name => session?.sendControl(name),
  };
}

export function MeterCard({
  channel,
  meters,
  removable,
}: {
  channel: MeterChannel;
  meters: Meters;
  removable: boolean;
}) {
  const meter = asMeter(channel, meters);
  const [editing, setEditing] = useState(false);
  const [dial, setDial] = useState(false);
  // The dial panel's "backlight" (cream → blue): each in-app "Light" press flips our own belief.
  // The meter doesn't report its real backlight state in its data frames, so this can fall out of
  // step with the device's physical Light button — an accepted limitation (no telemetry to sync to).
  const [backlight, setBacklight] = useState(false);
  const onControl = (c: MeterControl) => {
    if (c === 'backlight') setBacklight(b => !b);
    meter.sendControl(c);
  };
  const r = channel.reading;
  const value = r ? (r.overload ? 'OL' : r.displayText || '—') : '—';
  const hasReading = !!r;
  // Numeric readings get the 7-segment LCD face; OL / — / NCV text has no DSEG7 glyphs, so it
  // stays in mono (and gets no ghost backplane). displayText already carries the range's decimals.
  const isSeg = !!r && !r.overload && r.displayValue !== null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      {/* Card header IS the connection info (device · state · connect/disconnect). The old role
          title row is gone — a fresh real meter's role is just "Meter", redundant with the device
          name. Rename (pencil), dial toggle, and remove ride on the right as icons; renaming swaps
          the connection cluster for an inline input. */}
      <div className="flex items-center gap-0.5">
        {editing ? (
          <input
            autoFocus
            defaultValue={channel.role}
            aria-label="Channel role"
            onBlur={e => {
              meters.setMeterRole(channel.id, e.target.value.trim() || channel.role);
              setEditing(false);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-sm text-zinc-100"
          />
        ) : (
          <div className="-ml-2 min-w-0 flex-1">
            <ConnectionStatus meter={meter} />
          </div>
        )}
        {hasReading && (
          <button
            onClick={() => setDial(d => !d)}
            aria-pressed={dial}
            aria-label={dial ? 'Show digits' : 'Show analog dial'}
            title={dial ? 'Show digits' : 'Show analog dial'}
            className={`shrink-0 rounded-md p-1.5 hover:bg-zinc-800 ${
              dial ? 'text-emerald-400' : 'text-zinc-400'
            }`}
          >
            <GaugeIcon />
          </button>
        )}
        <button
          onClick={() => setEditing(true)}
          aria-label="Rename channel"
          title="Rename this channel"
          className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800"
        >
          <PencilIcon />
        </button>
        {removable && (
          <button
            onClick={() => meters.removeMeter(channel.id)}
            aria-label={`Remove ${channel.role}`}
            title="Remove channel"
            className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>

      {/* Dial view (above the reading when enabled): a big half-radial needle gauge on a warm
          "backlit LCD" panel — range-honored. The panel is a fixed light surface, so the gauge
          draws dark-on-cream (see DialGauge). */}
      {dial && r && (
        <div
          className={`mx-auto w-full max-w-[230px] rounded-lg px-3 pb-2 pt-3 ring-1 transition-[background-color,box-shadow] duration-300 ${
            backlight ? 'bg-[#bfe3fb] ring-sky-400/20' : 'bg-[#f4eeda] ring-amber-950/10'
          }`}
          style={{
            boxShadow: backlight
              ? 'inset 0 1px 4px rgba(30,80,140,0.18), 0 0 22px 2px rgba(110,195,255,0.55)'
              : 'inset 0 1px 4px rgba(120,100,40,0.18), 0 0 18px 1px rgba(245,232,185,0.35)',
          }}
        >
          <DialGauge
            fraction={gaugeFraction(r)}
            fullScale={gaugeFullScale(r)}
            unit={r.displayUnit}
            overload={r.overload}
          />
        </div>
      )}

      {/* Annunciator strip: current mode + lit toggle states (AUTO/HOLD/REL/MAX/MIN). */}
      {r && <Annunciators reading={r} />}

      <div className="flex items-baseline justify-center gap-2">
        {/* Segment readout: a dim "ghost" of all segments (every digit → 8) sits behind the live
            value at matching positions — the authentic dead-LCD look. Same font/size/spacing so
            the two layers register exactly. */}
        <span className="relative inline-block">
          {isSeg && (
            <span
              aria-hidden="true"
              className="absolute inset-0 select-none font-seg text-3xl font-bold tabular-nums text-zinc-50/[0.08]"
            >
              {value.replace(/\d/g, '8')}
            </span>
          )}
          <span
            className={`relative text-3xl font-bold tabular-nums ${
              isSeg ? 'font-seg' : 'font-mono'
            } ${r?.overload ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-50'}`}
          >
            {value}
          </span>
        </span>
        {r?.displayUnit && <span className="text-lg text-zinc-400">{r.displayUnit}</span>}
      </div>

      {channel.state === 'live' && channel.controls.length > 0 && (
        <MeterControls controls={meter.controls} onPress={onControl} />
      )}
    </div>
  );
}

// A small half-radial gauge glyph for the dial toggle (matches the DialGauge view it switches to).
function GaugeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M4 17a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <line
        x1={12}
        y1={17}
        x2={15.5}
        y2={11}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx={12} cy={17} r={1.6} fill="currentColor" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
      <path
        d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17.5V20z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}
