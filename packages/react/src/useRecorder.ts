// React binding for the multi-channel RecorderSession engine (Phase 7). Given the current set of
// channels (meter + derived) with their latest readings, it registers them with the engine and
// feeds each channel's newest reading in. The engine owns all buffer/stats/segmenting/persistence
// (@ble-multimeter/recorder); this adapter just mirrors its snapshot and wires the channel feed.
//
// Replaces the old single-channel useRecorder(reading) — single meter is just one channel.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Reading } from '@ble-multimeter/protocol';
import { RecorderSession, type RecorderSnapshot, type ChannelSpec } from '@ble-multimeter/recorder';

export type { RecState, SegmentInfo, ChannelView } from '@ble-multimeter/recorder';

// The minimal per-channel shape the recorder needs: who the channel is + its latest reading. The
// MetersSession Channel type structurally satisfies this (meter and derived channels both carry
// id/label/kind/reading), so the app passes `meters.channels` straight through.
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

export interface Recorder extends RecorderSnapshot {
  resetStats: () => void;
  record: (name: string) => void;
  // pause/stop resolve once the final persistence write commits (the UI ignores the promise).
  pause: () => Promise<void>;
  resume: () => void;
  stop: () => Promise<void>;
}

export function useRecorder(channels: RecordableChannel[]): Recorder {
  const ref = useRef<RecorderSession | null>(null);
  ref.current ??= new RecorderSession();
  const rec = ref.current;

  const snap = useSyncExternalStore(rec.subscribe, rec.getSnapshot);

  // Keep the engine's registered channel set in sync with the live channels (id/label/derived
  // refs). A stable key avoids re-registering on every reading tick.
  const specKey = channels
    .map(
      c => `${c.id}:${c.label}:${c.kind}:${c.op ?? ''}:${c.aChannelId ?? ''}:${c.bChannelId ?? ''}`,
    )
    .join('|');
  useEffect(() => {
    const specs: ChannelSpec[] = channels.map(c => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      role: c.role,
      op: c.op,
      a: c.aChannelId,
      b: c.bChannelId,
    }));
    rec.setChannels(specs);
    // specKey captures everything the engine cares about; channels/rec are stable refs in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, rec]);

  // Feed each channel's latest reading. Dedup is per (channel, ts) inside the engine, so re-feeding
  // an unchanged reading on a sibling channel's tick is harmless.
  useEffect(() => {
    for (const c of channels) rec.push(c.id, c.reading);
  }, [channels, rec]);

  useEffect(() => () => rec.dispose(), [rec]);

  return {
    ...snap,
    resetStats: rec.resetStats,
    record: rec.record,
    pause: rec.pause,
    resume: rec.resume,
    stop: rec.stop,
  };
}
