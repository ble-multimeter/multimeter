// PinRecorder against an in-memory IndexedDB (fake-indexeddb). 'auto' wires the global
// indexedDB before storage.ts opens a connection. PinRecorder's mutators fire-and-forget the
// storage writes, so each storage assertion follows a microtask flush — mirroring
// session.test.ts.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { PinRecorder } from './pins';
import { listSessions, getSession, getReadings } from './storage';
import type { Reading } from '@ble-multimeter/protocol';

const noFlags = {
  max: false,
  min: false,
  hold: false,
  rel: false,
  auto: false,
  lowBattery: false,
  hvWarning: false,
  peakMax: false,
  peakMin: false,
};

const reading = (v: number): Reading => ({
  ts: v,
  function: 'OHM',
  displayText: String(v),
  displayValue: v,
  displayUnit: 'Ω',
  baseValue: v,
  baseUnit: 'Ω',
  overload: false,
  acdc: '',
  bargraph: 0,
  flags: { ...noFlags },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

// The active pin session is whichever session newest-first lands at index 0; tests create a
// fresh PinRecorder per case but share the IndexedDB, so we identify the session by name prefix.
async function latestPinSession() {
  const list = await listSessions();
  return list.find((s) => s.name.startsWith('Pins '));
}

describe('PinRecorder', () => {
  it('is inactive with no readings before the first pin', () => {
    const rec = new PinRecorder();
    expect(rec.getSnapshot()).toEqual({ active: false, readings: [] });
  });

  it('first pin creates a session, marks active, and persists the sample', async () => {
    const rec = new PinRecorder();
    let notified = 0;
    rec.subscribe(() => (notified += 1));

    rec.pin(reading(100));
    await flush();

    const snap = rec.getSnapshot();
    expect(snap.active).toBe(true);
    expect(snap.readings.map((r) => r.baseValue)).toEqual([100]);
    // pin() emits twice on first pin: once on create (active), once after appending the reading.
    expect(notified).toBe(2);

    const sess = await latestPinSession();
    expect(sess).toBeDefined();
    expect(sess?.endedAt).toBeNull();
    expect(sess?.sampleCount).toBe(1);
    const stored = await getReadings(sess!.id);
    expect(stored.map((r) => r.baseValue)).toEqual([100]);
  });

  it('subsequent pins append in capture order and keep metadata current', async () => {
    const rec = new PinRecorder();
    rec.pin(reading(220));
    rec.pin(reading(221));
    rec.pin(reading(219));
    await flush();

    expect(rec.getSnapshot().readings.map((r) => r.baseValue)).toEqual([220, 221, 219]);

    const sess = await latestPinSession();
    expect(sess?.sampleCount).toBe(3);
    expect(sess?.endedAt).toBeNull();
    expect((await getReadings(sess!.id)).map((r) => r.baseValue)).toEqual([220, 221, 219]);
  });

  it('undoLast removes the last capture from the snapshot and storage', async () => {
    const rec = new PinRecorder();
    rec.pin(reading(10));
    rec.pin(reading(20));
    rec.pin(reading(30));
    await flush();

    let notified = 0;
    rec.subscribe(() => (notified += 1));

    rec.undoLast();
    await flush();

    expect(rec.getSnapshot().readings.map((r) => r.baseValue)).toEqual([10, 20]);
    expect(notified).toBe(1);

    const sess = await latestPinSession();
    expect(sess?.sampleCount).toBe(2);
    expect((await getReadings(sess!.id)).map((r) => r.baseValue)).toEqual([10, 20]);
  });

  it('undoLast is a no-op when there is nothing recorded', async () => {
    const rec = new PinRecorder();
    let notified = 0;
    rec.subscribe(() => (notified += 1));

    rec.undoLast(); // no active session
    await flush();

    expect(rec.getSnapshot()).toEqual({ active: false, readings: [] });
    expect(notified).toBe(0);
  });

  it('undoLast does nothing once all captures are removed', async () => {
    const rec = new PinRecorder();
    rec.pin(reading(5));
    await flush();

    rec.undoLast(); // removes the only reading; session still active
    await flush();
    expect(rec.getSnapshot().readings).toEqual([]);
    expect(rec.getSnapshot().active).toBe(true);

    let notified = 0;
    rec.subscribe(() => (notified += 1));
    rec.undoLast(); // readings empty => early return
    expect(notified).toBe(0);
  });

  it('stop finalizes the session (endedAt set) and resets the recorder', async () => {
    const rec = new PinRecorder();
    rec.pin(reading(47));
    rec.pin(reading(48));
    await flush();
    const sess = await latestPinSession();

    let notified = 0;
    rec.subscribe(() => (notified += 1));

    rec.stop();
    await flush();

    expect(rec.getSnapshot()).toEqual({ active: false, readings: [] });
    expect(notified).toBe(1);

    const finalized = await getSession(sess!.id);
    expect(finalized?.endedAt).not.toBeNull();
    // The finalized session keeps its captures and appears as a normal recording.
    expect((await getReadings(sess!.id)).map((r) => r.baseValue)).toEqual([47, 48]);
    expect(finalized?.sampleCount).toBe(2);
  });

  it('stop is a no-op when no session is active', async () => {
    const rec = new PinRecorder();
    const before = (await listSessions()).length;

    rec.stop();
    await flush();

    expect(rec.getSnapshot()).toEqual({ active: false, readings: [] });
    expect((await listSessions()).length).toBe(before);
  });

  it('a pin after stop starts a fresh session', async () => {
    const rec = new PinRecorder();
    rec.pin(reading(1));
    await flush();
    const first = (await latestPinSession())!.id;

    rec.stop();
    await flush();

    rec.pin(reading(2));
    await flush();
    const second = (await latestPinSession())!.id;

    expect(second).not.toBe(first);
    expect((await getReadings(second)).map((r) => r.baseValue)).toEqual([2]);
    // The first session is finalized and untouched by the new one.
    expect((await getReadings(first)).map((r) => r.baseValue)).toEqual([1]);
  });

  it('dispose stops notifying former subscribers', () => {
    const rec = new PinRecorder();
    let notified = 0;
    rec.subscribe(() => (notified += 1));
    rec.dispose();
    rec.pin(reading(1));
    expect(notified).toBe(0);
  });
});
