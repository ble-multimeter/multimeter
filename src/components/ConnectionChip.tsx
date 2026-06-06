// Connection UI: a status cluster (which doubles as the connect/disconnect control) plus a
// per-device options menu, laid out in the top bar alongside the view tabs (PLAN §3.2). The
// colored status dot is decorative — the state is always also spelled out in text for AT users.
import { useEffect, useRef, useState } from 'react';
import type { Meter, MeterState } from '../hooks/useMeter';

const STATE_LABEL: Record<MeterState, string> = {
  unsupported: 'unsupported',
  idle: 'not connected',
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  disconnected: 'disconnected',
  error: 'error',
};

const DOT: Record<MeterState, string> = {
  unsupported: 'bg-zinc-500',
  idle: 'bg-zinc-500',
  connecting: 'bg-amber-400 animate-pulse',
  live: 'bg-emerald-400',
  reconnecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-red-400',
  error: 'bg-red-500',
};

// The one connection action available in a given state, or null while busy (connecting /
// reconnecting) or unsupported. Shared by the clickable status and App's `c` shortcut so the
// two can't drift. Disconnect keeps recorded data (PLAN §3.1), so a stray click is recoverable.
export function connectionAction(meter: Meter): { run: () => void; verb: string } | null {
  switch (meter.state) {
    case 'idle':
      return { run: meter.connect, verb: 'Connect' };
    case 'disconnected':
    case 'error':
      return { run: meter.reconnect, verb: 'Reconnect' };
    case 'live':
      return { run: meter.disconnect, verb: 'Disconnect' };
    default:
      return null;
  }
}

// The status cluster doubles as the connect/disconnect control: clicking it runs the action
// for the current state (the verb pill spells out what a click does). While busy it's a plain,
// non-interactive readout. The old separate Connect/Reconnect/Disconnect buttons are gone —
// they duplicated the state already shown here.
export function ConnectionStatus({ meter }: { meter: Meter }) {
  const { state, deviceName, reading } = meter;
  const action = connectionAction(meter);

  const inner = (
    <>
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[state]}`} aria-hidden="true" />
      <div className="flex flex-col text-left leading-tight">
        <span className="text-sm font-semibold text-zinc-200">{deviceName ?? 'UT60BT'}</span>
        <span className="text-xs text-zinc-400">{STATE_LABEL[state]}</span>
      </div>

      {reading?.flags.lowBattery && (
        <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-500/40 dark:text-red-300">
          ▼ BATTERY
        </span>
      )}
    </>
  );

  if (!action) {
    return <div className="flex items-center gap-3 px-2 py-1">{inner}</div>;
  }

  return (
    <button
      onClick={action.run}
      aria-label={`${action.verb} the meter`}
      title={`${action.verb} the meter`}
      className="flex items-center gap-3 rounded-md px-2 py-1 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-emerald-500"
    >
      {inner}
      <span
        aria-hidden="true"
        className="ml-1 rounded border border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-300"
      >
        {action.verb}
      </span>
    </button>
  );
}

// Per-device options menu (live only): a kebab next to the status holding meter commands —
// currently just Backlight (the one control the meter honors, §PROTOCOL 2). Sits under the
// connected device rather than cluttering the global actions cluster. Closes on selection,
// Escape, or an outside click.
export function DeviceMenu({ meter }: { meter: Meter }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  if (meter.state !== 'live') return null;

  return (
    <div ref={ref} className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Device options"
        className="rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-50 mt-1 min-w-36 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-xl"
        >
          <button
            role="menuitem"
            onClick={() => {
              meter.toggleBacklight();
              setOpen(false);
            }}
            className="block w-full rounded px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Backlight
          </button>
        </div>
      )}
    </div>
  );
}
