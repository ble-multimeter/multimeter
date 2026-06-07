import { describe, it, expect } from 'vitest';
import { toCsv } from './csv';
import type { Reading } from '../ble/types';

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

function reading(over: Partial<Reading> = {}): Reading {
  const { flags, ...rest } = over;
  return {
    ts: 0,
    function: 'DCV',
    displayText: '1.000',
    displayValue: 1,
    displayUnit: 'V',
    baseValue: 1,
    baseUnit: 'V',
    overload: false,
    acdc: 'DC',
    bargraph: 0,
    ...rest,
    flags: { ...noFlags, ...flags },
  };
}

describe('toCsv', () => {
  it('emits a header even with no rows', () => {
    expect(toCsv([])).toBe(
      'timestamp,segment,function,displayValue,displayUnit,baseValue,baseUnit,acdc,overload,hold,rel,max,min,auto',
    );
  });

  it('writes one row per reading with full resolution', () => {
    const rows = toCsv([reading({ ts: 0 }), reading({ ts: 1 }), reading({ ts: 2 })]);
    expect(rows.split('\r\n')).toHaveLength(4); // header + 3
  });

  it('serializes booleans as 0/1 and nulls as empty', () => {
    const csv = toCsv([
      reading({
        displayValue: null,
        baseValue: null,
        overload: true,
        flags: { ...noFlags, hold: true },
      }),
    ]);
    const row = csv.split('\r\n')[1];
    // …displayValue(empty), displayUnit, baseValue(empty)…
    expect(row).toContain(',,V,,'); // displayValue + baseValue blank
    // …acdc,overload,hold,rel,max,min,auto → DC,1,1,0,0,0,0
    expect(row.endsWith(',1,1,0,0,0,0')).toBe(true);
  });

  it('increments the segment column on a quantity change but not on a range change', () => {
    const csv = toCsv([
      reading({ function: 'OHM', acdc: '', displayUnit: 'kΩ', baseUnit: 'Ω' }),
      reading({ function: 'OHM', acdc: '', displayUnit: 'MΩ', baseUnit: 'Ω' }), // range change → same seg
      reading({ function: 'DCV', acdc: 'DC' }), // mode change → seg++
      reading({ function: 'ACV', acdc: 'AC' }), // AC/DC flip → seg++
    ]);
    const segs = csv
      .split('\r\n')
      .slice(1)
      .map((r) => r.split(',')[1]);
    expect(segs).toEqual(['0', '0', '1', '2']);
  });

  it('quotes fields that contain a comma', () => {
    const csv = toCsv([reading({ function: 'a,b' })]);
    expect(csv.split('\r\n')[1]).toContain('"a,b"');
  });
});
