// React binding for the MeterSession engine. A thin adapter: one session instance per mount,
// mirrored into React via useSyncExternalStore. All connection logic lives in the engine
// (@ble-multimeter/web-bluetooth) so this stays trivial — the Vue binding is the same
// shape over the same engine.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { MeterSession, type MeterState } from '@ble-multimeter/web-bluetooth';
import type { MeterControl, Reading } from '@ble-multimeter/protocol';

export type { MeterState, MeterControl };

export interface Meter {
  state: MeterState;
  reading: Reading | null;
  deviceName: string | null;
  error: string | null;
  controls: MeterControl[]; // front-panel controls the connected meter exposes
  connect: () => void;
  reconnect: () => void;
  disconnect: () => void;
  toggleBacklight: () => void;
  sendControl: (name: MeterControl) => void; // press a soft button (HOLD, RANGE, SELECT, …)
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
    sendControl: session.sendControl,
  };
}
