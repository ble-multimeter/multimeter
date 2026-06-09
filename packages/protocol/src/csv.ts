// Session → CSV (PLAN §5, plan-7.md §3.4). Pure, tested. Operates on the full-resolution Readings
// as stored in IndexedDB — the decimated chart series is never involved (§3.3).
//
// **Long format (Phase 7, locked decision):** one row per sample with a `channel` column. Each
// channel keeps its own timestamp (no interpolation/forward-fill — faithful to each meter's
// independent cadence); rows are merge-sorted by `ts` across channels so the file reads
// chronologically. Single channel is just N=1 — no special case. Derived channels carry their
// label in `channel` and the formula in `function` (e.g. "P=V×I").
//
// The `segment` column uses the shared segment rule (segmentIndices) *within* each channel: range
// changes (kΩ↔MΩ) keep one segment, a mode / °C↔°F / AC↔DC change starts the next (PLAN §3.4).

import type { Reading } from './types';
import { segmentIndices } from './segments';

const COLUMNS = [
  'timestamp',
  'channel',
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

// One channel's readings for the CSV (the channel's display name + its full-resolution samples).
export interface CsvChannel {
  channel: string; // the `channel` column value (label, e.g. "V source" / "P")
  readings: Reading[];
}

// An internal flat row carrying its sort key (ts) and the channel label.
interface Row {
  ts: number;
  channel: string;
  segment: number;
  r: Reading;
}

/**
 * Long-format CSV across N channels. Each channel's readings are segmented independently; all rows
 * are then merge-sorted by timestamp so the file is chronological across channels. A stable
 * secondary sort by channel keeps same-`ts` rows from different channels in a deterministic order.
 */
export function toCsv(channels: CsvChannel[]): string {
  const lines = [COLUMNS.join(',')];

  const rows: Row[] = [];
  for (const { channel, readings } of channels) {
    const segs = segmentIndices(readings);
    readings.forEach((r, i) => rows.push({ ts: r.ts, channel, segment: segs[i]!, r }));
  }
  // Chronological across channels; ties broken by channel label (deterministic).
  rows.sort((a, b) => a.ts - b.ts || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));

  for (const { channel, segment, r } of rows) {
    lines.push(
      [
        cell(new Date(r.ts).toISOString()),
        cell(channel),
        cell(segment),
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
