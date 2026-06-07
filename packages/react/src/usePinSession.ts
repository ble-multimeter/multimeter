// React binding for the PinRecorder engine (per-item pin capture). Thin adapter over
// @mbtech-nl/multimeter-recorder.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Reading } from '@mbtech-nl/multimeter-protocol';
import { PinRecorder } from '@mbtech-nl/multimeter-recorder';

export interface PinSession {
  active: boolean;
  readings: Reading[];
  pin: (r: Reading) => void;
  undoLast: () => void;
  stop: () => void;
}

export function usePinSession(): PinSession {
  const ref = useRef<PinRecorder | null>(null);
  ref.current ??= new PinRecorder();
  const pins = ref.current;

  const snap = useSyncExternalStore(pins.subscribe, pins.getSnapshot);

  useEffect(() => () => pins.dispose(), [pins]);

  return { ...snap, pin: pins.pin, undoLast: pins.undoLast, stop: pins.stop };
}
