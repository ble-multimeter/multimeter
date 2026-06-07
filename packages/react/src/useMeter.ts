// React binding for the MeterSession engine. A thin adapter: one session instance per mount,
// mirrored into React via useSyncExternalStore. All connection logic lives in the engine
// (@mbtech-nl/multimeter-web-bluetooth) so this stays trivial — the Vue binding is the same
// shape over the same engine.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { MeterSession, type MeterState } from '@mbtech-nl/multimeter-web-bluetooth';
import type { Reading } from '@mbtech-nl/multimeter-protocol';

export type { MeterState };

export interface Meter {
  state: MeterState;
  reading: Reading | null;
  deviceName: string | null;
  error: string | null;
  connect: () => void;
  reconnect: () => void;
  disconnect: () => void;
  toggleBacklight: () => void;
}

export function useMeter(): Meter {
  const ref = useRef<MeterSession | null>(null);
  ref.current ??= new MeterSession();
  const session = ref.current;

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    // Demo (`?demo`) auto-connects on mount; real connects wait for a user gesture.
    if (session.isDemo) session.connect();
    return () => session.dispose();
  }, [session]);

  return {
    ...snap,
    connect: session.connect,
    reconnect: session.reconnect,
    disconnect: session.disconnect,
    toggleBacklight: session.toggleBacklight,
  };
}
