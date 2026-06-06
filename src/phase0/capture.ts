// Phase-0 capture engine. Throwaway dev tooling: connect, enumerate the GATT table
// (with characteristic properties), subscribe to every notify-capable characteristic,
// run the handshake, auto-answer keep-alives, and emit a timestamped log of everything.
//
// Deliberately framework-agnostic — the React component just wires callbacks to state.

import {
  COMMANDS,
  REQUEST_SERVICES,
  ISSC_WRITE,
  ISSC_WRITE_FALLBACK,
  classifyFrame,
  tentativeDecode,
  toHex,
  type FrameKind,
  type TentativeDecode,
} from './protocol';

export interface CharInfo {
  service: string;
  uuid: string;
  properties: string[];
}

export interface LogEntry {
  id: number;
  t: number; // ms epoch
  dir: 'rx' | 'tx' | 'info' | 'error' | 'mark';
  source: string; // char uuid, command name, or label
  hex?: string;
  len?: number;
  kind?: FrameKind;
  decode?: TentativeDecode | null;
  note?: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROP_KEYS = [
  'broadcast', 'read', 'writeWithoutResponse', 'write', 'notify',
  'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries',
] as const;

function propStrings(p: BluetoothCharacteristicProperties): string[] {
  return PROP_KEYS.filter((k) => (p as unknown as Record<string, boolean>)[k]);
}

export class Phase0Capture {
  onLog?: (e: LogEntry) => void;
  onStatus?: (s: string) => void;
  onGatt?: (chars: CharInfo[]) => void;

  /** Full, uncapped history — the source of truth for export. */
  readonly entries: LogEntry[] = [];

  private server?: BluetoothRemoteGATTServer;
  private writeChar?: BluetoothRemoteGATTCharacteristic;
  private characteristics: BluetoothRemoteGATTCharacteristic[] = [];
  private seq = 0;

  get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect(): Promise<void> {
    if (!this.supported) {
      this.log('error', 'browser', { note: 'Web Bluetooth unavailable — use Chrome/Edge over localhost or HTTPS.' });
      return;
    }
    try {
      this.status('requesting device…');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'UT60BT' }],
        optionalServices: REQUEST_SERVICES,
      });
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      this.log('info', 'device', { note: `selected ${device.name ?? '(no name)'} · id=${device.id}` });

      this.status(`connecting to ${device.name}…`);
      const server = await device.gatt!.connect();
      this.server = server;

      await this.enumerate(server);
      await this.subscribeAll();
      this.pickWriteChar();
      await this.handshake();
      this.status('streaming — turn the dial through every position');
    } catch (e) {
      this.log('error', 'connect', { note: errMsg(e) });
      this.status('connect failed');
    }
  }

  disconnect(): void {
    try {
      this.server?.disconnect();
    } catch {
      /* ignore */
    }
  }

  mark(label: string): void {
    this.log('mark', label || 'mark', { note: 'dial position / annotation' });
  }

  async sendCommand(name: keyof typeof COMMANDS): Promise<void> {
    await this.send(name, COMMANDS[name]);
  }

  /** Send an arbitrary (e.g. experimental EA-EC button) command frame. */
  async sendRaw(label: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.send(label, bytes);
  }

  private async enumerate(server: BluetoothRemoteGATTServer): Promise<void> {
    this.characteristics = [];
    const infos: CharInfo[] = [];
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await svc.getCharacteristics();
      } catch (e) {
        this.log('info', svc.uuid, { note: `getCharacteristics failed: ${errMsg(e)}` });
        continue;
      }
      for (const c of chars) {
        this.characteristics.push(c);
        const props = propStrings(c.properties);
        infos.push({ service: svc.uuid, uuid: c.uuid, properties: props });
        this.log('info', c.uuid, { note: `svc ${svc.uuid} · [${props.join(', ') || 'none'}]` });
      }
    }
    this.onGatt?.(infos);
  }

  private async subscribeAll(): Promise<void> {
    for (const c of this.characteristics) {
      if (!c.properties.notify && !c.properties.indicate) continue;
      try {
        await c.startNotifications();
        c.addEventListener('characteristicvaluechanged', () => this.onValue(c));
        this.log('info', c.uuid, { note: 'subscribed (notifications on)' });
      } catch (e) {
        this.log('error', c.uuid, { note: `startNotifications failed: ${errMsg(e)}` });
      }
    }
  }

  private pickWriteChar(): void {
    const byUuid = (u: string) => this.characteristics.find((c) => c.uuid === u);
    this.writeChar =
      byUuid(ISSC_WRITE) ??
      byUuid(ISSC_WRITE_FALLBACK) ??
      this.characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    this.log('info', 'write-char', {
      note: this.writeChar ? `using ${this.writeChar.uuid}` : 'NONE FOUND — cannot send commands',
    });
  }

  private async handshake(): Promise<void> {
    this.log('info', 'handshake', { note: 'GET-NAME → wait 200ms → GET-DATA' });
    await this.send('GET_NAME', COMMANDS.GET_NAME);
    await delay(200);
    await this.send('GET_DATA', COMMANDS.GET_DATA);
  }

  private async send(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.writeChar) {
      this.log('error', name, { note: 'no write characteristic' });
      return;
    }
    try {
      if (this.writeChar.properties.writeWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(bytes);
      } else {
        await this.writeChar.writeValueWithResponse(bytes);
      }
      this.log('tx', name, { bytes });
    } catch (e) {
      this.log('error', name, { note: `write failed: ${errMsg(e)}` });
    }
  }

  private onValue(c: BluetoothRemoteGATTCharacteristic): void {
    const dv = c.value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    const kind = classifyFrame(bytes);
    this.log('rx', c.uuid, { bytes, kind, decode: tentativeDecode(bytes) });

    // Auto-answer keep-alives so the stream doesn't stall (PROTOCOL §2).
    if (kind === 'type-request') void this.send('GET_NAME (keep-alive)', COMMANDS.GET_NAME);
    else if (kind === 'data-request') void this.send('GET_DATA (keep-alive)', COMMANDS.GET_DATA);
  }

  private handleDisconnect = (): void => {
    this.log('info', 'device', { note: 'gattserverdisconnected' });
    this.status('disconnected');
  };

  private status(s: string): void {
    this.onStatus?.(s);
  }

  private log(
    dir: LogEntry['dir'],
    source: string,
    extra: { bytes?: Uint8Array; kind?: FrameKind; decode?: TentativeDecode | null; note?: string } = {},
  ): void {
    const { bytes, ...rest } = extra;
    const entry: LogEntry = {
      id: this.seq++,
      t: Date.now(),
      dir,
      source,
      ...(bytes ? { hex: toHex(bytes), len: bytes.length } : {}),
      ...rest,
    };
    this.entries.push(entry);
    this.onLog?.(entry);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
