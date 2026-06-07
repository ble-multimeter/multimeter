// Annunciator badges mirroring the meter's LCD indicators. Quiet badges for normal
// modes; low-battery and HV-warning render as prominent alerts (PLAN §3.2).
import type { Reading } from '../ble/types';

function Badge({
  children,
  tone = 'quiet',
}: {
  children: React.ReactNode;
  tone?: 'quiet' | 'alert';
}) {
  const cls =
    tone === 'alert'
      ? 'bg-red-500/20 text-red-700 ring-1 ring-red-500/40 dark:text-red-300'
      : 'bg-zinc-700/60 text-zinc-300 ring-1 ring-zinc-600/50';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

export function FlagBadges({ reading }: { reading: Reading }) {
  const f = reading.flags;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {reading.acdc && <Badge>{reading.acdc}</Badge>}
      {f.auto && <Badge>AUTO</Badge>}
      {f.hold && <Badge>HOLD</Badge>}
      {f.rel && <Badge>REL</Badge>}
      {f.max && <Badge>MAX</Badge>}
      {f.min && <Badge>MIN</Badge>}
      {f.peakMax && <Badge>PEAK&nbsp;MAX</Badge>}
      {f.peakMin && <Badge>PEAK&nbsp;MIN</Badge>}
      {f.lowBattery && <Badge tone="alert">▼&nbsp;BATTERY</Badge>}
      {f.hvWarning && <Badge tone="alert">⚠&nbsp;HIGH&nbsp;VOLTAGE</Badge>}
    </div>
  );
}
