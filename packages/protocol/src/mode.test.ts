import { describe, it, expect } from 'vitest';
import { modeLabel } from './mode';
import type { Reading } from './types';

function reading(fn: string, acdc: 'AC' | 'DC' | ''): Reading {
  return {
    ts: 0,
    function: fn,
    displayText: '',
    displayValue: 0,
    displayUnit: '',
    baseValue: 0,
    baseUnit: '',
    overload: false,
    acdc,
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

describe('modeLabel', () => {
  it('prefixes the quantity with AC/DC when meaningful', () => {
    expect(modeLabel(reading('DCV', 'DC'))).toBe('DC Voltage');
    expect(modeLabel(reading('ACmV', 'AC'))).toBe('AC Voltage');
    expect(modeLabel(reading('DCmA', 'DC'))).toBe('DC Current');
  });

  it('omits the prefix for non-AC/DC quantities', () => {
    expect(modeLabel(reading('OHM', ''))).toBe('Resistance');
    expect(modeLabel(reading('CAP', ''))).toBe('Capacitance');
    expect(modeLabel(reading('Hz', ''))).toBe('Frequency');
  });

  it('falls back to the raw function code for unknowns', () => {
    expect(modeLabel(reading('#31', ''))).toBe('#31');
  });
});
