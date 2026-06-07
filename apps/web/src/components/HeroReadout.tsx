// The hero readout: the value, large, exactly as the LCD shows it (PLAN §3.2).
// Overload renders as "overload", not a fake number; NCV's strength bar shows its raw
// glyphs. Numeric values come straight from displayText so they always match the meter.
import type { Reading } from '../ble/types';
import { FlagBadges } from './FlagBadges';

export function HeroReadout({ reading, held = false }: { reading: Reading; held?: boolean }) {
  const { overload, displayText, displayUnit, function: fn } = reading;

  // What the big line shows: "overload" word, else the raw LCD text (number or NCV bar),
  // else an em dash placeholder.
  const isNumeric = reading.displayValue !== null;
  const main = overload ? 'OL' : displayText || '—';

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex items-center justify-center gap-2 text-sm font-semibold uppercase tracking-widest text-zinc-400">
        {fn}
        {held && (
          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs tracking-wider text-amber-700 ring-1 ring-amber-500/40 dark:text-amber-300">
            HOLD
          </span>
        )}
      </div>

      <div className="flex items-baseline justify-center gap-3">
        <span
          className={`font-mono font-bold leading-none tabular-nums ${
            overload ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-50'
          } text-[clamp(3.5rem,18vw,11rem)]`}
        >
          {main}
        </span>
        {displayUnit && (
          <span className="text-[clamp(1.5rem,6vw,3.5rem)] font-semibold text-zinc-400">
            {displayUnit}
          </span>
        )}
      </div>

      {overload && (
        <div className="text-sm font-medium uppercase tracking-widest text-amber-600 dark:text-amber-400/80">
          overload
        </div>
      )}
      {!overload && !isNumeric && displayText && (
        <div className="text-sm uppercase tracking-widest text-zinc-500">non-contact</div>
      )}

      <FlagBadges reading={reading} />
    </div>
  );
}
