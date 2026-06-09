import { describe, it, expect, beforeEach } from 'vitest';
import { effectScope, nextTick } from 'vue';
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

// Wait for the async storage promises behind refresh()/open() to flush into the snapshot ref.
// IndexedDB (fake-indexeddb) settles on the macrotask queue, so we must yield via setTimeout
// (not just microtasks) before letting Vue's reactivity flush the computed refs.
async function flush(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) {
    await new Promise(r => setTimeout(r, 0));
    await nextTick();
  }
}

beforeEach(async () => {
  for (const s of await storage.listSessions()) await storage.deleteSession(s.id);
});

describe('vue useSessions', () => {
  it('exposes the empty initial snapshot as reactive refs', () => {
    const scope = effectScope();
    const api = scope.run(() => useSessions())!;
    expect(api.list.value).toEqual([]);
    expect(api.opened.value).toBeNull();
    scope.stop();
  });

  it('reflects a persisted session after the mount refresh()', async () => {
    await storage.createSession(makeSession({ id: 'a', name: 'Bench run' }));
    const scope = effectScope();
    const api = scope.run(() => useSessions())!;
    await flush(() => api.list.value.length === 1);
    expect(api.list.value).toHaveLength(1);
    expect(api.list.value[0]?.name).toBe('Bench run');
    scope.stop();
  });

  it('reflects open → close and rename → remove through the engine', async () => {
    await storage.createSession(makeSession({ id: 'a', name: 'Old' }));
    const scope = effectScope();
    const api = scope.run(() => useSessions())!;
    await flush(() => api.list.value.length === 1);

    api.open('a');
    await flush(() => api.opened.value?.session.id === 'a');
    expect(api.opened.value?.session.name).toBe('Old');

    api.close();
    await nextTick();
    expect(api.opened.value).toBeNull();

    api.rename('a', 'New');
    await flush(() => api.list.value[0]?.name === 'New');
    expect(api.list.value[0]?.name).toBe('New');

    api.remove('a');
    await flush(() => api.list.value.length === 0);
    expect(api.list.value).toHaveLength(0);
    scope.stop();
  });

  it('onScopeDispose unsubscribes: no reactive update after scope.stop()', async () => {
    await storage.createSession(makeSession({ id: 'a' }));
    const scope = effectScope();
    const api = scope.run(() => useSessions())!;
    await flush(() => api.list.value.length === 1);

    scope.stop(); // onScopeDispose → unsub() + store.dispose()
    await storage.createSession(makeSession({ id: 'b' }));
    api.refresh(); // engine list updates, but the detached snapshot must not
    await flush(() => false);
    expect(api.list.value).toHaveLength(1);
  });
});
