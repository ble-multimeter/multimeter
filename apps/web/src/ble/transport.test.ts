import { describe, it, expect, vi, afterEach } from 'vitest';
import { Transport } from './transport';

const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';

// Minimal fakes for the Web Bluetooth GATT chain the transport touches.
class FakeChar extends EventTarget {
  value?: DataView;
  startNotifications = vi.fn().mockResolvedValue(undefined);
  writeValueWithoutResponse = vi.fn().mockResolvedValue(undefined);
  writeValueWithResponse = vi.fn().mockResolvedValue(undefined);
  constructor(
    public uuid: string,
    public properties: Partial<BluetoothCharacteristicProperties>,
  ) {
    super();
  }
}

function makeDevice(chars: FakeChar[], opts: { name?: string; disconnectThrows?: boolean } = {}) {
  const server = {
    connected: true,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      if (opts.disconnectThrows) throw new Error('already gone');
      this.connected = false;
    }),
    getPrimaryService: vi.fn().mockResolvedValue({
      getCharacteristics: vi.fn().mockResolvedValue(chars),
    }),
  };
  const device: any = Object.assign(new EventTarget(), {
    name: opts.name ?? 'UT60BT_1234',
    gatt: { connect: vi.fn().mockResolvedValue(server) },
  });
  return { device, server };
}

function installBluetooth(device: any) {
  const requestDevice = vi.fn().mockResolvedValue(device);
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice }, configurable: true });
  return requestDevice;
}

afterEach(() => {
  Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
});

describe('Transport.supported', () => {
  it('reflects navigator.bluetooth presence', () => {
    installBluetooth(makeDevice([]).device);
    expect(Transport.supported).toBe(true);
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    expect(Transport.supported).toBe(false);
  });
});

describe('requestAndConnect', () => {
  it('connects, subscribes, and emits notification chunks', async () => {
    const notify = new FakeChar(ISSC_NOTIFY, { notify: true });
    const write = new FakeChar(ISSC_WRITE, { write: true, writeWithoutResponse: true });
    const { device } = makeDevice([notify, write], { name: 'UT60BT_AB' });
    const requestDevice = installBluetooth(device);

    const t = new Transport();
    const chunks: Uint8Array[] = [];
    t.onChunk = (b) => chunks.push(b);
    await t.requestAndConnect();

    expect(requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ namePrefix: 'UT60BT' }] }),
    );
    expect(t.deviceName).toBe('UT60BT_AB');
    expect(t.connected).toBe(true);
    expect(notify.startNotifications).toHaveBeenCalledTimes(1);

    notify.value = new DataView(new Uint8Array([0xab, 0xcd, 1, 2, 3]).buffer);
    notify.dispatchEvent(new Event('characteristicvaluechanged'));
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0])).toEqual([0xab, 0xcd, 1, 2, 3]);
  });

  it('falls back to characteristic properties when the known UUIDs are absent', async () => {
    const notify = new FakeChar('other-notify', { notify: true });
    const write = new FakeChar('other-write', { writeWithoutResponse: true });
    const { device } = makeDevice([notify, write]);
    installBluetooth(device);

    const t = new Transport();
    await t.requestAndConnect();
    await t.write(new Uint8Array([0xaa]));
    expect(write.writeValueWithoutResponse).toHaveBeenCalledTimes(1);
  });

  it('throws when no usable characteristics are found', async () => {
    const notifyOnly = new FakeChar('x', { notify: true });
    const { device } = makeDevice([notifyOnly]); // no write char
    installBluetooth(device);
    const t = new Transport();
    await expect(t.requestAndConnect()).rejects.toThrow(/characteristics not found/);
  });
});

describe('write', () => {
  it('uses writeWithResponse when writeWithoutResponse is unavailable', async () => {
    const notify = new FakeChar(ISSC_NOTIFY, { notify: true });
    const write = new FakeChar(ISSC_WRITE, { write: true, writeWithoutResponse: false });
    const { device } = makeDevice([notify, write]);
    installBluetooth(device);

    const t = new Transport();
    await t.requestAndConnect();
    await t.write(new Uint8Array([1, 2, 3]));
    expect(write.writeValueWithResponse).toHaveBeenCalledTimes(1);
    expect(write.writeValueWithoutResponse).not.toHaveBeenCalled();
  });

  it('throws when there is no write characteristic', async () => {
    const t = new Transport();
    await expect(t.write(new Uint8Array([1]))).rejects.toThrow('no write characteristic');
  });
});

describe('disconnect / reconnect / events', () => {
  it('disconnects the server and fires onDisconnect on gattserverdisconnected', async () => {
    const notify = new FakeChar(ISSC_NOTIFY, { notify: true });
    const write = new FakeChar(ISSC_WRITE, { writeWithoutResponse: true });
    const { device, server } = makeDevice([notify, write]);
    installBluetooth(device);

    const t = new Transport();
    const onDisconnect = vi.fn();
    t.onDisconnect = onDisconnect;
    await t.requestAndConnect();

    t.disconnect();
    expect(server.disconnect).toHaveBeenCalledTimes(1);

    device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from a failing server.disconnect', async () => {
    const notify = new FakeChar(ISSC_NOTIFY, { notify: true });
    const write = new FakeChar(ISSC_WRITE, { writeWithoutResponse: true });
    const { device } = makeDevice([notify, write], { disconnectThrows: true });
    installBluetooth(device);

    const t = new Transport();
    await t.requestAndConnect();
    expect(() => t.disconnect()).not.toThrow();
  });

  it('reconnect throws when there is no chosen device', async () => {
    const t = new Transport();
    await expect(t.reconnect()).rejects.toThrow('no device to reconnect to');
  });

  it('reconnect re-opens GATT on the chosen device', async () => {
    const notify = new FakeChar(ISSC_NOTIFY, { notify: true });
    const write = new FakeChar(ISSC_WRITE, { writeWithoutResponse: true });
    const { device } = makeDevice([notify, write]);
    installBluetooth(device);

    const t = new Transport();
    await t.requestAndConnect();
    await t.reconnect();
    expect(device.gatt.connect).toHaveBeenCalledTimes(2);
  });
});
