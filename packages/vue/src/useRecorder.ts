// Vue binding for the RecorderSession engine. Feeds a reactive reading source into the engine
// and exposes its snapshot as computed refs.

import { computed, shallowRef, watch, toValue, onScopeDispose, type MaybeRefOrGetter } from 'vue';
import type { Reading } from '@mbtech-nl/multimeter-protocol';
import { RecorderSession } from '@mbtech-nl/multimeter-recorder';

export type { RecState, SegmentInfo } from '@mbtech-nl/multimeter-recorder';

export function useRecorder(reading: MaybeRefOrGetter<Reading | null>) {
  const rec = new RecorderSession();
  const snap = shallowRef(rec.getSnapshot());
  const unsub = rec.subscribe(() => {
    snap.value = rec.getSnapshot();
  });

  watch(
    () => toValue(reading),
    (r) => rec.push(r),
    { immediate: true, flush: 'sync' },
  );

  onScopeDispose(() => {
    unsub();
    rec.dispose();
  });

  return {
    samples: computed(() => snap.value.samples),
    truncated: computed(() => snap.value.truncated),
    segment: computed(() => snap.value.segment),
    stats: computed(() => snap.value.stats),
    statsDurationMs: computed(() => snap.value.statsDurationMs),
    recState: computed(() => snap.value.recState),
    recCount: computed(() => snap.value.recCount),
    csvTarget: computed(() => snap.value.csvTarget),
    resetStats: rec.resetStats,
    record: rec.record,
    pause: rec.pause,
    resume: rec.resume,
    stop: rec.stop,
  };
}
