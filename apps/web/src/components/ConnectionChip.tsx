// Connection UI: a status cluster that doubles as the connect/disconnect control, shown in each
// meter card's header (PLAN §3.2). The colored status dot is decorative — the state is always also
// spelled out in text for AT users. (Backlight moved to the MeterControls "Light" button, so the
// old per-device kebab menu is gone.)
import type { Meter, MeterState } from '@ble-multimeter/react';

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
        <span className="text-sm font-semibold text-zinc-200">{deviceName ?? 'Multimeter'}</span>
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
