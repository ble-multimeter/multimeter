import { describe, it, expect } from 'vitest';
import { resolveStroke, CHART_COLORS, DEFAULT_CHART_COLOR } from './chartColors';

describe('resolveStroke', () => {
  it('returns the dark/light hex for a known preset', () => {
    expect(resolveStroke('emerald', true)).toBe('#34d399');
    expect(resolveStroke('emerald', false)).toBe('#059669');
    expect(resolveStroke('sky', true)).toBe('#38bdf8');
  });

  it('falls back to the first preset for an unknown key', () => {
    expect(resolveStroke('does-not-exist', true)).toBe(CHART_COLORS[0].dark);
    expect(resolveStroke('does-not-exist', false)).toBe(CHART_COLORS[0].light);
  });

  it('the default key is one of the presets', () => {
    expect(CHART_COLORS.some((c) => c.key === DEFAULT_CHART_COLOR)).toBe(true);
  });
});
