// Web Bluetooth transport for the UT60BT. Owns the GATT connection and the two ISSC
// "Transparent UART" characteristics; emits raw notification chunks (it does NOT frame
// — that's FrameParser) and writes command bytes. All BLE quirks live here so the
// hook/UI never touch navigator.bluetooth. GATT confirmed on our UT60BTk (PROTOCOL §1).

// ISSC Transparent UART — the confirmed stream. The 0xd0ff vendor service has no notify
// char, so we don't request it (PROTOCOL §1 progress note).
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const ISSC_WRITE_FALLBACK = '49535343-6daa-4d02-abf6-19569aca69fe';
const DEVICE_INFO_SERVICE = 0x180a; // model/serial/firmware strings — nice-to-have

export class Transport {
  onChunk?: (bytes: Uint8Array) => void;
  onDisconnect?: () => void;

  private device?: BluetoothDevice;
  private server?: BluetoothRemoteGATTServer;
  private notifyChar?: BluetoothRemoteGATTCharacteristic;
  private writeChar?: BluetoothRemoteGATTCharacteristic;

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get deviceName(): string | undefined {
    return this.device?.name;
  }

  get connected(): boolean {
    return !!this.server?.connected;
  }

  /** Native chooser → GATT connect → find chars → subscribe. User-gesture required. */
  async requestAndConnect(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'UT60BT' }],
      optionalServices: [ISSC_SERVICE, DEVICE_INFO_SERVICE],
    });
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    await this.openGatt();
  }

  /** Re-open GATT on the already-chosen device (after a drop). Caller re-runs the handshake. */
  async reconnect(): Promise<void> {
    if (!this.device?.gatt) throw new Error('no device to reconnect to');
    await this.openGatt();
  }

  // Uint8Array<ArrayBuffer> (not the generic Uint8Array) so it satisfies BufferSource —
  // a plain Uint8Array widens to ArrayBufferLike, which writeValue* rejects.
  async write(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const c = this.writeChar;
    if (!c) throw new Error('no write characteristic');
    if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(bytes);
    else await c.writeValueWithResponse(bytes);
  }

  disconnect(): void {
    try {
      this.server?.disconnect();
    } catch {
      /* already gone */
    }
  }

  private async openGatt(): Promise<void> {
    const server = await this.device!.gatt!.connect();
    this.server = server;

    const svc = await server.getPrimaryService(ISSC_SERVICE);
    const chars = await svc.getCharacteristics();

    // Prefer the confirmed UUIDs; fall back to properties so a firmware reshuffle
    // doesn't strand us.
    this.notifyChar =
      chars.find((c) => c.uuid === ISSC_NOTIFY) ?? chars.find((c) => c.properties.notify);
    this.writeChar =
      chars.find((c) => c.uuid === ISSC_WRITE) ??
      chars.find((c) => c.uuid === ISSC_WRITE_FALLBACK) ??
      chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);

    if (!this.notifyChar || !this.writeChar) {
      throw new Error('ISSC notify/write characteristics not found on this device');
    }

    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', this.handleValue);
  }

  private handleValue = (e: Event): void => {
    const dv = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    this.onChunk?.(bytes);
  };

  private handleDisconnect = (): void => {
    this.onDisconnect?.();
  };
}
