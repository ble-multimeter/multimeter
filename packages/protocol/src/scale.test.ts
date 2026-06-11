import { describe, it, expect } from 'vitest';
import { gaugeFullScale, gaugeFraction } from './scale';
import type { Reading } from './types';

// Minimal Reading factory — only the fields the gauge math reads.
function reading(displayValue: number | null, overload = false): Reading {
  return {
    ts: 0,
    function: 'DCV',
    displayText: displayValue == null ? '' : String(displayValue),
    displayValue,
    displayUnit: 'V',
    baseValue: displayValue,
    baseUnit: 'V',
    overload,
    acdc: 'DC',
    bargraph: 0,
    flags: {
      max: false,
      min: false,
      hold: false,
      rel: false,
      auto: true,
      lowBattery: false,
      hvWarning: false,
      peakMax: false,
      peakMin: false,
    },
  };
}

describe('gaugeFullScale', () => {
  it('scales to the decade above the integer part (range-honoring)', () => {
    expect(gaugeFullScale(reading(4.523))).toBe(10); // 6 V range
    expect(gaugeFullScale(reading(45.23))).toBe(100); // 60 V range
    expect(gaugeFullScale(reading(452.3))).toBe(1000); // 600 V range
  });

  it('uses a unit scale for sub-1 readings so they deflect usefully', () => {
    expect(gaugeFullScale(reading(0.523))).toBe(1);
    expect(gaugeFullScale(reading(0))).toBe(1);
  });

  it('is sign-agnostic', () => {
    expect(gaugeFullScale(reading(-45.2))).toBe(100);
  });

  it('falls back to 1 when there is no numeric value', () => {
    expect(gaugeFullScale(reading(null))).toBe(1);
  });
});

describe('gaugeFraction', () => {
  it('is |value| / full-scale, clamped to [0,1]', () => {
    expect(gaugeFraction(reading(4.523))).toBeCloseTo(0.4523, 4);
    expect(gaugeFraction(reading(0.523))).toBeCloseTo(0.523, 4);
    expect(gaugeFraction(reading(-2.5))).toBeCloseTo(0.25, 4); // magnitude drives deflection
  });

  it('pins to full-scale on overload', () => {
    expect(gaugeFraction(reading(null, true))).toBe(1);
  });

  it('returns null when there is no needle to draw', () => {
    expect(gaugeFraction(reading(null))).toBeNull();
  });

  it('never exceeds 1 at a decade boundary', () => {
    expect(gaugeFraction(reading(9.999))).toBeLessThanOrEqual(1);
    expect(gaugeFraction(reading(9.999))).toBeGreaterThan(0.99);
  });
});
