import { describe, it, expect } from 'vitest';
import {
  deriveUnit,
  combineReadings,
  derivedFormula,
  prefixDisplay,
  type DerivedOp,
} from './derived';
import type { Reading } from './types';

const noFlags = {
  max: false,
  min: false,
  hold: false,
  rel: false,
  auto: false,
  lowBattery: false,
  hvWarning: false,
  peakMax: false,
  peakMin: false,
};

// A minimal Reading with a given base value + unit; ts defaults to 0.
function reading(baseValue: number | null, baseUnit: string, over: Partial<Reading> = {}): Reading {
  return {
    ts: 0,
    function: baseUnit,
    displayText: String(baseValue),
    displayValue: baseValue,
    displayUnit: baseUnit,
    baseValue,
    baseUnit,
    overload: baseValue === null,
    acdc: '',
    bargraph: 0,
    flags: noFlags,
    ...over,
  };
}

describe('deriveUnit — mul', () => {
  it('curates the named products (unordered)', () => {
    expect(deriveUnit('mul', 'V', 'A')).toEqual({ unit: 'W', ok: true });
    expect(deriveUnit('mul', 'A', 'V')).toEqual({ unit: 'W', ok: true }); // order-independent
    expect(deriveUnit('mul', 'A', 'Ω')).toEqual({ unit: 'V', ok: true });
    expect(deriveUnit('mul', 'Ω', 'A')).toEqual({ unit: 'V', ok: true });
    expect(deriveUnit('mul', 'S', 'V')).toEqual({ unit: 'A', ok: true });
  });

  it('falls back to a composite label for an unknown product (still ok/chartable)', () => {
    expect(deriveUnit('mul', 'V', 'V')).toEqual({ unit: 'V·V', ok: true });
    expect(deriveUnit('mul', 'Hz', 'F')).toEqual({ unit: 'Hz·F', ok: true }); // input order kept
  });
});

describe('deriveUnit — div', () => {
  it('curates the named ratios (ordered)', () => {
    expect(deriveUnit('div', 'V', 'A')).toEqual({ unit: 'Ω', ok: true });
    expect(deriveUnit('div', 'V', 'Ω')).toEqual({ unit: 'A', ok: true });
    expect(deriveUnit('div', 'W', 'V')).toEqual({ unit: 'A', ok: true });
    expect(deriveUnit('div', 'W', 'A')).toEqual({ unit: 'V', ok: true });
    expect(deriveUnit('div', 'A', 'V')).toEqual({ unit: 'S', ok: true });
  });

  it('treats like ÷ like as a dimensionless ratio', () => {
    expect(deriveUnit('div', 'V', 'V')).toEqual({ unit: '', ok: true });
    expect(deriveUnit('div', 'W', 'W')).toEqual({ unit: '', ok: true });
  });

  it('falls back to a composite label for an unknown ratio', () => {
    expect(deriveUnit('div', 'Hz', 'V')).toEqual({ unit: 'Hz/V', ok: true });
  });
});

describe('deriveUnit — add/sub', () => {
  it('requires matching units and keeps the unit', () => {
    expect(deriveUnit('add', 'V', 'V')).toEqual({ unit: 'V', ok: true });
    expect(deriveUnit('sub', 'A', 'A')).toEqual({ unit: 'A', ok: true });
  });

  it('rejects mismatched units', () => {
    expect(deriveUnit('add', 'V', 'A')).toEqual({ unit: '', ok: false });
    expect(deriveUnit('sub', 'W', 'V')).toEqual({ unit: '', ok: false });
  });
});

describe('derivedFormula', () => {
  it('reads as label=A op B with the op symbol', () => {
    expect(derivedFormula('P', 'mul', 'V', 'I')).toBe('P=V×I');
    expect(derivedFormula('R', 'div', 'V', 'I')).toBe('R=V÷I');
    expect(derivedFormula('ΔV', 'sub', 'V1', 'V2')).toBe('ΔV=V1−V2');
  });
});

describe('prefixDisplay', () => {
  it('scales large/small bare SI units', () => {
    expect(prefixDisplay(24000, 'W')).toEqual({ displayValue: 24, displayUnit: 'kW' });
    expect(prefixDisplay(0.012, 'W')).toEqual({ displayValue: 12, displayUnit: 'mW' });
    expect(prefixDisplay(5, 'V')).toEqual({ displayValue: 5, displayUnit: 'V' });
    expect(prefixDisplay(2_500_000, 'Ω')).toEqual({ displayValue: 2.5, displayUnit: 'MΩ' });
  });

  it('leaves composite / dimensionless units unprefixed', () => {
    expect(prefixDisplay(1500, 'V·V')).toEqual({ displayValue: 1500, displayUnit: 'V·V' });
    expect(prefixDisplay(3000, '')).toEqual({ displayValue: 3000, displayUnit: '' });
  });

  it('passes zero through untouched', () => {
    expect(prefixDisplay(0, 'W')).toEqual({ displayValue: 0, displayUnit: 'W' });
  });
});

describe('combineReadings — display prefix', () => {
  it('auto-prefixes the display while keeping base SI', () => {
    const r = combineReadings('mul', 'P=V×I', reading(12000, 'V'), reading(2, 'A'), 0);
    expect(r.baseValue).toBe(24000); // SI value preserved for chart/stats
    expect(r.baseUnit).toBe('W');
    expect(r.displayValue).toBe(24);
    expect(r.displayUnit).toBe('kW');
    expect(r.displayText).toBe('24');
  });
});

describe('combineReadings — math', () => {
  it('computes V × A = W', () => {
    const r = combineReadings('mul', 'P=V×I', reading(12, 'V'), reading(2, 'A'), 100);
    expect(r.baseValue).toBe(24);
    expect(r.baseUnit).toBe('W');
    expect(r.displayUnit).toBe('W');
    expect(r.ts).toBe(100);
    expect(r.function).toBe('P=V×I');
    expect(r.overload).toBe(false);
  });

  it('computes V ÷ A = Ω', () => {
    const r = combineReadings('div', 'R=V÷I', reading(10, 'V'), reading(2, 'A'), 0);
    expect(r.baseValue).toBe(5);
    expect(r.baseUnit).toBe('Ω');
  });

  it('computes V − V = V (differential)', () => {
    const r = combineReadings('sub', 'ΔV=A−B', reading(5, 'V'), reading(3, 'V'), 0);
    expect(r.baseValue).toBe(2);
    expect(r.baseUnit).toBe('V');
  });
});

describe('combineReadings — null/OL propagation', () => {
  it('nulls the result when either input is null, but still emits', () => {
    const a = combineReadings('mul', 'P', null, reading(2, 'A'), 7);
    expect(a.baseValue).toBeNull();
    expect(a.overload).toBe(true);
    expect(a.ts).toBe(7); // still time-stamped/emitted

    const b = combineReadings('mul', 'P', reading(12, 'V'), reading(null, 'A'), 0);
    expect(b.baseValue).toBeNull();
  });

  it('nulls a divide-by-zero (non-finite) result', () => {
    const r = combineReadings('div', 'R', reading(5, 'V'), reading(0, 'A'), 0);
    expect(r.baseValue).toBeNull();
    expect(r.overload).toBe(true);
  });

  it('has no AC/DC sense and all flags clear', () => {
    const r = combineReadings('mul', 'P', reading(1, 'V'), reading(1, 'A'), 0);
    expect(r.acdc).toBe('');
    expect(Object.values(r.flags).every(f => f === false)).toBe(true);
  });
});

// Exhaustive op coverage so a future op addition forces a test update.
describe('combineReadings — every op applies', () => {
  const cases: [DerivedOp, number, number, number][] = [
    ['mul', 3, 4, 12],
    ['div', 12, 4, 3],
    ['add', 3, 4, 7],
    ['sub', 3, 4, -1],
  ];
  for (const [op, a, b, expected] of cases) {
    it(`${op}(${a}, ${b}) = ${expected}`, () => {
      // Use matching units so add/sub stay valid; the math is unit-agnostic.
      const r = combineReadings(op, op, reading(a, 'V'), reading(b, 'V'), 0);
      expect(r.baseValue).toBe(expected);
    });
  }
});
