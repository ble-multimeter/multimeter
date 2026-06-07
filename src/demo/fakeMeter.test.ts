import { describe, it, expect } from 'vitest';
import { demoReading, demoVolts, isDemoMode } from './fakeMeter';

describe('demoVolts', () => {
  it('stays within a believable band over time', () => {
    for (let t = 0; t < 120; t += 0.25) {
      const v = demoVolts(t);
      expect(v).toBeGreaterThan(3.5);
      expect(v).toBeLessThan(5.5);
    }
  });
});

describe('demoReading', () => {
  it('is a well-formed DCV volts reading', () => {
    const r = demoReading(1, 1000);
    expect(r.function).toBe('DCV');
    expect(r.displayUnit).toBe('V');
    expect(r.baseUnit).toBe('V');
    expect(r.acdc).toBe('DC');
    expect(r.flags.auto).toBe(true);
    expect(r.overload).toBe(false);
    expect(r.ts).toBe(1000);
    expect(r.displayText).toMatch(/^\d\.\d{3}$/); // e.g. "4.512"
    expect(r.baseValue).toBeCloseTo(r.displayValue ?? NaN, 10); // V has no prefix
  });
});

describe('isDemoMode', () => {
  it('is false without ?demo in the URL', () => {
    expect(isDemoMode()).toBe(false);
  });
});
