// SessionsStore against an in-memory IndexedDB (fake-indexeddb). 'auto' wires the global
// indexedDB before storage.ts opens a connection. The store's mutators are fire-and-forget
// (they kick off a storage promise and return void), so each assertion follows a microtask
// flush — mirroring session.test.ts.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionsStore, exportSessionCsv } from './sessions';
import { createSession, appendSamples, getSession, getReadings } from './storage';
import type { Reading, Session } from '@ble-multimeter/protocol';

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

const session = (id: string, name = 'test', startedAt = 1000): Session => ({
  id,
  name,
  startedAt,
  endedAt: null,
  sampleCount: 0,
  segments: [],
});

// Two ticks: the store's mutators chain several awaits (openDb -> request -> set) before the
// snapshot settles, and the shared fake-indexeddb can need an extra macrotask under load.
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe('SessionsStore', () => {
  it('starts with an empty snapshot', () => {
    const store = new SessionsStore();
    expect(store.getSnapshot()).toEqual({ list: [], opened: null });
  });

  it('refresh lists persisted sessions newest-first and notifies subscribers', async () => {
    await createSession(session('list-old', 'old', 100));
    await createSession(session('list-new', 'new', 9999));

    const store = new SessionsStore();
    let notified = 0;
    store.subscribe(() => (notified += 1));

    store.refresh();
    await flush();

    const ids = store.getSnapshot().list.map((s) => s.id);
    expect(ids).toContain('list-old');
    expect(ids).toContain('list-new');
    expect(ids.indexOf('list-new')).toBeLessThan(ids.indexOf('list-old'));
    expect(notified).toBe(1);
  });

  it('open loads a session together with its full-resolution readings', async () => {
    await createSession(session('open-1', 'opened'));
    await appendSamples('open-1', 0, [reading(1, 10), reading(2, 20)]);

    const store = new SessionsStore();
    let notified = 0;
    store.subscribe(() => (notified += 1));

    store.open('open-1');
    await flush();

    const opened = store.getSnapshot().opened;
    expect(opened?.session.id).toBe('open-1');
    expect(opened?.session.name).toBe('opened');
    expect(opened?.readings.map((r) => r.baseValue)).toEqual([10, 20]);
    expect(notified).toBe(1);
  });

  it('open of a missing id leaves the snapshot untouched', async () => {
    const store = new SessionsStore();
    let notified = 0;
    store.subscribe(() => (notified += 1));

    store.open('does-not-exist');
    await flush();

    expect(store.getSnapshot().opened).toBeNull();
    expect(notified).toBe(0); // no session => set() never called
  });

  it('close clears the opened session and notifies', async () => {
    await createSession(session('close-1'));
    const store = new SessionsStore();
    store.open('close-1');
    await flush();
    expect(store.getSnapshot().opened).not.toBeNull();

    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.close();

    expect(store.getSnapshot().opened).toBeNull();
    expect(notified).toBe(1);
  });

  it('rename updates the persisted metadata and the list, and patches the opened session', async () => {
    await createSession(session('ren-1', 'before'));
    const store = new SessionsStore();
    store.open('ren-1');
    await flush();

    store.rename('ren-1', 'after');
    await flush();

    expect((await getSession('ren-1'))?.name).toBe('after');
    expect(store.getSnapshot().opened?.session.name).toBe('after');
    expect(store.getSnapshot().list.find((s) => s.id === 'ren-1')?.name).toBe('after');
  });

  it('rename of a non-opened session still updates storage and refreshes the list', async () => {
    await createSession(session('ren-2', 'x'));
    const store = new SessionsStore();
    store.refresh();
    await flush();

    store.rename('ren-2', 'y');
    await flush();

    expect((await getSession('ren-2'))?.name).toBe('y');
    expect(store.getSnapshot().opened).toBeNull();
    expect(store.getSnapshot().list.find((s) => s.id === 'ren-2')?.name).toBe('y');
  });

  it('remove deletes the session (and its samples) and drops it from the list', async () => {
    await createSession(session('del-1'));
    await appendSamples('del-1', 0, [reading(1, 1)]);

    const store = new SessionsStore();
    store.refresh();
    await flush();
    expect(store.getSnapshot().list.find((s) => s.id === 'del-1')).toBeDefined();

    store.remove('del-1');
    await flush();

    expect(store.getSnapshot().list.find((s) => s.id === 'del-1')).toBeUndefined();
    expect(await getSession('del-1')).toBeUndefined();
    expect(await getReadings('del-1')).toEqual([]);
  });

  it('remove closes the opened session when it is the one being deleted', async () => {
    await createSession(session('del-open'));
    const store = new SessionsStore();
    store.open('del-open');
    await flush();
    expect(store.getSnapshot().opened?.session.id).toBe('del-open');

    store.remove('del-open');
    await flush();

    expect(store.getSnapshot().opened).toBeNull();
  });

  it('remove keeps a different opened session intact', async () => {
    await createSession(session('keep-open'));
    await createSession(session('del-other'));
    const store = new SessionsStore();
    store.open('keep-open');
    await flush();

    store.remove('del-other');
    await flush();

    expect(store.getSnapshot().opened?.session.id).toBe('keep-open');
    expect(store.getSnapshot().list.find((s) => s.id === 'del-other')).toBeUndefined();
  });

  it('dispose stops notifying former subscribers', async () => {
    await createSession(session('disp-1'));
    const store = new SessionsStore();
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.dispose();

    store.refresh();
    await flush();

    expect(notified).toBe(0);
  });

  it('subscribe returns an unsubscribe that stops further notifications', async () => {
    await createSession(session('unsub-1'));
    const store = new SessionsStore();
    let notified = 0;
    const off = store.subscribe(() => (notified += 1));
    off();

    store.refresh();
    await flush();

    expect(notified).toBe(0);
  });
});

// CSV export reads full-resolution readings from IndexedDB and hands them to the DOM download
// helper. The recorder project runs in node, so we stub URL/document the same way
// download.test.ts does and assert the filename + that a download was triggered.
describe('SessionsStore CSV export', () => {
  let anchor: { href: string; download: string; click: ReturnType<typeof vi.fn> };
  const FAKE_URL = 'blob:fake-export';

  function stubDom() {
    anchor = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => FAKE_URL),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor as unknown as HTMLAnchorElement),
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exportSessionCsv slugs the name into the filename and triggers a download', async () => {
    await createSession(session('exp-1', 'My Export'));
    await appendSamples('exp-1', 0, [reading(1, 42)]);
    stubDom();

    await exportSessionCsv({ id: 'exp-1', name: 'My Export' });

    expect(anchor.download).toBe('My-Export.csv');
    expect(anchor.href).toBe(FAKE_URL);
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it('SessionsStore.exportCsv delegates to the standalone exporter', async () => {
    const sess = session('exp-2', 'Other');
    await createSession(sess);
    await appendSamples('exp-2', 0, [reading(1, 1), reading(2, 2)]);
    stubDom();

    const store = new SessionsStore();
    store.exportCsv(sess);
    await flush();

    expect(anchor.download).toBe('Other.csv');
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });
});
