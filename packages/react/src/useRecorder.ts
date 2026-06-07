// React binding for the RecorderSession engine. Feeds each new Reading into the engine and
// mirrors its snapshot into React. All buffer/stats/persistence logic lives in the engine
// (@mbtech-nl/multimeter-recorder).

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Reading } from '@mbtech-nl/multimeter-protocol';
import { RecorderSession, type RecorderSnapshot } from '@mbtech-nl/multimeter-recorder';

export type { RecState, SegmentInfo } from '@mbtech-nl/multimeter-recorder';

export interface Recorder extends RecorderSnapshot {
  resetStats: () => void;
  record: (name: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

export function useRecorder(reading: Reading | null): Recorder {
  const ref = useRef<RecorderSession | null>(null);
  ref.current ??= new RecorderSession();
  const rec = ref.current;

  const snap = useSyncExternalStore(rec.subscribe, rec.getSnapshot);

  useEffect(() => {
    rec.push(reading);
  }, [reading, rec]);
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
