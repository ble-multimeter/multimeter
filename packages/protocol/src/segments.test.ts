// Segment derivation (PLAN §3.4). A contiguous run of same-quantity readings is one segment;
// the quantity key is `function|acdc`, so a function change, a °C↔°F flip (distinct fn codes), or
// an AC↔DC flip starts a new segment, while a pure range change (kΩ↔MΩ — same fn, normalized
// baseValue) stays in the same one. Covers segmentIndices / deriveSegments / splitSegments.
import { describe, it, expect } from 'vitest';
import { segmentIndices, deriveSegments, splitSegments } from './segments';
import type { Reading } from './types';

// Minimal Reading builder — only the fields the segmenters read (function/acdc/baseUnit/
// baseValue/ts) need to vary; the rest are filled with inert defaults.
function reading(p: Partial<Reading>): Reading {
  return {
    ts: 0,
    function: 'DCV',
    displayText: '',
    displayValue: null,
    displayUnit: '',
    baseValue: null,
    baseUnit: 'V',
    overload: false,
    acdc: 'DC',
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
    ...p,
  };
}

describe('segmentIndices', () => {
  it('returns an empty array for no readings', () => {
    expect(segmentIndices([])).toEqual([]);
  });

  it('keeps same-quantity readings in one segment (index 0)', () => {
    const rs = [
      reading({ function: 'DCV', acdc: 'DC', baseValue: 1 }),
      reading({ function: 'DCV', acdc: 'DC', baseValue: 2 }),
      reading({ function: 'DCV', acdc: 'DC', baseValue: 3 }),
    ];
    expect(segmentIndices(rs)).toEqual([0, 0, 0]);
  });

  it('keeps a pure range change (kΩ↔MΩ) in the same segment', () => {
    // Same function + acdc, only the displayed unit/range changes — baseValue is normalized,
    // so the quantity key is identical and the curve stays continuous.
    const rs = [
      reading({ function: 'OHM', acdc: '', baseUnit: 'Ω', displayUnit: 'kΩ', baseValue: 7270 }),
      reading({
        function: 'OHM',
        acdc: '',
        baseUnit: 'Ω',
        displayUnit: 'MΩ',
        baseValue: 7_270_000,
      }),
    ];
    expect(segmentIndices(rs)).toEqual([0, 0]);
  });

  it('starts a new segment on a function change', () => {
    const rs = [
      reading({ function: 'DCV', acdc: 'DC' }),
      reading({ function: 'OHM', acdc: '' }),
      reading({ function: 'OHM', acdc: '' }),
    ];
    expect(segmentIndices(rs)).toEqual([0, 1, 1]);
  });

  it('starts a new segment on an AC↔DC flip (same function family)', () => {
    const rs = [reading({ function: 'DCV', acdc: 'DC' }), reading({ function: 'ACV', acdc: 'AC' })];
    expect(segmentIndices(rs)).toEqual([0, 1]);
  });

  it('starts a new segment on a °C↔°F flip (distinct function codes)', () => {
    const rs = [
      reading({ function: '°C', acdc: '', baseUnit: '°C' }),
      reading({ function: '°F', acdc: '', baseUnit: '°F' }),
    ];
    expect(segmentIndices(rs)).toEqual([0, 1]);
  });

  it('handles null/overload readings without breaking the run', () => {
    // Overload (baseValue null) inside a same-quantity run does not split the segment.
    const rs = [
      reading({ function: 'OHM', acdc: '', baseUnit: 'Ω', baseValue: 100 }),
      reading({ function: 'OHM', acdc: '', baseUnit: 'Ω', baseValue: null, overload: true }),
      reading({ function: 'OHM', acdc: '', baseUnit: 'Ω', baseValue: 200 }),
    ];
    expect(segmentIndices(rs)).toEqual([0, 0, 0]);
  });
});

describe('deriveSegments', () => {
  it('returns no segments for no readings', () => {
    expect(deriveSegments([])).toEqual([]);
  });

  it('collapses a same-quantity run into one segment with its metadata', () => {
    const rs = [
      reading({ function: 'DCV', acdc: 'DC', baseUnit: 'V' }),
      reading({ function: 'DCV', acdc: 'DC', baseUnit: 'V' }),
    ];
    expect(deriveSegments(rs)).toEqual([{ seg: 0, function: 'DCV', acdc: 'DC', unit: 'V' }]);
  });

  it('records one entry per contiguous run across function / °C↔°F / AC↔DC changes', () => {
    const rs = [
      reading({ function: 'DCV', acdc: 'DC', baseUnit: 'V' }),
      reading({ function: 'DCV', acdc: 'DC', baseUnit: 'V' }),
      reading({ function: 'ACV', acdc: 'AC', baseUnit: 'V' }), // AC↔DC flip
      reading({ function: 'OHM', acdc: '', baseUnit: 'Ω' }), // function change
      reading({ function: '°C', acdc: '', baseUnit: '°C' }),
      reading({ function: '°F', acdc: '', baseUnit: '°F' }), // °C↔°F flip
    ];
    expect(deriveSegments(rs)).toEqual([
      { seg: 0, function: 'DCV', acdc: 'DC', unit: 'V' },
      { seg: 1, function: 'ACV', acdc: 'AC', unit: 'V' },
      { seg: 2, function: 'OHM', acdc: '', unit: 'Ω' },
      { seg: 3, function: '°C', acdc: '', unit: '°C' },
      { seg: 4, function: '°F', acdc: '', unit: '°F' },
    ]);
  });

  it('does not split a pure range change', () => {
    const rs = [
      reading({ function: 'OHM', acdc: '', baseUnit: 'Ω', displayUnit: 'kΩ' }),
      reading({ function: 'OHM', acdc: '', baseUnit: 'Ω', displayUnit: 'MΩ' }),
    ];
    expect(deriveSegments(rs)).toEqual([{ seg: 0, function: 'OHM', acdc: '', unit: 'Ω' }]);
  });
});

describe('splitSegments', () => {
  it('returns no groups for no readings', () => {
    expect(splitSegments([])).toEqual([]);
  });

  it('groups same-quantity readings into one segment, preserving samples + seg tag', () => {
    const rs = [
      reading({ ts: 10, function: 'DCV', acdc: 'DC', baseUnit: 'V', baseValue: 1 }),
      reading({ ts: 20, function: 'DCV', acdc: 'DC', baseUnit: 'V', baseValue: 2 }),
    ];
    const out = splitSegments(rs);
    expect(out).toHaveLength(1);
    expect(out[0].info).toEqual({ seg: 0, function: 'DCV', acdc: 'DC', unit: 'V' });
    expect(out[0].samples).toEqual([
      { t: 10, v: 1, seg: 0 },
      { t: 20, v: 2, seg: 0 },
    ]);
  });

  it('splits on a function change, each group carrying its own samples', () => {
    const rs = [
      reading({ ts: 1, function: 'DCV', acdc: 'DC', baseUnit: 'V', baseValue: 5 }),
      reading({ ts: 2, function: 'OHM', acdc: '', baseUnit: 'Ω', baseValue: 100 }),
      reading({ ts: 3, function: 'OHM', acdc: '', baseUnit: 'Ω', baseValue: 200 }),
    ];
    const out = splitSegments(rs);
    expect(out).toHaveLength(2);
    expect(out[0].info).toEqual({ seg: 0, function: 'DCV', acdc: 'DC', unit: 'V' });
    expect(out[0].samples).toEqual([{ t: 1, v: 5, seg: 0 }]);
    expect(out[1].info).toEqual({ seg: 1, function: 'OHM', acdc: '', unit: 'Ω' });
    expect(out[1].samples).toEqual([
      { t: 2, v: 100, seg: 1 },
      { t: 3, v: 200, seg: 1 },
    ]);
  });

  it('carries a null sample (overload) through as a charted gap', () => {
    const rs = [
      reading({ ts: 1, function: 'OHM', acdc: '', baseUnit: 'Ω', baseValue: null, overload: true }),
    ];
    const out = splitSegments(rs);
    expect(out).toHaveLength(1);
    expect(out[0].samples).toEqual([{ t: 1, v: null, seg: 0 }]);
  });
});
