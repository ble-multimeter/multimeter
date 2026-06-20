import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { useMeter } from './useMeter';

// Same stubbed-navigator.bluetooth harness as web-bluetooth's session.test.ts, so we drive the
// MeterSession engine the Vue composable wraps and prove its computed refs track engine state.
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const GET_NAME = 0x5f;
const GET_DATA = 0x5d;

function measurementFrame(): Uint8Array {
  const f = new Uint8Array(19);
  f[0] = 0xab;
  f[1] = 0xcd;
  f[2] = 0x10;
  f[3] = 0x02; // DCV
  f[4] = 0x30;
  '1.000  '.split('').forEach((ch, i) => (f[5 + i] = ch.charCodeAt(0)));
  let sum = 0;
  for (let i = 0; i <= 16; i++) sum += f[i]!;
  f[17] = (sum >> 8) & 0xff;
  f[18] = sum & 0xff;
  return f;
}

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
  window.history.pushState({}, '', '/');
});

describe('vue useMeter (engine-driven)', () => {
  it('starts idle and exposes the bound actions when Web Bluetooth is present', () => {
    installMeter();
    const scope = effectScope();
    const api = scope.run(() => useMeter())!;
    expect(api.state.value).toBe('idle');
    expect(api.reading.value).toBeNull();
    expect(api.deviceName.value).toBeNull();
    expect(api.error.value).toBeNull();
    expect(typeof api.connect).toBe('function');
    expect(typeof api.disconnect).toBe('function');
    expect(typeof api.reconnect).toBe('function');
    expect(typeof api.toggleBacklight).toBe('function');
    scope.stop();
  });

  it('updates its computed refs through connect → live → disconnect', async () => {
    installMeter();
    const scope = effectScope();
    const api = scope.run(() => useMeter())!;

    api.connect();
    await vi.waitFor(() => expect(api.state.value).toBe('live'));
    expect(api.reading.value?.function).toBe('DCV');
    expect(api.deviceName.value).toBe('UT60BT_AB');

    api.disconnect();
    await nextTick();
    expect(api.state.value).toBe('idle');
    expect(api.reading.value).toBeNull();
    scope.stop();
  });

  it('auto-connects in demo mode (?demo) without Web Bluetooth', async () => {
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    window.history.pushState({}, '', '/?demo'); // isDemoMode() reads location at construction
    const scope = effectScope();
    const api = scope.run(() => useMeter())!;
    await vi.waitFor(() => expect(api.state.value).toBe('live'));
    expect(api.deviceName.value).toBe('Demo meter');
    scope.stop();
  });

  it('onScopeDispose unsubscribes: a post-dispose engine change does not update the refs', async () => {
    installMeter();
    const scope = effectScope();
    const api = scope.run(() => useMeter())!;
    api.connect();
    await vi.waitFor(() => expect(api.state.value).toBe('live'));

    scope.stop(); // onScopeDispose → unsub() + session.dispose()
    api.disconnect(); // mutates the (detached) engine; the ref must stay at its last value
    await nextTick();
    expect(api.state.value).toBe('live');
  });
});
