// Test factory for Reading objects (local to this package's tests). Defaults to a plain DCV
// measurement; pass a partial to override any field.
import type { Reading } from '@mbtech-nl/multimeter-protocol';

export const noFlags = {
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

export function makeReading(over: Partial<Reading> = {}): Reading {
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
    flags: { ...noFlags, auto: true },
    ...over,
  };
}
