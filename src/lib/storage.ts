// IndexedDB persistence for recordings (PLAN §3.3). Recordings survive a reload or an
// accidental disconnect, and CSV export reads full-resolution Readings straight from here
// — never the decimated chart series (§3.3). No external DB lib; raw IndexedDB behind a
// small promise wrapper. All IO lives here so hooks/components stay storage-agnostic.

import type { Reading, Session } from '../ble/types';

const DB_NAME = 'ut60bt';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const SAMPLES = 'samples';

// One stored sample row. The composite key [sessionId, seq] keeps a session's samples
// contiguous and ordered, so a range scan reads them back in capture order.
interface SampleRow {
  sessionId: string;
  seq: number;
  r: Reading;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SAMPLES)) {
        db.createObjectStore(SAMPLES, { keyPath: ['sessionId', 'seq'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Resolve when the transaction commits (not just when the request succeeds) so callers
// can trust the data is durable before continuing.
function tx(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  body: (t: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    body(t);
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// All [sessionId, *] keys: [id] sorts before any [id, seq], and [id, []] after any of
// them (arrays rank above numbers in IndexedDB key order), so this brackets exactly one
// session's samples.
const sessionRange = (id: string) => IDBKeyRange.bound([id], [id, []]);

export async function createSession(session: Session): Promise<void> {
  const db = await openDb();
  await tx(db, SESSIONS, 'readwrite', (t) => t.objectStore(SESSIONS).put(session));
}

// Append a batch of readings under one transaction (a frame arrives a few times a second;
// the recorder buffers and flushes in batches rather than one tx per sample).
export async function appendSamples(
  sessionId: string,
  startSeq: number,
  readings: Reading[],
): Promise<void> {
  if (readings.length === 0) return;
  const db = await openDb();
  await tx(db, SAMPLES, 'readwrite', (t) => {
    const store = t.objectStore(SAMPLES);
    readings.forEach((r, i) => store.put({ sessionId, seq: startSeq + i, r } as SampleRow));
  });
}

// Delete one sample row by its composite key — used by the pin session's "undo last" to
// drop a mis-captured pin (pins always append at the end, so seq stays contiguous).
export async function deleteSample(sessionId: string, seq: number): Promise<void> {
  const db = await openDb();
  await tx(db, SAMPLES, 'readwrite', (t) => t.objectStore(SAMPLES).delete([sessionId, seq]));
}

export async function updateSession(session: Session): Promise<void> {
  const db = await openDb();
  await tx(db, SESSIONS, 'readwrite', (t) => t.objectStore(SESSIONS).put(session));
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await openDb();
  return reqResult(db.transaction(SESSIONS).objectStore(SESSIONS).get(id));
}

export async function listSessions(): Promise<Session[]> {
  const db = await openDb();
  const all = await reqResult<Session[]>(db.transaction(SESSIONS).objectStore(SESSIONS).getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt); // newest first
}

// Full-resolution Readings for a session, in capture order — the source for CSV export
// and read-only reopen.
export async function getReadings(id: string): Promise<Reading[]> {
  const db = await openDb();
  const rows = await reqResult<SampleRow[]>(
    db.transaction(SAMPLES).objectStore(SAMPLES).getAll(sessionRange(id)),
  );
  return rows.map((row) => row.r);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  await tx(db, [SESSIONS, SAMPLES], 'readwrite', (t) => {
    t.objectStore(SESSIONS).delete(id);
    t.objectStore(SAMPLES).delete(sessionRange(id));
  });
}

export async function renameSession(id: string, name: string): Promise<void> {
  const existing = await getSession(id);
  if (!existing) return;
  await updateSession({ ...existing, name });
}
