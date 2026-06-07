import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRecorder } from './useRecorder';
import { makeReading } from './test-readings';
import type { Reading } from '@mbtech-nl/multimeter-protocol';

// Drive the hook by re-rendering with a new reading each time, like the live stream does.
function streamHook(first: Reading) {
  return renderHook(({ r }) => useRecorder(r), { initialProps: { r: first } });
}

describe('useRecorder segmentation', () => {
  it('accumulates live stats within one quantity', () => {
    const { result, rerender } = streamHook(
      makeReading({ ts: 1000, function: 'DCV', acdc: 'DC', baseValue: 1, baseUnit: 'V' }),
    );
    expect(result.current.segment?.function).toBe('DCV');
    expect(result.current.segment?.seg).toBe(0);

    rerender({
      r: makeReading({ ts: 1250, function: 'DCV', acdc: 'DC', baseValue: 3, baseUnit: 'V' }),
    });
    expect(result.current.stats.count).toBe(2);
    expect(result.current.stats.min).toBe(1);
    expect(result.current.stats.max).toBe(3);
    expect(result.current.segment?.seg).toBe(0);
  });

  it('starts a new segment and resets stats on a unit/function change', () => {
    const { result, rerender } = streamHook(
      makeReading({ ts: 1000, function: 'DCV', acdc: 'DC', baseValue: 1, baseUnit: 'V' }),
    );
    rerender({
      r: makeReading({ ts: 1250, function: 'DCV', acdc: 'DC', baseValue: 3, baseUnit: 'V' }),
    });
    expect(result.current.stats.count).toBe(2);

    // Switch to resistance — incompatible quantity.
    rerender({
      r: makeReading({
        ts: 1500,
        function: 'OHM',
        acdc: '',
        displayUnit: 'kΩ',
        baseValue: 100,
        baseUnit: 'Ω',
      }),
    });
    expect(result.current.segment?.function).toBe('OHM');
    expect(result.current.segment?.seg).toBe(1);
    expect(result.current.stats.count).toBe(1); // stats reset, not averaged across V and Ω
    expect(result.current.stats.max).toBe(100);
  });

  it('also splits on an AC/DC flip of the same function', () => {
    const { result, rerender } = streamHook(
      makeReading({ ts: 1000, function: 'ACV', acdc: 'DC', baseValue: 1, baseUnit: 'V' }),
    );
    rerender({
      r: makeReading({ ts: 1250, function: 'ACV', acdc: 'AC', baseValue: 2, baseUnit: 'V' }),
    });
    expect(result.current.segment?.seg).toBe(1);
    expect(result.current.stats.count).toBe(1);
  });

  it('keeps one segment across a range change (kΩ↔MΩ), since baseValue is normalized', () => {
    const { result, rerender } = streamHook(
      makeReading({
        ts: 1000,
        function: 'OHM',
        acdc: '',
        displayUnit: 'kΩ',
        baseValue: 1500,
        baseUnit: 'Ω',
      }),
    );
    rerender({
      r: makeReading({
        ts: 1250,
        function: 'OHM',
        acdc: '',
        displayUnit: 'MΩ',
        baseValue: 2_000_000,
        baseUnit: 'Ω',
      }),
    });
    expect(result.current.segment?.seg).toBe(0); // same quantity → same segment
    expect(result.current.stats.count).toBe(2);
  });
});
