import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRecorder, type RecordableChannel } from './useRecorder';
import { makeReading } from './test-readings';
import type { Reading } from '@ble-multimeter/protocol';

// Drive the hook by re-rendering with a fresh channels array carrying a new reading each time,
// like the live multi-channel stream does. One meter channel ('v') = the N=1 case.
function streamHook(first: Reading) {
  const channels = (r: Reading): RecordableChannel[] => [
    { id: 'v', label: 'V', kind: 'meter', reading: r },
  ];
  return renderHook(({ r }) => useRecorder(channels(r)), { initialProps: { r: first } });
}

// The single channel's view in the snapshot.
const chan = (result: { current: ReturnType<typeof useRecorder> }) =>
  result.current.channels.find(c => c.id === 'v')!;

describe('useRecorder segmentation (single channel)', () => {
  it('accumulates live stats within one quantity', () => {
    const { result, rerender } = streamHook(
      makeReading({ ts: 1000, function: 'DCV', acdc: 'DC', baseValue: 1, baseUnit: 'V' }),
    );
    expect(chan(result).segment?.function).toBe('DCV');
    expect(chan(result).segment?.seg).toBe(0);

    rerender({
      r: makeReading({ ts: 1250, function: 'DCV', acdc: 'DC', baseValue: 3, baseUnit: 'V' }),
    });
    expect(chan(result).stats.count).toBe(2);
    expect(chan(result).stats.min).toBe(1);
    expect(chan(result).stats.max).toBe(3);
    expect(chan(result).segment?.seg).toBe(0);
  });

  it('starts a new segment and resets stats on a unit/function change', () => {
    const { result, rerender } = streamHook(
      makeReading({ ts: 1000, function: 'DCV', acdc: 'DC', baseValue: 1, baseUnit: 'V' }),
    );
    rerender({
      r: makeReading({ ts: 1250, function: 'DCV', acdc: 'DC', baseValue: 3, baseUnit: 'V' }),
    });
    expect(chan(result).stats.count).toBe(2);

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
    expect(chan(result).segment?.function).toBe('OHM');
    expect(chan(result).segment?.seg).toBe(1);
    expect(chan(result).stats.count).toBe(1); // stats reset, not averaged across V and Ω
    expect(chan(result).stats.max).toBe(100);
  });

  it('also splits on an AC/DC flip of the same function', () => {
    const { result, rerender } = streamHook(
      makeReading({ ts: 1000, function: 'ACV', acdc: 'DC', baseValue: 1, baseUnit: 'V' }),
    );
    rerender({
      r: makeReading({ ts: 1250, function: 'ACV', acdc: 'AC', baseValue: 2, baseUnit: 'V' }),
    });
    expect(chan(result).segment?.seg).toBe(1);
    expect(chan(result).stats.count).toBe(1);
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
    expect(chan(result).segment?.seg).toBe(0); // same quantity → same segment
    expect(chan(result).stats.count).toBe(2);
  });
});

describe('useRecorder multi-channel', () => {
  it('tracks two independent channels with separate buffers + stats', () => {
    const mk = (vv: number, ii: number): RecordableChannel[] => [
      {
        id: 'v',
        label: 'V',
        kind: 'meter',
        reading: makeReading({ ts: 1000 + vv, baseValue: vv, baseUnit: 'V', function: 'DCV' }),
      },
      {
        id: 'i',
        label: 'I',
        kind: 'meter',
        reading: makeReading({
          ts: 1000 + ii,
          baseValue: ii,
          baseUnit: 'A',
          function: 'DCA',
          acdc: 'DC',
        }),
      },
    ];
    const { result, rerender } = renderHook(({ p }) => useRecorder(p), {
      initialProps: { p: mk(1, 5) },
    });
    rerender({ p: mk(2, 6) });
    rerender({ p: mk(3, 7) });

    const v = result.current.channels.find(c => c.id === 'v')!;
    const i = result.current.channels.find(c => c.id === 'i')!;
    expect(v.stats.max).toBe(3);
    expect(v.segment?.unit).toBe('V');
    expect(i.stats.max).toBe(7);
    expect(i.segment?.unit).toBe('A');
  });
});
