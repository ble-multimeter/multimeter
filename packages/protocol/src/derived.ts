// Derived channels (PLAN §7, plan-7.md §4). Pure + tested — the unit algebra is where the bugs
// hide, so it lives here, isolated from React and BLE, the same discipline as decode/stats.
//
// A derived channel combines two Reading streams (A, B) under one of four ops with *correct unit
// algebra* on the SI `baseUnit`: V·A=W, V/A=Ω, V−V=V, etc. `deriveUnit` answers "what unit (if any)
// does A op B produce?"; `combineReadings` synthesizes the per-tick Reading (null in → null out, so
// an OL/stale input becomes a chart gap and is excluded from stats). No I/O, no React.

import type { DerivedOp, Reading } from './types';

export type { DerivedOp };

// The math + the human label for each op. The symbol is what the derived `function` formula reads
// as (e.g. "P=V×I"); the apply is plain float arithmetic on the two base values.
export const OP_SYMBOL: Record<DerivedOp, string> = {
  mul: '×',
  div: '÷',
  add: '+',
  sub: '−',
};

function applyOp(op: DerivedOp, a: number, b: number): number {
  switch (op) {
    case 'mul':
      return a * b;
    case 'div':
      return a / b; // b===0 → ±Infinity; surfaced as a null sample by combineReadings
    case 'add':
      return a + b;
    case 'sub':
      return a - b;
  }
}

export interface DerivedUnit {
  unit: string; // resulting SI base unit ('' = dimensionless ratio, or "can't")
  ok: boolean; // false = the op is invalid for these units (builder shows an error)
}

// Curated multiplicative unit table on the *unordered* pair (V·A and A·V both → W). Only the pairs
// the meters actually produce are listed; anything else falls back to a composite "a·b" label
// (still chartable, just not a named SI unit).
const MUL_TABLE: Record<string, string> = {
  'A|V': 'W', // power: volts × amps = watts
  'A|Ω': 'V', // Ohm's law: amps × ohms = volts
  'S|V': 'A', // siemens × volts = amps
};

// Curated division table on the *ordered* pair (V/A=Ω but A/V=S). `x/x` is handled separately
// (dimensionless ratio). Anything else falls back to a composite "a/b" label.
const DIV_TABLE: Record<string, string> = {
  'V/A': 'Ω', // resistance: volts ÷ amps = ohms
  'V/Ω': 'A', // current: volts ÷ ohms = amps
  'W/V': 'A', // amps: watts ÷ volts
  'W/A': 'V', // volts: watts ÷ amps
  'A/V': 'S', // conductance: amps ÷ volts = siemens
};

/**
 * The resulting unit for `a op b` on SI base units, plus whether the op is valid.
 * - mul: curated unordered table → composite `a·b` fallback (always ok).
 * - div: `a===b` → dimensionless ''; curated ordered table → composite `a/b` fallback (always ok).
 * - add/sub: only same-unit is meaningful (`V−V=V`); mismatched units are invalid (`ok:false`).
 * Empty-unit inputs (NCV/HFE, '') are passed through structurally but never produce a named unit.
 */
export function deriveUnit(op: DerivedOp, a: string, b: string): DerivedUnit {
  switch (op) {
    case 'mul': {
      const key = [a, b].sort().join('|'); // unordered: sort the pair
      const unit = MUL_TABLE[key];
      return unit ? { unit, ok: true } : { unit: `${a}·${b}`, ok: true };
    }
    case 'div': {
      if (a === b) return { unit: '', ok: true }; // ratio of like quantities is dimensionless
      const unit = DIV_TABLE[`${a}/${b}`]; // ordered
      return unit ? { unit, ok: true } : { unit: `${a}/${b}`, ok: true };
    }
    case 'add':
    case 'sub':
      // Adding/subtracting only makes sense for like quantities; the unit is unchanged.
      return a === b ? { unit: a, ok: true } : { unit: '', ok: false };
  }
}

// Auto metric-prefix a base value + unit for *display* (plan-7.md §8). The baseValue/baseUnit stay
// SI-normalized (so the chart + stats are consistent); only the displayed number/unit get a prefix
// so a 24 000 W reads "24 kW" and 0.012 W reads "12 mW". Composite/dimensionless units ('', 'V·V',
// 'W/V') are left unprefixed — prefixing a composite would be ambiguous. Pure.
const SI_PREFIXES: { exp: number; sym: string }[] = [
  { exp: 9, sym: 'G' },
  { exp: 6, sym: 'M' },
  { exp: 3, sym: 'k' },
  { exp: 0, sym: '' },
  { exp: -3, sym: 'm' },
  { exp: -6, sym: 'µ' },
  { exp: -9, sym: 'n' },
];

// A unit takes a metric prefix only if it's a bare SI symbol (one of these); composites don't.
const PREFIXABLE = new Set(['V', 'A', 'W', 'Ω', 'S', 'F', 'Hz']);

export function prefixDisplay(
  baseValue: number,
  baseUnit: string,
): { displayValue: number; displayUnit: string } {
  if (!PREFIXABLE.has(baseUnit) || baseValue === 0) {
    return { displayValue: baseValue, displayUnit: baseUnit };
  }
  const abs = Math.abs(baseValue);
  for (const { exp, sym } of SI_PREFIXES) {
    if (abs >= 10 ** exp) {
      return { displayValue: baseValue / 10 ** exp, displayUnit: `${sym}${baseUnit}` };
    }
  }
  // Smaller than nano: fall back to the smallest prefix rather than scientific spam.
  const last = SI_PREFIXES[SI_PREFIXES.length - 1]!;
  return { displayValue: baseValue / 10 ** last.exp, displayUnit: `${last.sym}${baseUnit}` };
}

// The displayed formula a derived channel carries in its `function` field, e.g. "P=V×I". `label`
// is the user's name for the channel (the left-hand side); `aRole`/`bRole` are the input roles
// (or labels) so the formula reads in domain terms ("V×I") rather than opaque ids.
export function derivedFormula(label: string, op: DerivedOp, aRole: string, bRole: string): string {
  return `${label}=${aRole}${OP_SYMBOL[op]}${bRole}`;
}

/**
 * Synthesize the derived Reading for one tick from the latest A and B readings.
 *
 * Null propagation (plan-7.md §4.2): if either input is missing, OL, or non-finite, the derived
 * `baseValue`/`displayValue` are null — a chart gap, excluded from stats — but the Reading is still
 * emitted (counted, time-stamped) so the stream stays dense and the recording is faithful. A
 * non-finite result (e.g. division by zero) is likewise nulled.
 *
 * `ts` is the triggering tick's timestamp (caller passes the meter tick that fired the recompute).
 * `acdc` is '' and all flags are false — a derived value has no AC/DC sense or front-panel state.
 * displayValue/displayUnit mirror base for the MVP (auto metric-prefix is a §8 polish item).
 */
export function combineReadings(
  op: DerivedOp,
  formula: string,
  a: Reading | null,
  b: Reading | null,
  ts: number,
): Reading {
  const { unit } = deriveUnit(op, a?.baseUnit ?? '', b?.baseUnit ?? '');
  const av = a?.baseValue ?? null;
  const bv = b?.baseValue ?? null;

  let baseValue: number | null = null;
  if (av !== null && bv !== null) {
    const v = applyOp(op, av, bv);
    baseValue = Number.isFinite(v) ? v : null; // ÷0 / NaN → gap
  }

  // Auto metric-prefix the *display* only; baseValue/baseUnit stay SI so chart/stats are consistent.
  const disp =
    baseValue === null ? { displayValue: null, displayUnit: unit } : prefixDisplay(baseValue, unit);
  const displayText =
    disp.displayValue === null ? 'OL' : Number(disp.displayValue.toPrecision(5)).toString();

  return {
    ts,
    function: formula,
    displayText,
    displayValue: disp.displayValue,
    displayUnit: disp.displayUnit,
    baseValue,
    baseUnit: unit,
    overload: baseValue === null,
    acdc: '',
    bargraph: 0,
    flags: {
      max: false,
      min: false,
      hold: false,
      rel: false,
      auto: false,
      lowBattery: false,
      hvWarning: false,
      peakMax: false,
      peakMin: false,
    },
  };
}
