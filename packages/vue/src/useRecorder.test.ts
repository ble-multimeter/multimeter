import { describe, it, expect } from 'vitest';
import { effectScope, ref, shallowRef, nextTick } from 'vue';
import { useRecorder, type RecordableChannel } from './useRecorder';
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

// One meter channel ('v') carrying the given reading — the N=1 case.
const single = (r: Reading | null): RecordableChannel[] => [
  { id: 'v', label: 'V', kind: 'meter', reading: r },
];

// The single channel's view in the snapshot.
const vView = (api: ReturnType<typeof useRecorder>) =>
  api.channels.value.find(c => c.id === 'v')!;

describe('vue useRecorder', () => {
  it('feeds a reactive channels source and exposes windowed stats', () => {
    const scope = effectScope();
    const cs = shallowRef<RecordableChannel[]>(single(reading({ ts: 1, baseValue: 2 })));
    const api = scope.run(() => useRecorder(cs))!;

    expect(vView(api).samples).toHaveLength(1);
    cs.value = single(reading({ ts: 2, baseValue: 4 }));
    cs.value = single(reading({ ts: 3, baseValue: 6 }));

    expect(vView(api).samples).toHaveLength(3);
    expect(vView(api).stats.min).toBe(2);
    expect(vView(api).stats.max).toBe(6);
    expect(vView(api).stats.avg).toBe(4);
    scope.stop();
  });

  it('exposes the full snapshot as computed refs and tracks the recording lifecycle', async () => {
    const scope = effectScope();
    // shallowRef so the Reading isn't wrapped in a deep reactive proxy — recording persists it
    // to IndexedDB, and a Vue proxy isn't structured-cloneable.
    const cs = shallowRef<RecordableChannel[]>(single(reading({ ts: 1 })));
    const api = scope.run(() => useRecorder(cs))!;

    expect(vView(api).segment?.function).toBe('DCV');
    expect(typeof vView(api).statsDurationMs).toBe('number');
    expect(api.recState.value).toBe('idle');
    expect(api.recCount.value).toBe(0);
    expect(api.csvTarget.value).toBeNull();

    api.record('Bench');
    await nextTick();
    expect(api.recState.value).toBe('recording');
    expect(api.csvTarget.value?.name).toBe('Bench');

    cs.value = single(reading({ ts: 2, baseValue: 3 }));
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
    await new Promise(r => setTimeout(r, 0));
    scope.stop();
  });

  it('onScopeDispose unsubscribes: no reactive update after scope.stop()', async () => {
    const scope = effectScope();
    const cs = ref<RecordableChannel[]>(single(reading({ ts: 1 })));
    const api = scope.run(() => useRecorder(cs))!;
    expect(vView(api).samples).toHaveLength(1);

    scope.stop(); // onScopeDispose → unsub() + rec.dispose()
    cs.value = single(reading({ ts: 2 })); // the watcher is torn down with the scope
    await nextTick();
    expect(vView(api).samples).toHaveLength(1);
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
