// Web Bluetooth transport. Owns the GATT connection and the notify/write characteristics;
// emits raw notification chunks (it does NOT frame — that's the driver's FrameParser) and
// writes command bytes. All BLE quirks live here so the session/UI never touch
// navigator.bluetooth.
//
// Driver-aware: requestDevice offers every registered driver's service UUID + name prefix,
// and after connecting we pick the first profile whose GATT service the device actually
// exposes (PLAN §6 — Phase 6 grows the registry; this code is unchanged). For the UT60BT
// the matched profile is uni-t (ISSC Transparent UART, PROTOCOL §1).

import { drivers, allNamePrefixes, type DriverGattProfile } from '@ble-multimeter/protocol';

const DEVICE_INFO_SERVICE = 0x180a; // model/serial/firmware strings — nice-to-have

export interface TransportProfile {
  id: string;
  gatt: DriverGattProfile;
}

const registryProfiles = (): TransportProfile[] => drivers.map((d) => ({ id: d.id, gatt: d.gatt }));

export class Transport {
  onChunk?: (bytes: Uint8Array) => void;
  onDisconnect?: () => void;

  private device?: BluetoothDevice;
  private server?: BluetoothRemoteGATTServer;
  private notifyChar?: BluetoothRemoteGATTCharacteristic;
  private writeChar?: BluetoothRemoteGATTCharacteristic;
  private profile?: DriverGattProfile; // the matched driver's GATT profile (for reconnect)
  private matchedId?: string;

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get deviceName(): string | undefined {
    return this.device?.name;
  }

  get connected(): boolean {
    return !!this.server?.connected;
  }

  /** The id of the driver whose GATT profile matched this device (set after connect). */
  get driverId(): string | undefined {
    return this.matchedId;
  }

  /**
   * Native chooser → GATT connect → match a driver profile → subscribe. User-gesture
   * required. Returns the matched driver id. Defaults offer the whole registry.
   */
  async requestAndConnect(
    profiles: TransportProfile[] = registryProfiles(),
    namePrefixes: string[] = allNamePrefixes(),
  ): Promise<string> {
    const services = [...new Set(profiles.map((p) => p.gatt.service))];
    // Match by advertised name prefix OR by service UUID. The UT60BT advertises a name, but the
    // 0xFFF0 family (bdm/owon/voltcraft) advertises inconsistent or blank names — so a service
    // filter is what makes those discoverable (PLAN §6 "device-type selection"). A device shows
    // in the chooser if it matches ANY filter.
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        ...namePrefixes.map((namePrefix) => ({ namePrefix })),
        ...services.map((service) => ({ services: [service] })),
      ],
      optionalServices: [...services, DEVICE_INFO_SERVICE],
    });
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    await this.openGatt(profiles);
    return this.matchedId!;
  }

  /** Re-open GATT on the already-chosen device (after a drop). Caller re-runs the handshake. */
  async reconnect(): Promise<void> {
    if (!this.device?.gatt) throw new Error('no device to reconnect to');
    // Re-match only the previously chosen profile.
    await this.openGatt(
      this.profile && this.matchedId
        ? [{ id: this.matchedId, gatt: this.profile }]
        : registryProfiles(),
    );
  }

  // Accept a plain Uint8Array; Web Bluetooth's writeValue* wants a BufferSource backed by a
  // real ArrayBuffer, so copy only when the view isn't already ArrayBuffer-backed.
  async write(bytes: Uint8Array): Promise<void> {
    const c = this.writeChar;
    if (!c) throw new Error('no write characteristic');
    const buf: Uint8Array<ArrayBuffer> =
      bytes.buffer instanceof ArrayBuffer
        ? (bytes as Uint8Array<ArrayBuffer>)
        : new Uint8Array(bytes);
    if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(buf);
    else await c.writeValueWithResponse(buf);
  }

  disconnect(): void {
    try {
      this.server?.disconnect();
    } catch {
      /* already gone */
    }
  }

  private async openGatt(profiles: TransportProfile[]): Promise<void> {
    const server = await this.device!.gatt!.connect();
    this.server = server;

    // Pick the first profile whose service the device exposes.
    let svc: BluetoothRemoteGATTService | undefined;
    let chosen: TransportProfile | undefined;
    for (const p of profiles) {
      try {
        svc = await server.getPrimaryService(p.gatt.service);
        chosen = p;
        break;
      } catch {
        /* not this profile — try the next */
      }
    }
    if (!svc || !chosen) throw new Error('no known multimeter GATT service on this device');
    this.profile = chosen.gatt;
    this.matchedId = chosen.id;

    const chars = await svc.getCharacteristics();
    // Prefer the profile's UUIDs; fall back to characteristic properties so a firmware
    // reshuffle doesn't strand us.
    this.notifyChar =
      chars.find((c) => c.uuid === chosen.gatt.notify) ?? chars.find((c) => c.properties.notify);
    this.writeChar =
      chosen.gatt.write.map((u) => chars.find((c) => c.uuid === u)).find(Boolean) ??
      chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);

    if (!this.notifyChar || !this.writeChar) {
      throw new Error('notify/write characteristics not found on this device');
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
