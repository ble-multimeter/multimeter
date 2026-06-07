import { describe, it, expect } from 'vitest';
import { effectScope, nextTick } from 'vue';
import type { Reading } from '@ble-multimeter/protocol';
import { usePinSession } from './usePinSession';

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

describe('vue usePinSession', () => {
  it('exposes the inactive initial snapshot as reactive refs', () => {
    const scope = effectScope();
    const api = scope.run(() => usePinSession())!;
    expect(api.active.value).toBe(false);
    expect(api.readings.value).toEqual([]);
    scope.stop();
  });

  it('reflects engine state changes through the shallowRef snapshot', async () => {
    const scope = effectScope();
    const api = scope.run(() => usePinSession())!;

    api.pin(reading({ baseValue: 1 }));
    await nextTick();
    expect(api.active.value).toBe(true);
    expect(api.readings.value).toHaveLength(1);

    api.pin(reading({ baseValue: 2 }));
    await nextTick();
    expect(api.readings.value).toHaveLength(2);
    expect(api.readings.value[1]?.baseValue).toBe(2);

    api.undoLast();
    await nextTick();
    expect(api.readings.value).toHaveLength(1);

    api.stop();
    await nextTick();
    expect(api.active.value).toBe(false);
    expect(api.readings.value).toEqual([]);
    scope.stop();
  });

  it('onScopeDispose unsubscribes: no reactive update after scope.stop()', async () => {
    const scope = effectScope();
    const api = scope.run(() => usePinSession())!;
    api.pin(reading({ baseValue: 1 }));
    await nextTick();
    expect(api.readings.value).toHaveLength(1);

    scope.stop(); // runs onScopeDispose → unsub() + pins.dispose()
    // A post-dispose engine mutation must not propagate to the (now-detached) snapshot ref.
    api.pin(reading({ baseValue: 9 }));
    await nextTick();
    expect(api.readings.value).toHaveLength(1);
  });
});
