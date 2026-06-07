// Session → CSV (PLAN §5). Pure, tested. Operates on the full-resolution Readings as
// stored in IndexedDB — the decimated chart series is never involved (§3.3).
//
// The `segment` column is derived here by walking quantity-key transitions, so storage
// only has to persist plain Readings: range changes (kΩ↔MΩ) keep one segment, a mode /
// °C↔°F / AC↔DC change starts the next (PLAN §3.4).

import { quantityKey, type Reading } from '../ble/types';

const COLUMNS = [
  'timestamp',
  'segment',
  'function',
  'displayValue',
  'displayUnit',
  'baseValue',
  'baseUnit',
  'acdc',
  'overload',
  'hold',
  'rel',
  'max',
  'min',
  'auto',
] as const;

// Quote a field only when it needs it (comma, quote, CR/LF), doubling inner quotes.
function esc(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const cell = (v: string | number | boolean | null): string =>
  v === null ? '' : esc(typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

export function toCsv(readings: Reading[]): string {
  const lines = [COLUMNS.join(',')];

  let seg = 0;
  let prevKey: string | null = null;
  for (const r of readings) {
    const key = quantityKey(r);
    if (prevKey !== null && key !== prevKey) seg++;
    prevKey = key;

    lines.push(
      [
        cell(new Date(r.ts).toISOString()),
        cell(seg),
        cell(r.function),
        cell(r.displayValue),
        cell(r.displayUnit),
        cell(r.baseValue),
        cell(r.baseUnit),
        cell(r.acdc),
        cell(r.overload),
        cell(r.flags.hold),
        cell(r.flags.rel),
        cell(r.flags.max),
        cell(r.flags.min),
        cell(r.flags.auto),
      ].join(','),
    );
  }

  return lines.join('\r\n');
}
