// Storage round-trips against an in-memory IndexedDB (fake-indexeddb). 'auto' wires the
// global indexedDB/IDBKeyRange before storage.ts opens a connection.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  createSession,
  appendSamples,
  getReadings,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  renameSession,
} from './storage';
import type { Reading, Session } from '../ble/types';

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

const reading = (ts: number, v: number): Reading => ({
  ts,
  function: 'DCV',
  displayText: String(v),
  displayValue: v,
  displayUnit: 'V',
  baseValue: v,
  baseUnit: 'V',
  overload: false,
  acdc: 'DC',
  bargraph: 0,
  flags: { ...noFlags },
});

const session = (id: string, name = 'test'): Session => ({
  id,
  name,
  startedAt: 1000,
  endedAt: null,
  sampleCount: 0,
  segments: [],
});

describe('storage', () => {
  it('creates, lists, and reads back a session with its samples in order', async () => {
    await createSession(session('s1'));
    await appendSamples('s1', 0, [reading(1, 10), reading(2, 20)]);
    await appendSamples('s1', 2, [reading(3, 30)]); // second batch continues the seq

    const readings = await getReadings('s1');
    expect(readings.map((r) => r.baseValue)).toEqual([10, 20, 30]);

    const list = await listSessions();
    expect(list.find((s) => s.id === 's1')).toBeDefined();
  });

  it("keeps each session's samples isolated", async () => {
    await createSession(session('a'));
    await createSession(session('b'));
    await appendSamples('a', 0, [reading(1, 1)]);
    await appendSamples('b', 0, [reading(1, 99), reading(2, 98)]);

    expect((await getReadings('a')).map((r) => r.baseValue)).toEqual([1]);
    expect((await getReadings('b')).map((r) => r.baseValue)).toEqual([99, 98]);
  });

  it('updates session metadata (finish) in place', async () => {
    await createSession(session('s2'));
    const s = (await getSession('s2'))!;
    await updateSession({ ...s, endedAt: 5000, sampleCount: 3 });
    const after = await getSession('s2');
    expect(after?.endedAt).toBe(5000);
    expect(after?.sampleCount).toBe(3);
  });

  it('renames a session', async () => {
    await createSession(session('s3', 'old'));
    await renameSession('s3', 'new');
    expect((await getSession('s3'))?.name).toBe('new');
  });

  it('deletes a session and all its samples', async () => {
    await createSession(session('s4'));
    await appendSamples('s4', 0, [reading(1, 1), reading(2, 2)]);
    await deleteSession('s4');

    expect(await getSession('s4')).toBeUndefined();
    expect(await getReadings('s4')).toEqual([]);
  });

  it('lists sessions newest-first', async () => {
    await createSession({ ...session('old'), startedAt: 100 });
    await createSession({ ...session('new'), startedAt: 9999 });
    const ids = (await listSessions()).map((s) => s.id);
    expect(ids.indexOf('new')).toBeLessThan(ids.indexOf('old'));
  });
});
