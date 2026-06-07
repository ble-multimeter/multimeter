// SessionsStore — framework-agnostic backing for the Sessions list (PLAN §3.3): browse
// persisted recordings, reopen one read-only, re-export its CSV, rename, or delete. All data
// comes from storage; this just holds the list + the currently-opened session and exposes a
// subscribe/getSnapshot the React/Vue bindings mirror. Extracted from the React useSessions hook.

import { toCsv, type Reading, type Session } from '@mbtech-nl/multimeter-protocol';
import * as storage from './storage';
import { downloadText, slug } from './download';

export interface OpenedSession {
  session: Session;
  readings: Reading[]; // full resolution, for the read-only chart/stats + export
}

export interface SessionsSnapshot {
  list: Session[];
  opened: OpenedSession | null;
}

export class SessionsStore {
  private snap: SessionsSnapshot = { list: [], opened: null };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): SessionsSnapshot => this.snap;

  private set(partial: Partial<SessionsSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    for (const l of this.listeners) l();
  }

  refresh = (): void => {
    void storage.listSessions().then((list) => this.set({ list }));
  };

  open = (id: string): void => {
    void Promise.all([storage.getSession(id), storage.getReadings(id)]).then(
      ([session, readings]) => {
        if (session) this.set({ opened: { session, readings } });
      },
    );
  };

  close = (): void => this.set({ opened: null });

  remove = (id: string): void => {
    void storage.deleteSession(id).then(() => {
      if (this.snap.opened?.session.id === id) this.set({ opened: null });
      this.refresh();
    });
  };

  rename = (id: string, name: string): void => {
    void storage.renameSession(id, name).then(() => {
      const o = this.snap.opened;
      if (o?.session.id === id) this.set({ opened: { ...o, session: { ...o.session, name } } });
      this.refresh();
    });
  };

  // Re-export from the durable full-resolution store — not the decimated chart (§3.3).
  exportCsv = (session: Session): void => {
    void exportSessionCsv(session);
  };

  dispose = (): void => {
    this.listeners.clear();
  };
}

// Standalone CSV export for a recording (by id + name) — full-resolution from IndexedDB.
// Shared by SessionsStore.exportCsv and the app's export shortcut (which has no Session object).
export async function exportSessionCsv(target: { id: string; name: string }): Promise<void> {
  const readings = await storage.getReadings(target.id);
  downloadText(toCsv(readings), `${slug(target.name)}.csv`);
}
