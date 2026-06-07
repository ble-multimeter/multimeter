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
// (the recorder package's storage); this is the lightweight index row.
export interface Session {
  id: string;
  name: string;
  startedAt: number; // ms epoch
  endedAt: number | null; // null while still recording
  sampleCount: number;
  segments: { seg: number; function: string; acdc: string; unit: string }[];
}

// Index = frame[3] & 0x7F (PROTOCOL §3). Codes 0–21 were verified on our UT60BT. Codes 22–31
// are ported from the source Windows app's `DecoderUni_T.cs` `functionStrings` for other UT-series
// models (e.g. LPF low-pass AC, combined AC+DC, inrush) — present so those meters show a sensible
// label + unit instead of "#22", but unverified on hardware. The source reuses ACA/DCA/LPF names
// across several codes; mirrored verbatim since decode keys the unit table off the same name.
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
  'ACA', // 22 — duplicate code for ACA on some models (source `functionStrings`)
  'DCA', // 23 — duplicate code for DCA
  'LPF', // 24 — low-pass-filtered AC voltage
  'AC/DC', // 25 — combined AC/DC voltage
  'LPF', // 26
  'AC+DC', // 27 — combined AC+DC current
  'LPFA', // 28
  'AC+DC2', // 29
  'INRUSH', // 30 — inrush current capture
  // Source index 31 is a blank placeholder; we omit it so an out-of-range code still falls
  // back to "#31" (graceful degradation) rather than an empty function name.
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
  // Ported from DecoderUni_T.cs for codes 22–31 (other UT models; unverified on hardware).
  LPF: ['V', 'V', 'V', 'V'],
  'AC/DC': ['V', 'V', 'V', 'V'],
  LPFA: ['V', 'V', 'V', 'V'],
  'AC+DC': ['A', 'A'],
  'AC+DC2': ['A', 'A'],
  INRUSH: ['V', 'V', 'V', 'V'],
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
