// A row of "press the meter's front-panel button remotely" actions. The engine reports which
// controls the connected driver honors (meter.controls); we render one button per supported
// control in a sensible fixed order with friendly labels. Distinct from the client-side display
// "Hold" toggle in App — these write a command to the physical meter.

import type { MeterControl } from '@ble-multimeter/react';

// Display label + ordering for every known control. Render order follows this list; unknown/
// unsupported controls are simply skipped.
const LABELS: { key: MeterControl; label: string; title: string }[] = [
  { key: 'select', label: 'Select', title: 'Cycle the function / measurement mode' },
  { key: 'range', label: 'Range', title: 'Step the manual range' },
  { key: 'rangeAuto', label: 'Auto', title: 'Toggle auto-ranging' },
  { key: 'hold', label: 'Hold', title: 'Toggle the meter’s data hold' },
  { key: 'rel', label: 'REL', title: 'Toggle relative (delta) mode' },
  { key: 'maxMin', label: 'Max/Min', title: 'Enter / cycle MAX/MIN' },
  { key: 'hzDuty', label: 'Hz/%', title: 'Toggle frequency / duty-cycle readout' },
  { key: 'backlight', label: 'Light', title: 'Toggle the backlight' },
];

interface Props {
  controls: MeterControl[];
  onPress: (control: MeterControl) => void;
}

export function MeterControls({ controls, onPress }: Props) {
  const available = LABELS.filter(c => controls.includes(c.key));
  if (available.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-1.5"
      role="group"
      aria-label="Meter buttons"
    >
      <span className="mr-1 text-xs uppercase tracking-wider text-zinc-500">Meter</span>
      {available.map(c => (
        <button
          key={c.key}
          onClick={() => onPress(c.key)}
          title={c.title}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 active:bg-zinc-700"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
