// Vue binding for the multi-channel RecorderSession engine (Phase 7). Feeds a reactive channels
// source (meter + derived channels with their latest readings) into the engine and exposes its
// snapshot as computed refs. Mirrors the React useRecorder over the same engine.

import { computed, shallowRef, watch, toValue, onScopeDispose, type MaybeRefOrGetter } from 'vue';
import type { Reading } from '@ble-multimeter/protocol';
import { RecorderSession, type ChannelSpec } from '@ble-multimeter/recorder';

export type { RecState, SegmentInfo, ChannelView } from '@ble-multimeter/recorder';

// The minimal per-channel shape the recorder needs (matches the React binding's RecordableChannel).
export interface RecordableChannel {
  id: string;
  label: string;
  kind: 'meter' | 'derived';
  role?: string;
  op?: ChannelSpec['op'];
  aChannelId?: string;
  bChannelId?: string;
  reading: Reading | null;
}

export function useRecorder(channels: MaybeRefOrGetter<RecordableChannel[]>) {
  const rec = new RecorderSession();
  const snap = shallowRef(rec.getSnapshot());
  const unsub = rec.subscribe(() => {
    snap.value = rec.getSnapshot();
  });

  watch(
    () => toValue(channels),
    cs => {
      rec.setChannels(
        cs.map(c => ({
          id: c.id,
          label: c.label,
          kind: c.kind,
          role: c.role,
          op: c.op,
          a: c.aChannelId,
          b: c.bChannelId,
        })),
      );
      for (const c of cs) rec.push(c.id, c.reading);
    },
    { immediate: true, flush: 'sync' },
  );

  onScopeDispose(() => {
    unsub();
    rec.dispose();
  });

  return {
    channels: computed(() => snap.value.channels),
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
