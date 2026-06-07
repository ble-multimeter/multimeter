// Backs the Sessions list (PLAN §3.3): browse persisted recordings, reopen one read-only,
// re-export its CSV, rename, or delete. All data comes from lib/storage; this hook just
// holds the list + the currently-opened session in React state.

import { useCallback, useEffect, useState } from 'react';
import type { Reading, Session } from '../ble/types';
import * as storage from '../lib/storage';
import { toCsv } from '../lib/csv';
import { downloadText, slug } from '../lib/download';

export interface OpenedSession {
  session: Session;
  readings: Reading[]; // full resolution, for the read-only chart/stats + export
}

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
  const [list, setList] = useState<Session[]>([]);
  const [opened, setOpened] = useState<OpenedSession | null>(null);

  const refresh = useCallback(() => {
    void storage.listSessions().then(setList);
  }, []);

  useEffect(refresh, [refresh]);

  const open = useCallback((id: string) => {
    void Promise.all([storage.getSession(id), storage.getReadings(id)]).then(
      ([session, readings]) => {
        if (session) setOpened({ session, readings });
      },
    );
  }, []);

  const close = useCallback(() => setOpened(null), []);

  const remove = useCallback(
    (id: string) => {
      void storage.deleteSession(id).then(() => {
        setOpened((o) => (o?.session.id === id ? null : o));
        refresh();
      });
    },
    [refresh],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      void storage.renameSession(id, name).then(() => {
        setOpened((o) => (o?.session.id === id ? { ...o, session: { ...o.session, name } } : o));
        refresh();
      });
    },
    [refresh],
  );

  // Re-export from the durable full-resolution store — not the decimated chart (§3.3).
  const exportCsv = useCallback((session: Session) => {
    void storage.getReadings(session.id).then((readings) => {
      downloadText(toCsv(readings), `${slug(session.name)}.csv`);
    });
  }, []);

  return { list, opened, refresh, open, close, remove, rename, exportCsv };
}
