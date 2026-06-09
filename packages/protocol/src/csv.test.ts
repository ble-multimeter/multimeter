import { describe, it, expect } from 'vitest';
import { toCsv, type CsvChannel } from './csv';
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

const chan = (channel: string, readings: Reading[]): CsvChannel => ({ channel, readings });

const HEADER =
  'timestamp,channel,segment,function,displayValue,displayUnit,baseValue,baseUnit,acdc,overload,hold,rel,max,min,auto';

describe('toCsv — long format', () => {
  it('emits a header even with no channels', () => {
    expect(toCsv([])).toBe(HEADER);
  });

  it('emits a header even when channels have no rows', () => {
    expect(toCsv([chan('V', [])])).toBe(HEADER);
  });

  it('writes one row per reading with the channel column', () => {
    const rows = toCsv([chan('V', [reading({ ts: 0 }), reading({ ts: 1 }), reading({ ts: 2 })])]);
    const split = rows.split('\r\n');
    expect(split).toHaveLength(4); // header + 3
    expect(split[1]!.split(',')[1]).toBe('V'); // channel column
  });

  it('serializes booleans as 0/1 and nulls as empty', () => {
    const csv = toCsv([
      chan('V', [
        reading({
          displayValue: null,
          baseValue: null,
          overload: true,
          flags: { ...noFlags, hold: true },
        }),
      ]),
    ]);
    const row = csv.split('\r\n')[1]!;
    // …acdc,overload,hold,rel,max,min,auto → DC,1,1,0,0,0,0
    expect(row.endsWith(',1,1,0,0,0,0')).toBe(true);
    // channel V, segment 0, function DCV, displayValue(empty), unit V, baseValue(empty)…
    expect(row.startsWith('1970-01-01T00:00:00.000Z,V,0,DCV,,V,,V,DC,')).toBe(true);
  });

  it('increments segment per channel on a quantity change but not on a range change', () => {
    const csv = toCsv([
      chan('M', [
        reading({ ts: 0, function: 'OHM', acdc: '', displayUnit: 'kΩ', baseUnit: 'Ω' }),
        reading({ ts: 1, function: 'OHM', acdc: '', displayUnit: 'MΩ', baseUnit: 'Ω' }), // range → same seg
        reading({ ts: 2, function: 'DCV', acdc: 'DC' }), // mode → seg++
        reading({ ts: 3, function: 'ACV', acdc: 'AC' }), // AC/DC flip → seg++
      ]),
    ]);
    const segs = csv
      .split('\r\n')
      .slice(1)
      .map(r => r.split(',')[2]); // segment is now col index 2
    expect(segs).toEqual(['0', '0', '1', '2']);
  });

  it('merge-sorts rows chronologically across channels, keeping each channel its own segments', () => {
    const csv = toCsv([
      chan('V', [reading({ ts: 0, baseValue: 12 }), reading({ ts: 20, baseValue: 13 })]),
      chan('I', [reading({ ts: 10, function: 'DCA', baseUnit: 'A', baseValue: 2 })]),
    ]);
    const rows = csv.split('\r\n').slice(1);
    // ts order 0(V), 10(I), 20(V) → channel column should read V, I, V
    expect(rows.map(r => r.split(',')[1])).toEqual(['V', 'I', 'V']);
  });

  it('breaks same-ts ties by channel label deterministically', () => {
    const csv = toCsv([
      chan('Z', [reading({ ts: 5 })]),
      chan('A', [reading({ ts: 5 })]),
    ]);
    const rows = csv.split('\r\n').slice(1);
    expect(rows.map(r => r.split(',')[1])).toEqual(['A', 'Z']);
  });

  it('quotes fields that contain a comma', () => {
    const csv = toCsv([chan('a,b', [reading({ function: 'c,d' })])]);
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain('"a,b"');
    expect(row).toContain('"c,d"');
  });
});
