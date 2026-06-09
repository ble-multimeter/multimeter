import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Session } from '@ble-multimeter/protocol';
import { storage } from '@ble-multimeter/recorder';
import { useSessions } from './useSessions';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    name: 'Recording 1',
    startedAt: 1000,
    endedAt: 2000,
    sampleCount: 0,
    channels: [],
    ...over,
  };
}

// Each test gets a clean IndexedDB so the SessionsStore.refresh() list is deterministic.
beforeEach(async () => {
  for (const s of await storage.listSessions()) await storage.deleteSession(s.id);
});

describe('useSessions', () => {
  it('returns the empty initial snapshot shape and bound actions', () => {
    const { result } = renderHook(() => useSessions());
    expect(result.current.list).toEqual([]);
    expect(result.current.opened).toBeNull();
    for (const fn of ['refresh', 'open', 'close', 'remove', 'rename', 'exportCsv'] as const) {
      expect(typeof result.current[fn]).toBe('function');
    }
  });

  it('reflects a persisted session in the list after mount refresh()', async () => {
    await storage.createSession(makeSession({ id: 'a', name: 'Bench run' }));
    const { result } = renderHook(() => useSessions());
    // The mount effect calls store.refresh(); the async list resolves into a re-render.
    await waitFor(() => expect(result.current.list).toHaveLength(1));
    expect(result.current.list[0]?.name).toBe('Bench run');
  });

  it('re-renders when an action mutates the engine state (open then close)', async () => {
    await storage.createSession(makeSession({ id: 'a', name: 'Probe' }));
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.list).toHaveLength(1));

    act(() => result.current.open('a'));
    await waitFor(() => expect(result.current.opened?.session.id).toBe('a'));
    expect(result.current.opened?.session.name).toBe('Probe');

    act(() => result.current.close());
    expect(result.current.opened).toBeNull();
  });

  it('reflects a rename and a remove back into the list', async () => {
    await storage.createSession(makeSession({ id: 'a', name: 'Old' }));
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.list).toHaveLength(1));

    act(() => result.current.rename('a', 'New'));
    await waitFor(() => expect(result.current.list[0]?.name).toBe('New'));

    act(() => result.current.remove('a'));
    await waitFor(() => expect(result.current.list).toHaveLength(0));
  });

  it('stops reflecting engine changes after unmount', async () => {
    await storage.createSession(makeSession({ id: 'a' }));
    const { result, unmount } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.list).toHaveLength(1));

    // Unmount runs the effect cleanup (store.dispose → listeners cleared); a later refresh
    // must neither throw nor try to update the unmounted component.
    expect(() => unmount()).not.toThrow();
    expect(() => result.current.refresh()).not.toThrow();
  });
});
