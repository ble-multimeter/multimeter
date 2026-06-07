import { describe, it, expect } from 'vitest';
import { effectScope, ref, shallowRef, nextTick } from 'vue';
import { useRecorder } from './useRecorder';
import { useMeter } from './useMeter';
import type { Reading } from '@ble-multimeter/protocol';

function reading(over: Partial<Reading> = {}): Reading {
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
    ...over,
  };
}

describe('vue useRecorder', () => {
  it('feeds a reactive reading source and exposes windowed stats', () => {
    const scope = effectScope();
    const r = ref<Reading | null>(reading({ ts: 1, baseValue: 2 }));
    const api = scope.run(() => useRecorder(r))!;

    expect(api.samples.value).toHaveLength(1);
    r.value = reading({ ts: 2, baseValue: 4 });
    r.value = reading({ ts: 3, baseValue: 6 });

    expect(api.samples.value).toHaveLength(3);
    expect(api.stats.value.min).toBe(2);
    expect(api.stats.value.max).toBe(6);
    expect(api.stats.value.avg).toBe(4);
    scope.stop();
  });

  it('exposes the full snapshot as computed refs and tracks the recording lifecycle', async () => {
    const scope = effectScope();
    // shallowRef so the Reading isn't wrapped in a deep reactive proxy — recording persists it
    // to IndexedDB, and a Vue proxy isn't structured-cloneable.
    const r = shallowRef<Reading | null>(reading({ ts: 1 }));
    const api = scope.run(() => useRecorder(r))!;

    // Initial snapshot shape — read every computed ref so each adapter line is exercised.
    expect(api.truncated.value).toBe(false);
    expect(api.segment.value?.function).toBe('DCV');
    expect(typeof api.statsDurationMs.value).toBe('number');
    expect(api.recState.value).toBe('idle');
    expect(api.recCount.value).toBe(0);
    expect(api.csvTarget.value).toBeNull();

    // record() → recording; csvTarget surfaces; a fed reading increments the persisted count.
    api.record('Bench');
    await nextTick();
    expect(api.recState.value).toBe('recording');
    expect(api.csvTarget.value?.name).toBe('Bench');

    r.value = reading({ ts: 2, baseValue: 3 });
    await nextTick();
    expect(api.recCount.value).toBe(1);

    api.pause();
    await nextTick();
    expect(api.recState.value).toBe('paused');

    api.resume();
    await nextTick();
    expect(api.recState.value).toBe('recording');

    api.resetStats();
    api.stop();
    await nextTick();
    expect(api.recState.value).toBe('idle');
    // stop() fires a final IndexedDB flush asynchronously; let it settle before tearing the
    // scope down so the deferred persistence completes inside the test boundary.
    await new Promise((r) => setTimeout(r, 0));
    scope.stop();
  });

  it('onScopeDispose unsubscribes: no reactive update after scope.stop()', async () => {
    const scope = effectScope();
    const r = ref<Reading | null>(reading({ ts: 1 }));
    const api = scope.run(() => useRecorder(r))!;
    expect(api.samples.value).toHaveLength(1);

    scope.stop(); // onScopeDispose → unsub() + rec.dispose()
    r.value = reading({ ts: 2 }); // the watcher is torn down with the scope
    await nextTick();
    expect(api.samples.value).toHaveLength(1);
  });
});

describe('vue useMeter', () => {
  it('exposes the unsupported state without Web Bluetooth', () => {
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    const scope = effectScope();
    const api = scope.run(() => useMeter())!;
    expect(api.state.value).toBe('unsupported');
    scope.stop();
  });
});
