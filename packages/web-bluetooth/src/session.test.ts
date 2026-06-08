import { describe, it, expect, vi, afterEach } from 'vitest';
import { MeterSession } from './session';

const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const GET_NAME = 0x5f;
const GET_DATA = 0x5d;

// A checksum-valid 19-byte DCV measurement frame (PROTOCOL §3): bytes[17..18] = Σ bytes[0..16].
function measurementFrame(): Uint8Array {
  const f = new Uint8Array(19);
  f[0] = 0xab;
  f[1] = 0xcd;
  f[2] = 0x10; // len → total 19
  f[3] = 0x02; // DCV
  f[4] = 0x30; // range '0'
  '1.000  '.split('').forEach((ch, i) => (f[5 + i] = ch.charCodeAt(0)));
  let sum = 0;
  for (let i = 0; i <= 16; i++) sum += f[i]!;
  f[17] = (sum >> 8) & 0xff;
  f[18] = sum & 0xff;
  return f;
}

// Any non-19/9/7-byte AB CD frame classifies as 'control' (the meter's name frame).
const controlFrame = () => new Uint8Array([0xab, 0xcd, 0x08, 1, 2, 3, 4, 5, 6, 7, 8]);

class FakeNotify extends EventTarget {
  uuid = ISSC_NOTIFY;
  properties = { notify: true };
  value?: DataView;
  startNotifications = vi.fn().mockResolvedValue(undefined);
  emit(frame: Uint8Array): void {
    this.value = new DataView(frame.buffer.slice(0));
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class FakeWrite extends EventTarget {
  uuid = ISSC_WRITE;
  properties = { write: false, writeWithoutResponse: true };
  constructor(private notify: FakeNotify) {
    super();
  }
  // Respond like the meter: GET-NAME → a name (control) frame; GET-DATA → a measurement.
  // Dispatch async (after the handshake registers its waiter), mirroring real notifications.
  writeValueWithoutResponse = vi.fn(async (buf: Uint8Array) => {
    const cmd = buf[3];
    setTimeout(() => {
      if (cmd === GET_NAME) this.notify.emit(controlFrame());
      else if (cmd === GET_DATA) this.notify.emit(measurementFrame());
    }, 0);
  });
}

function installMeter(name = 'UT60BT_AB') {
  const notify = new FakeNotify();
  const write = new FakeWrite(notify);
  const server = {
    connected: true,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    getPrimaryService: vi.fn().mockResolvedValue({
      getCharacteristics: vi.fn().mockResolvedValue([notify, write]),
    }),
  };
  const device = Object.assign(new EventTarget(), {
    name,
    gatt: { connect: vi.fn().mockResolvedValue(server) },
  });
  Object.defineProperty(navigator, 'bluetooth', {
    value: { requestDevice: vi.fn().mockResolvedValue(device) },
    configurable: true,
  });
  return { notify, write, server, device };
}

afterEach(() => {
  Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
});

describe('MeterSession', () => {
  it('starts idle when Web Bluetooth is present', () => {
    installMeter();
    expect(new MeterSession().getSnapshot().state).toBe('idle');
  });

  it('is unsupported without Web Bluetooth', () => {
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    expect(new MeterSession().getSnapshot().state).toBe('unsupported');
  });

  it('connects, runs the handshake, and goes live with a decoded reading', async () => {
    installMeter();
    const s = new MeterSession();
    const seen: string[] = [];
    s.subscribe(() => seen.push(s.getSnapshot().state));
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));
    const snap = s.getSnapshot();
    expect(snap.reading?.function).toBe('DCV');
    expect(snap.deviceName).toBe('UT60BT_AB');
    expect(seen).toContain('connecting');
  });

  it('returns to idle on disconnect', async () => {
    const { server } = installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));
    s.disconnect();
    expect(s.getSnapshot().state).toBe('idle');
    expect(s.getSnapshot().reading).toBeNull();
    expect(server.disconnect).toHaveBeenCalled();
  });
});

// --- FFF0 shared-service disambiguation ---
const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF0_NOTIFY = '0000fff4-0000-1000-8000-00805f9b34fb';
const FFF0_WRITE = '0000fff3-0000-1000-8000-00805f9b34fb';
// A real 6-byte owon-plus frame (from owon-plus's fixtures). Its 6-byte length is what tells it
// apart from the other FFF0 families (bdm 11, owon-old 14, voltcraft 15).
const OWON_PLUS_FRAME = Uint8Array.from([34, 240, 4, 0, 103, 132]);

// An FFF0 meter that, like the real hardware, just streams a frame once notifications start —
// no handshake. getPrimaryService resolves ONLY for FFF0 so the transport matches that profile.
function installFFF0Meter() {
  const notify = Object.assign(new EventTarget(), {
    uuid: FFF0_NOTIFY,
    properties: { notify: true },
    value: undefined as DataView | undefined,
    startNotifications: vi.fn(async function (this: { emit: (f: Uint8Array) => void }) {
      setTimeout(() => this.emit(OWON_PLUS_FRAME), 0);
    }),
    emit(this: { value?: DataView } & EventTarget, frame: Uint8Array) {
      this.value = new DataView(frame.buffer.slice(0));
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    },
  });
  const write = Object.assign(new EventTarget(), {
    uuid: FFF0_WRITE,
    properties: { write: false, writeWithoutResponse: true },
    writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
  });
  const server = {
    connected: true,
    disconnect: vi.fn(),
    getPrimaryService: vi.fn(async (uuid: string) => {
      if (uuid !== FFF0_SERVICE) throw new Error('service not present');
      return { getCharacteristics: vi.fn().mockResolvedValue([notify, write]) };
    }),
  };
  const device = Object.assign(new EventTarget(), {
    name: undefined,
    gatt: { connect: vi.fn().mockResolvedValue(server) },
  });
  Object.defineProperty(navigator, 'bluetooth', {
    value: { requestDevice: vi.fn().mockResolvedValue(device) },
    configurable: true,
  });
  return { notify, server };
}

describe('MeterSession — FFF0 disambiguation', () => {
  it('identifies the family by sniffing the first frame (owon-plus)', async () => {
    installFFF0Meter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));
    // Sniffed as owon-plus → its label surfaces (device advertised no name) and decode produced a
    // reading from the 6-byte frame (proof the right decoder was selected, not the first FFF0 one).
    expect(s.getSnapshot().deviceName).toContain('Owon');
    expect(s.getSnapshot().reading).not.toBeNull();
  });
});

// --- An FFF0 meter whose streaming behaviour we control: optionally emit nothing on subscribe
// (so we can disconnect mid-sniff), or emit an UNRECOGNIZABLE frame (so the sniffer never matches
// and the timeout fires). Mirrors installFFF0Meter; getPrimaryService resolves only for FFF0.
function installFFF0MeterCustom(opts: { onSubscribe?: Uint8Array | null } = {}) {
  const emitOnSubscribe = opts.onSubscribe;
  const notify = Object.assign(new EventTarget(), {
    uuid: FFF0_NOTIFY,
    properties: { notify: true },
    value: undefined as DataView | undefined,
    startNotifications: vi.fn(async function (this: { emit: (f: Uint8Array) => void }) {
      if (emitOnSubscribe) {
        const f = emitOnSubscribe;
        setTimeout(() => this.emit(f), 0);
      }
    }),
    emit(this: { value?: DataView } & EventTarget, frame: Uint8Array) {
      this.value = new DataView(frame.buffer.slice(0));
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    },
  });
  const write = Object.assign(new EventTarget(), {
    uuid: FFF0_WRITE,
    properties: { write: false, writeWithoutResponse: true },
    writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
  });
  const server = {
    connected: true,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    getPrimaryService: vi.fn(async (uuid: string) => {
      if (uuid !== FFF0_SERVICE) throw new Error('service not present');
      return { getCharacteristics: vi.fn().mockResolvedValue([notify, write]) };
    }),
  };
  const device = Object.assign(new EventTarget(), {
    name: undefined,
    gatt: { connect: vi.fn().mockResolvedValue(server) },
  });
  Object.defineProperty(navigator, 'bluetooth', {
    value: { requestDevice: vi.fn().mockResolvedValue(device) },
    configurable: true,
  });
  return { notify, write, server, device };
}

describe('MeterSession — reconnect (PLAN §4)', () => {
  it('re-opens and re-runs the FULL handshake after a drop', async () => {
    const { device, server, write } = installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    // Sanity: the first handshake issued GET-NAME and GET-DATA.
    const cmdsOf = () => write.writeValueWithoutResponse.mock.calls.map(c => c[0][3] as number);
    expect(cmdsOf()).toContain(GET_NAME);
    expect(cmdsOf()).toContain(GET_DATA);
    const writesBeforeDrop = write.writeValueWithoutResponse.mock.calls.length;

    // Simulate the link dropping: the device fires gattserverdisconnected.
    server.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(s.getSnapshot().state).toBe('disconnected');
    // Data is kept so the UI can still show the last value + offer reconnect.
    expect(s.getSnapshot().reading).not.toBeNull();

    // The same device re-connects on reconnect().
    server.connected = true;
    s.reconnect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    // The full handshake re-ran: more writes happened, and GET-NAME + GET-DATA were re-issued.
    const newCalls = write.writeValueWithoutResponse.mock.calls.slice(writesBeforeDrop);
    const newCmds = newCalls.map(c => c[0][3] as number);
    expect(newCmds).toContain(GET_NAME);
    expect(newCmds).toContain(GET_DATA);
  });

  it('passes through reconnecting state on its way back to live', async () => {
    const { device, server } = installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    server.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));

    const seen: string[] = [];
    s.subscribe(() => seen.push(s.getSnapshot().state));
    server.connected = true;
    s.reconnect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));
    expect(seen).toContain('reconnecting');
  });

  it('reconnect() with no prior transport falls back to connect()', async () => {
    installMeter();
    const s = new MeterSession();
    // Never connected → no transport. reconnect() must run a fresh connect (chooser + handshake).
    s.reconnect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));
    expect(s.getSnapshot().reading?.function).toBe('DCV');
  });

  it('goes to error if re-opening GATT fails on reconnect', async () => {
    const { device, server } = installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    server.connected = false;
    device.dispatchEvent(new Event('gattserverdisconnected'));

    // The next GATT open rejects → realReconnect's catch surfaces an error state.
    device.gatt.connect.mockRejectedValueOnce(new Error('radio off'));
    s.reconnect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('error'));
    expect(s.getSnapshot().error).toContain('radio off');
  });
});

describe('MeterSession — error handling', () => {
  it('returns to idle when the chooser is dismissed (NotFoundError)', async () => {
    installMeter();
    (navigator.bluetooth!.requestDevice as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new DOMException('User cancelled', 'NotFoundError'),
    );
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('idle'));
    expect(s.getSnapshot().error).toBeNull();
  });

  it('goes to error (not idle) on a non-NotFound connect failure', async () => {
    const { server } = installMeter();
    // No known service is present → openGatt throws a plain Error, not a cancel.
    server.getPrimaryService.mockRejectedValue(new Error('service not present'));
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('error'));
    expect(s.getSnapshot().error).toBeTruthy();
  });
});

describe('MeterSession — FFF0 sniff timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('errors with "could not identify" after SNIFF_TIMEOUT_MS of unrecognizable frames', async () => {
    vi.useFakeTimers();
    // 7 bytes: no FFF0 family accepts it (owon-plus 6, bdm 11, owon-old 14, voltcraft 15).
    installFFF0MeterCustom({ onSubscribe: Uint8Array.from([1, 2, 3, 4, 5, 6, 7]) });
    const s = new MeterSession();
    s.connect();

    // Let the connect promise chain + the (rejected-by-sniffer) frame settle. Still sniffing.
    await vi.advanceTimersByTimeAsync(10);
    expect(s.getSnapshot().state).toBe('connecting');

    // Advance past the 4 s sniff window → reject → error state.
    await vi.advanceTimersByTimeAsync(4000);
    expect(s.getSnapshot().state).toBe('error');
    expect(s.getSnapshot().error).toContain('could not identify');
  });
});

describe('MeterSession — disconnect during sniff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a pending identify cleanly → idle, no error, no late state change', async () => {
    vi.useFakeTimers();
    // FFF0 meter that never streams a frame, so the session stays in the sniff phase.
    installFFF0MeterCustom({ onSubscribe: null });
    const s = new MeterSession();
    s.connect();

    // Let connect reach the sniff phase (still 'connecting', deviceName set to the generic label).
    await vi.advanceTimersByTimeAsync(10);
    expect(s.getSnapshot().state).toBe('connecting');

    // User disconnects before any frame arrives — the identify is aborted as a NotFoundError cancel.
    s.disconnect();
    expect(s.getSnapshot().state).toBe('idle');
    expect(s.getSnapshot().error).toBeNull();

    // Even after the original sniff timeout window elapses, no late 'error' creeps in.
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.getSnapshot().state).toBe('idle');
    expect(s.getSnapshot().error).toBeNull();
  });
});

describe('MeterSession — demo mode', () => {
  const realLocation = window.location;
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { value: realLocation, configurable: true });
  });

  function forceDemo() {
    Object.defineProperty(window, 'location', {
      value: { ...realLocation, search: '?demo' },
      configurable: true,
    });
  }

  it('runs entirely off a timer without touching Bluetooth', async () => {
    vi.useFakeTimers();
    forceDemo();
    // Prove Bluetooth is never used: remove navigator.bluetooth entirely.
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });

    const s = new MeterSession();
    expect(s.isDemo).toBe(true);
    expect(s.getSnapshot().state).toBe('idle'); // demo is supported even without Web Bluetooth

    s.connect();
    expect(s.getSnapshot().state).toBe('live');
    expect(s.getSnapshot().deviceName).toContain('demo');

    // Advance one demo interval → a synthetic reading appears.
    await vi.advanceTimersByTimeAsync(250);
    const first = s.getSnapshot().reading;
    expect(first?.function).toBe('DCV');

    // Another interval → the reading updates (timestamp advances).
    await vi.advanceTimersByTimeAsync(250);
    expect(s.getSnapshot().reading).not.toBe(first);
  });

  it('disconnect stops the demo timer', async () => {
    vi.useFakeTimers();
    forceDemo();
    const s = new MeterSession();
    s.connect();
    await vi.advanceTimersByTimeAsync(250);
    const stopped = s.getSnapshot().reading;

    s.disconnect();
    expect(s.getSnapshot().state).toBe('idle');

    // No further readings after disconnect even as time advances.
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.getSnapshot().reading).toBeNull();
    expect(stopped).not.toBeNull();
  });
});

describe('MeterSession — toggleBacklight', () => {
  const BACKLIGHT = 0x4b;

  it('writes the backlight command for a uni-t driver', async () => {
    const { write } = installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    write.writeValueWithoutResponse.mockClear();
    s.toggleBacklight();
    await vi.waitFor(() =>
      expect(write.writeValueWithoutResponse.mock.calls.map(c => c[0][3] as number)).toContain(
        BACKLIGHT,
      ),
    );
  });

  it('is a no-op for a driver without controls (owon-plus) and does not throw', async () => {
    const { write } = installFFF0MeterCustom({ onSubscribe: OWON_PLUS_FRAME });
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    write.writeValueWithoutResponse.mockClear();
    expect(() => s.toggleBacklight()).not.toThrow();
    expect(write.writeValueWithoutResponse).not.toHaveBeenCalled();
  });
});

describe('MeterSession — sendControl', () => {
  // command byte (frame[3]) per named control, per the uni-t driver
  const CODES: Record<string, number> = {
    backlight: 0x4b,
    hold: 0x4a,
    rel: 0x48,
    select: 0x4c,
    range: 0x46,
    rangeAuto: 0x47,
    hzDuty: 0x49,
    maxMin: 0x41,
  };

  it('exposes the uni-t control set in the snapshot once live', async () => {
    installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));
    expect(s.getSnapshot().controls.sort()).toEqual(Object.keys(CODES).sort());
  });

  it.each(Object.entries(CODES))('writes the %s command frame', async (name, code) => {
    const { write } = installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    write.writeValueWithoutResponse.mockClear();
    s.sendControl(name as Parameters<MeterSession['sendControl']>[0]);
    await vi.waitFor(() =>
      expect(write.writeValueWithoutResponse.mock.calls.map(c => c[0][3] as number)).toContain(
        code,
      ),
    );
  });

  it('clears controls and is a no-op after disconnect', async () => {
    const { write } = installMeter();
    const s = new MeterSession();
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));

    s.disconnect();
    expect(s.getSnapshot().controls).toEqual([]);
    write.writeValueWithoutResponse.mockClear();
    expect(() => s.sendControl('hold')).not.toThrow();
    expect(write.writeValueWithoutResponse).not.toHaveBeenCalled();
  });
});

describe('MeterSession — external store', () => {
  it('static supported mirrors Transport.supported', () => {
    installMeter();
    expect(MeterSession.supported).toBe(true);
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    expect(MeterSession.supported).toBe(false);
  });

  it('subscribe returns an unsubscribe that stops notifications', async () => {
    installMeter();
    const s = new MeterSession();
    const fn = vi.fn();
    const unsub = s.subscribe(fn);
    s.connect();
    await vi.waitFor(() => expect(s.getSnapshot().state).toBe('live'));
    expect(fn).toHaveBeenCalled();

    unsub();
    const after = fn.mock.calls.length;
    s.disconnect(); // would notify if still subscribed
    expect(fn.mock.calls.length).toBe(after);
  });
});

describe('MeterSession — dispose', () => {
  it('clears timers/listeners without throwing (demo)', async () => {
    const realLocation = window.location;
    vi.useFakeTimers();
    Object.defineProperty(window, 'location', {
      value: { ...realLocation, search: '?demo' },
      configurable: true,
    });
    try {
      const s = new MeterSession();
      const fn = vi.fn();
      s.subscribe(fn);
      s.connect();
      await vi.advanceTimersByTimeAsync(250);

      expect(() => s.dispose()).not.toThrow();

      // Listeners detached: no notifications after dispose even as time advances.
      const callsAfterDispose = fn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn.mock.calls.length).toBe(callsAfterDispose);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'location', { value: realLocation, configurable: true });
    }
  });

  it('disposing a live session aborts a pending sniff without throwing', async () => {
    vi.useFakeTimers();
    try {
      installFFF0MeterCustom({ onSubscribe: null });
      const s = new MeterSession();
      s.connect();
      await vi.advanceTimersByTimeAsync(10);
      expect(s.getSnapshot().state).toBe('connecting');
      expect(() => s.dispose()).not.toThrow();
      // dispose() rejects the pending identify as a NotFoundError cancel → realConnect resolves to
      // idle, and crucially no 'error' state ever appears (no unhandled rejection, no late timeout).
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.getSnapshot().state).toBe('idle');
      expect(s.getSnapshot().error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
