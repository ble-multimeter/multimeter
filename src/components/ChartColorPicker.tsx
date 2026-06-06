// Chart line-color picker (PLAN §6 QoL): a single swatch button in the header that opens a
// small popover of preset swatches. Kept to one button wide so it sits comfortably in the
// top bar on phone and desktop alike. Closes on selection, Escape, or an outside click.
import { useEffect, useRef, useState } from 'react';
import { CHART_COLORS, resolveStroke } from '../lib/chartColors';

export function ChartColorPicker({
  value,
  onChange,
  dark,
}: {
  value: string;
  onChange: (key: string) => void;
  dark: boolean;
}) {
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

  return (
    <div ref={ref} className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Chart line color"
        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-zinc-800"
      >
        <span
          aria-hidden="true"
          className="h-4 w-4 rounded-full ring-1 ring-zinc-600"
          style={{ backgroundColor: resolveStroke(value, dark) }}
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Chart color"
          className="absolute right-0 z-50 mt-1 flex gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-2 shadow-xl"
        >
          {CHART_COLORS.map((c) => {
            const selected = c.key === value;
            return (
              <button
                key={c.key}
                role="menuitemradio"
                aria-checked={selected}
                aria-label={c.label}
                title={c.label}
                onClick={() => {
                  onChange(c.key);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-full ${
                  selected ? 'ring-2 ring-zinc-100' : 'ring-1 ring-zinc-700 hover:ring-zinc-500'
                }`}
                style={{ backgroundColor: dark ? c.dark : c.light }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
