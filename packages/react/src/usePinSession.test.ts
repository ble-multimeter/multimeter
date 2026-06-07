import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { makeReading } from './test-readings';
import { usePinSession } from './usePinSession';

describe('usePinSession', () => {
  it('returns the inactive initial snapshot and bound actions', () => {
    const { result } = renderHook(() => usePinSession());
    expect(result.current.active).toBe(false);
    expect(result.current.readings).toEqual([]);
    expect(typeof result.current.pin).toBe('function');
    expect(typeof result.current.undoLast).toBe('function');
    expect(typeof result.current.stop).toBe('function');
  });

  it('re-renders as pins accumulate and undoLast removes the last one', () => {
    const { result } = renderHook(() => usePinSession());

    // The first pin auto-starts a session; the snapshot flips active and appends.
    act(() => result.current.pin(makeReading({ baseValue: 1 })));
    expect(result.current.active).toBe(true);
    expect(result.current.readings).toHaveLength(1);

    act(() => result.current.pin(makeReading({ baseValue: 2 })));
    expect(result.current.readings).toHaveLength(2);
    expect(result.current.readings[1]?.baseValue).toBe(2);

    act(() => result.current.undoLast());
    expect(result.current.readings).toHaveLength(1);
    expect(result.current.readings[0]?.baseValue).toBe(1);
  });

  it('stop() finalizes: clears readings and goes inactive', () => {
    const { result } = renderHook(() => usePinSession());
    act(() => result.current.pin(makeReading({ baseValue: 1 })));
    expect(result.current.active).toBe(true);

    act(() => result.current.stop());
    expect(result.current.active).toBe(false);
    expect(result.current.readings).toEqual([]);
  });

  it('exposes identity-stable actions across re-renders', () => {
    const { result, rerender } = renderHook(() => usePinSession());
    const before = result.current;
    rerender();
    expect(result.current.pin).toBe(before.pin);
    expect(result.current.undoLast).toBe(before.undoLast);
    expect(result.current.stop).toBe(before.stop);
  });

  it('stops reflecting engine changes after unmount', () => {
    const { result, unmount } = renderHook(() => usePinSession());
    act(() => result.current.pin(makeReading()));
    // Effect cleanup calls pins.dispose() (listeners cleared); a later action must not throw.
    expect(() => unmount()).not.toThrow();
    expect(() => result.current.stop()).not.toThrow();
  });
});
