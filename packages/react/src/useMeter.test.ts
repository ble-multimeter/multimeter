import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMeter } from './useMeter';

// Mirror the web-bluetooth session.test.ts harness: a stubbed navigator.bluetooth driving the
// MeterSession engine that useMeter wraps, so we can prove the adapter reflects engine state
// transitions (idle → connecting → live) and disconnect, not just the static snapshot.
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const GET_NAME = 0x5f;
const GET_DATA = 0x5d;

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

describe('useMeter', () => {
  it('reports unsupported when Web Bluetooth is absent', () => {
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    const { result } = renderHook(() => useMeter());
    expect(result.current.state).toBe('unsupported');
    expect(result.current.reading).toBeNull();
    expect(result.current.deviceName).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns the idle initial snapshot when Web Bluetooth is present', () => {
    installMeter();
    const { result } = renderHook(() => useMeter());
    expect(result.current.state).toBe('idle');
  });

  it('exposes the bound actions and keeps them stable across re-renders', () => {
    installMeter();
    const { result, rerender } = renderHook(() => useMeter());
    expect(typeof result.current.connect).toBe('function');
    expect(typeof result.current.disconnect).toBe('function');
    expect(typeof result.current.reconnect).toBe('function');
    expect(typeof result.current.toggleBacklight).toBe('function');
    expect(typeof result.current.sendControl).toBe('function');
    expect(result.current.controls).toEqual([]); // idle: no driver yet

    const before = result.current;
    rerender();
    // The engine instance is held in a ref, so its bound actions are identity-stable.
    expect(result.current.connect).toBe(before.connect);
    expect(result.current.disconnect).toBe(before.disconnect);
    expect(result.current.reconnect).toBe(before.reconnect);
    expect(result.current.toggleBacklight).toBe(before.toggleBacklight);
    expect(result.current.sendControl).toBe(before.sendControl);
  });

  it('re-renders with the engine snapshot through connect → live → disconnect', async () => {
    installMeter();
    const { result } = renderHook(() => useMeter());
    expect(result.current.state).toBe('idle');

    act(() => result.current.connect());
    await waitFor(() => expect(result.current.state).toBe('live'));
    expect(result.current.reading?.function).toBe('DCV');
    expect(result.current.deviceName).toBe('UT60BT_AB');

    act(() => result.current.disconnect());
    expect(result.current.state).toBe('idle');
    expect(result.current.reading).toBeNull();
  });

  it('auto-connects in demo mode (?demo) and goes live without Web Bluetooth', async () => {
    // Demo never touches Bluetooth; isDemoMode() reads window.location.search at construction.
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    window.history.pushState({}, '', '/?demo');
    const { result } = renderHook(() => useMeter());
    // The mount effect calls session.connect() because session.isDemo is true.
    await waitFor(() => expect(result.current.state).toBe('live'));
    expect(result.current.deviceName).toBe('Demo meter');
    await waitFor(() => expect(result.current.reading?.function).toBe('DCV'));
  });

  it('unsubscribes from the engine on unmount (no re-render after dispose)', async () => {
    installMeter();
    const { result, unmount } = renderHook(() => useMeter());
    act(() => result.current.connect());
    await waitFor(() => expect(result.current.state).toBe('live'));

    // After unmount the effect cleanup calls session.dispose(), which clears listeners. A late
    // engine emit must not throw or attempt to update the unmounted component.
    expect(() => unmount()).not.toThrow();
    expect(() => result.current.disconnect()).not.toThrow();
  });
});
