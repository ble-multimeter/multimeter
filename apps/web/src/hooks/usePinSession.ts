// Pin session (per-item capture, e.g. matching resistors). A pin session is just a normal
// recording Session you build by hand: each "pin" appends one Reading instead of streaming.
// So it lands in the same IndexedDB store as stream recordings and shows up in Recordings,
// opens in the viewer, and exports to CSV through the exact same paths — no parallel format.
//
// Independent of useRecorder (a stream recording and a pin session can both be open). The
// first pin auto-starts a session; Stop finalizes it; the next pin starts a fresh one.

import { useCallback, useRef, useState } from 'react';
import { quantityKey, type Reading, type Session } from '../ble/types';
import * as storage from '../lib/storage';

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Session.segments from the captured readings (range changes stay one segment; a quantity
// change starts the next) — the same rule csv/SessionsList re-derive, kept consistent here.
function deriveSegments(readings: Reading[]): Session['segments'] {
  const out: Session['segments'] = [];
  let key: string | null = null;
  let seg = -1;
  for (const r of readings) {
    const k = quantityKey(r);
    if (k !== key) {
      key = k;
      seg++;
      out.push({ seg, function: r.function, acdc: r.acdc, unit: r.baseUnit });
    }
  }
  return out;
}

export interface PinSession {
  active: boolean;
  readings: Reading[]; // the active session's captures, for the live spread summary + list
  pin: (r: Reading) => void;
  undoLast: () => void;
  stop: () => void;
}

export function usePinSession(): PinSession {
  const [active, setActive] = useState(false);
  const [readings, setReadings] = useState<Reading[]>([]);
  // Source of truth for the running session; refs (not state) so side effects stay out of the
  // render path and StrictMode's double-invoked updaters can't double-write to IndexedDB.
  const sessionRef = useRef<Session | null>(null);
  const readingsRef = useRef<Reading[]>([]);

  const persistMeta = (rs: Reading[]) => {
    const s = sessionRef.current!;
    const updated: Session = {
      ...s,
      sampleCount: rs.length,
      segments: deriveSegments(rs),
      endedAt: null,
    };
    sessionRef.current = updated;
    void storage.updateSession(updated);
  };

  const pin = useCallback((r: Reading) => {
    if (!sessionRef.current) {
      const session: Session = {
        id: newId(),
        name: `Pins ${new Date().toLocaleString()}`,
        startedAt: Date.now(),
        endedAt: null,
        sampleCount: 0,
        segments: [],
      };
      sessionRef.current = session;
      readingsRef.current = [];
      void storage.createSession(session);
      setActive(true);
    }
    const seq = readingsRef.current.length;
    const next = [...readingsRef.current, r];
    readingsRef.current = next;
    void storage.appendSamples(sessionRef.current.id, seq, [r]);
    persistMeta(next);
    setReadings(next);
  }, []);

  const undoLast = useCallback(() => {
    const s = sessionRef.current;
    if (!s || readingsRef.current.length === 0) return;
    const seq = readingsRef.current.length - 1;
    const next = readingsRef.current.slice(0, -1);
    readingsRef.current = next;
    void storage.deleteSample(s.id, seq);
    persistMeta(next);
    setReadings(next);
  }, []);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    void storage.updateSession({ ...s, endedAt: Date.now() });
    sessionRef.current = null;
    readingsRef.current = [];
    setActive(false);
    setReadings([]);
  }, []);

  return { active, readings, pin, undoLast, stop };
}
