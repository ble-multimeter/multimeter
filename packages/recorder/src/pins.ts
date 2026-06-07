// PinRecorder — a pin session (per-item capture, e.g. matching resistors). A pin session is
// just a normal recording Session built by hand: each "pin" appends one Reading instead of
// streaming. So it lands in the same store as stream recordings and shows up in Recordings,
// opens in the viewer, and exports to CSV through the exact same paths — no parallel format.
//
// Independent of RecorderSession (a stream recording and a pin session can both be open). The
// first pin auto-starts a session; stop() finalizes it; the next pin starts a fresh one.
// Extracted from the React usePinSession hook.

import { quantityKey, type Reading, type Session } from '@mbtech-nl/multimeter-protocol';
import * as storage from './storage';

const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Session.segments from the captured readings (range changes stay one segment; a quantity
// change starts the next) — the same rule csv re-derives, kept consistent here.
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

export interface PinSnapshot {
  active: boolean;
  readings: Reading[]; // the active session's captures, for the live spread summary + list
}

export class PinRecorder {
  private snap: PinSnapshot = { active: false, readings: [] };
  private listeners = new Set<() => void>();
  private session: Session | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): PinSnapshot => this.snap;

  private set(partial: Partial<PinSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    for (const l of this.listeners) l();
  }

  private persistMeta(rs: Reading[]): void {
    const s = this.session!;
    const updated: Session = {
      ...s,
      sampleCount: rs.length,
      segments: deriveSegments(rs),
      endedAt: null,
    };
    this.session = updated;
    void storage.updateSession(updated);
  }

  pin = (r: Reading): void => {
    if (!this.session) {
      const session: Session = {
        id: newId(),
        name: `Pins ${new Date().toLocaleString()}`,
        startedAt: Date.now(),
        endedAt: null,
        sampleCount: 0,
        segments: [],
      };
      this.session = session;
      void storage.createSession(session);
      this.set({ active: true, readings: [] });
    }
    const seq = this.snap.readings.length;
    const next = [...this.snap.readings, r];
    void storage.appendSamples(this.session.id, seq, [r]);
    this.persistMeta(next);
    this.set({ readings: next });
  };

  undoLast = (): void => {
    const s = this.session;
    if (!s || this.snap.readings.length === 0) return;
    const seq = this.snap.readings.length - 1;
    const next = this.snap.readings.slice(0, -1);
    void storage.deleteSample(s.id, seq);
    this.persistMeta(next);
    this.set({ readings: next });
  };

  stop = (): void => {
    const s = this.session;
    if (!s) return;
    void storage.updateSession({ ...s, endedAt: Date.now() });
    this.session = null;
    this.set({ active: false, readings: [] });
  };

  dispose = (): void => {
    this.listeners.clear();
  };
}
