// Shared types and the protocol's lookup tables. Pure data + tiny pure helpers — no
// BLE, no React — so decode.ts (and its tests) can import this in plain Node.
// See PROTOCOL.md §3-4.

export interface Reading {
  ts: number; // capture time (ms epoch)
  function: string; // "DCV", "OHM", … (or "#<n>" for an unknown code)
  displayText: string; // raw LCD string, trimmed: "1.002", "OL", "EFLO"
  displayValue: number | null; // null when OL / NCV-bar / non-numeric
  displayUnit: string; // "kΩ", "V", "" (NCV), "?" (unknown function)
  baseValue: number | null; // normalized SI: 1002 for 1.002 kΩ
  baseUnit: string; // "Ω"
  overload: boolean;
  acdc: 'AC' | 'DC' | '';
  bargraph: number; // raw analog-bar count
  flags: {
    max: boolean;
    min: boolean;
    hold: boolean;
    rel: boolean;
    auto: boolean; // autoranging (flags B bit2 clear)
    lowBattery: boolean;
    hvWarning: boolean;
    peakMax: boolean;
    peakMin: boolean;
  };
}

// A charted point derived from a Reading: normalized value vs time, tagged with the
// segment it belongs to. `v` is baseValue (SI-normalized so autorange is invisible);
// null means OL / NCV / non-numeric → a gap in the chart and excluded from stats.
// `seg` increments whenever the measured quantity changes (PLAN §3.4).
export interface Sample {
  t: number; // ms epoch (= Reading.ts)
  v: number | null; // baseValue
  seg: number; // segment index
}

// Derive the chart Sample from a Reading. The segment index is assigned by the caller
// (useRecorder), which tracks quantity changes — decode itself is stateless.
export function toSample(r: Reading, seg: number): Sample {
  return { t: r.ts, v: r.baseValue, seg };
}

// The quantity key: two readings share a chart segment iff this matches. Range changes
// (kΩ↔MΩ) keep the same key (baseValue is normalized), so the curve stays continuous;
// a function change, °C↔°F (distinct fn codes), or the universal AC↔DC flip all change
// it and force a new segment (PLAN §3.4, PROTOCOL flags C bit3).
export function quantityKey(r: Reading): string {
  return `${r.function}|${r.acdc}`;
}

// Persisted recording metadata. The full per-sample Readings live in a separate store
// (see lib/storage.ts); this is the lightweight index row.
export interface Session {
  id: string;
  name: string;
  startedAt: number; // ms epoch
  endedAt: number | null; // null while still recording
  sampleCount: number;
  segments: { seg: number; function: string; acdc: string; unit: string }[];
}

// Index = frame[3] & 0x7F (PROTOCOL §3). '✓' codes were verified on our UT60BTk.
export const FUNCTIONS = [
  'ACV',
  'ACmV',
  'DCV',
  'DCmV',
  'Hz',
  '%',
  'OHM',
  'CONT',
  'DIODE',
  'CAP',
  '°C',
  '°F',
  'DCuA',
  'ACuA',
  'DCmA',
  'ACmA',
  'DCA',
  'ACA',
  'HFE',
  'Live',
  'NCV',
  'LozV',
] as const;

// Range digit (frame[4] − 0x30) selects the displayed unit *and* metric prefix.
// One entry per range index; functions whose unit never changes list a single entry
// and we fall back to [0] for any range (PROTOCOL §3 "Range → unit"). '' = no unit
// (NCV is a strength bar, HFE is a bare gain).
export const RANGE_UNITS: Record<string, string[]> = {
  ACV: ['V', 'V', 'V', 'V'],
  DCV: ['V', 'V', 'V', 'V'],
  LozV: ['V', 'V', 'V', 'V'],
  ACmV: ['mV'],
  DCmV: ['mV'],
  Hz: ['Hz', 'Hz', 'kHz', 'kHz', 'kHz', 'MHz', 'MHz', 'MHz'],
  '%': ['%'],
  OHM: ['Ω', 'kΩ', 'kΩ', 'kΩ', 'MΩ', 'MΩ', 'MΩ'],
  CONT: ['Ω'],
  DIODE: ['V'],
  CAP: ['nF', 'nF', 'µF', 'µF', 'µF', 'mF', 'mF', 'mF'],
  '°C': ['°C'],
  '°F': ['°F'],
  DCuA: ['µA', 'µA'],
  ACuA: ['µA', 'µA'],
  DCmA: ['mA', 'mA'],
  ACmA: ['mA', 'mA'],
  DCA: ['A', 'A'],
  ACA: ['A', 'A'],
  HFE: [''],
  Live: [''],
  NCV: [''],
};

// Functions where the AC/DC distinction is meaningful — these report acdc from
// flags C bit3. Everything else (Hz, OHM, CAP, temp, NCV…) reports ''.
export const ACDC_FUNCTIONS = new Set([
  'ACV',
  'DCV',
  'LozV',
  'ACmV',
  'DCmV',
  'DCuA',
  'ACuA',
  'DCmA',
  'ACmA',
  'DCA',
  'ACA',
]);

const PREFIX: Record<string, number> = { n: -9, µ: -6, m: -3, k: 3, M: 6 };

export interface UnitInfo {
  display: string; // "kΩ"
  base: string; // "Ω"
  exp: number; // prefix exponent: baseValue = displayValue * 10^exp
}

// Split a displayed unit into its SI base + prefix exponent. "kΩ"→{Ω,3}, "mV"→{V,-3},
// "nF"→{F,-9}, "Hz"→{Hz,0}, "°C"→{°C,0}. The first char is only treated as a prefix
// when there's a base behind it, so a bare "V"/"Ω"/"%"/"" stays put.
export function unitInfo(display: string): UnitInfo {
  const head = display[0];
  if (display.length > 1 && head in PREFIX) {
    return { display, base: display.slice(1), exp: PREFIX[head] };
  }
  return { display, base: display, exp: 0 };
}
