// useMeters — thin adapter over MetersSession. The engine is exhaustively tested in
// web-bluetooth/meters.test.ts; here we just prove the React adapter mirrors the snapshot and
// re-renders on demo ticks + mutations. demoKind() reads window.location (empty → 'none'), so the
// default bootstrap is one real meter; we add demo meters explicitly and drive them with fake
// timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useMeters } from './useMeters';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useMeters', () => {
  it('mirrors the bootstrap snapshot (one meter, no derived)', () => {
    const { result, unmount } = renderHook(() => useMeters());
    expect(result.current.meters).toHaveLength(1);
    expect(result.current.derived).toHaveLength(0);
    unmount();
  });

  it('re-renders when a demo meter is added and ticks', () => {
    const { result, unmount } = renderHook(() => useMeters());
    act(() => {
      result.current.removeMeter(result.current.meters[0]!.id);
      result.current.addDemoMeter();
    });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.meters).toHaveLength(1);
    expect(result.current.meters[0]!.state).toBe('live');
    expect(result.current.meters[0]!.reading).not.toBeNull();
    unmount();
  });

  // Regression: StrictMode runs the mount effect setup→cleanup→setup, so the throwaway cleanup
  // disposes the ref-held singleton before the real mount. revive() on setup must rebuild it —
  // otherwise meterSession(id) returns undefined and the card's connect() silently no-ops (the BLE
  // chooser never opens).
  it('keeps meterSession resolvable after a StrictMode mount cycle', () => {
    const { result, unmount } = renderHook(() => useMeters(), { wrapper: StrictMode });
    const id = result.current.meters[0]!.id;
    expect(result.current.meterSession(id)).toBeDefined();
    unmount();
  });

  it('exposes the derived channel + its computed value', () => {
    const { result, unmount } = renderHook(() => useMeters());
    act(() => {
      result.current.removeMeter(result.current.meters[0]!.id);
      result.current.addDemoMeter();
      result.current.addDemoMeter();
    });
    act(() => vi.advanceTimersByTime(300));
    const volt = result.current.meters.find(c => c.reading?.baseUnit === 'V')!;
    const amp = result.current.meters.find(c => c.reading?.baseUnit === 'A')!;
    act(() => {
      result.current.addDerived({ label: 'P', op: 'mul', aChannelId: volt.id, bChannelId: amp.id });
    });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.derived).toHaveLength(1);
    expect(result.current.derived[0]!.unit).toBe('W');
    unmount();
  });
});
