// React binding for the SessionsStore engine (Sessions list). Thin adapter over
// @ble-multimeter/recorder.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Session } from '@ble-multimeter/protocol';
import { SessionsStore, type OpenedSession, type OpenedChannel } from '@ble-multimeter/recorder';

export type { OpenedSession, OpenedChannel };

export interface Sessions {
  list: Session[];
  opened: OpenedSession | null;
  refresh: () => void;
  open: (id: string) => void;
  close: () => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  exportCsv: (session: Session) => void;
}

export function useSessions(): Sessions {
  const ref = useRef<SessionsStore | null>(null);
  ref.current ??= new SessionsStore();
  const store = ref.current;

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    store.refresh();
    return () => store.dispose();
  }, [store]);

  return {
    ...snap,
    refresh: store.refresh,
    open: store.open,
    close: store.close,
    remove: store.remove,
    rename: store.rename,
    exportCsv: store.exportCsv,
  };
}
