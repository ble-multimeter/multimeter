// MeterSession — the framework-agnostic connection engine. Orchestrates transport + the
// selected driver's framing/handshake/keep-alive/decode behind a connection state machine,
// and brings the stream back after a drop by re-running the *full* handshake (PLAN §4).
//
// This is the logic that previously lived inside the React useMeter hook; it's now a plain
// class exposing a useSyncExternalStore-friendly snapshot (subscribe/getSnapshot) so React
// AND Vue bindings are thin adapters over it. Demo mode (`?demo`) is handled here too, so it
// works identically for every binding.

import {
  drivers,
  driverById,
  driversForService,
  sniffDriver,
  type Driver,
  type DriverFramer,
  type DriverIO,
  type FrameKind,
  type MeterControl,
  type Reading,
} from '@ble-multimeter/protocol';
import { Transport } from './transport';
import { isDemoMode, demoReading } from './demo';

export type MeterState =
  | 'unsupported' // no Web Bluetooth
  | 'idle' // never connected / disconnected by user
  | 'connecting' // chooser + handshake in flight
  | 'live' // streaming measurements
  | 'reconnecting' // re-opening after a drop
  | 'disconnected' // dropped, data kept, offer reconnect
  | 'error';

export interface MeterSnapshot {
  state: MeterState;
  reading: Reading | null;
  deviceName: string | null;
  error: string | null;
  controls: MeterControl[]; // front-panel controls the active driver exposes (empty when idle)
}

const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const DEMO_INTERVAL_MS = 250; // the meter's ~4 Hz
const SNIFF_TIMEOUT_MS = 4000; // give up identifying a shared-service meter after this

export class MeterSession {
  readonly isDemo = isDemoMode();

  private snap: MeterSnapshot;
  private listeners = new Set<() => void>();

  private transport: Transport | null = null;
  private driver: Driver | null = null;
  private framer: DriverFramer | null = null;
  private demoTimer: ReturnType<typeof setInterval> | null = null;

  // Non-null only while disambiguating a shared GATT service (the 0xFFF0 family): we buffer raw
  // chunks and sniff the first frame to pick the decoder before committing to a driver.
  private sniffing: {
    candidates: Driver[];
    buf: number[];
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null = null;

  // One-shot waiters the handshake parks on, resolved when a matching frame arrives — this
  // sequences GET-NAME → (name) → GET-DATA → (stream) off real events instead of blind timers.
  private waiters: { pred: (k: FrameKind) => boolean; resolve: () => void }[] = [];

  // What the driver's handshake/keep-alive talk to. The driver never touches the transport.
  private io: DriverIO = {
    write: bytes => this.transport?.write(bytes) ?? Promise.resolve(),
    waitForFrame: (pred, timeoutMs) => this.waitForFrame(pred, timeoutMs),
  };

  constructor() {
    // Demo never touches Bluetooth, so it must run even where Web Bluetooth is absent.
    const state: MeterState = this.isDemo || Transport.supported ? 'idle' : 'unsupported';
    this.snap = { state, reading: null, deviceName: null, error: null, controls: [] };
  }

  /** Control names the active driver exposes, for the snapshot (empty when no driver). */
  private controlNames(): MeterControl[] {
    return Object.keys(this.driver?.controls ?? {}) as MeterControl[];
  }

  static get supported(): boolean {
    return Transport.supported;
  }

  // --- external store ---
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): MeterSnapshot => this.snap;

  private set(partial: Partial<MeterSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    for (const l of this.listeners) l();
  }

  // --- controls (bound so binding deps stay stable) ---
  connect = (): void => {
    if (this.isDemo) {
      this.startDemo();
      return;
    }
    void this.realConnect();
  };
  reconnect = (): void => {
    void this.realReconnect();
  };
  disconnect = (): void => {
    this.stopDemo();
    // Abort an in-flight identify so its promise/timer doesn't outlive the connection. Treated as
    // a user cancel (NotFoundError) by realConnect's catch → idle.
    this.sniffing?.reject(new DOMException('disconnected during identify', 'NotFoundError'));
    this.sniffing = null;
    this.transport?.disconnect();
    this.transport = null;
    this.framer?.reset();
    this.driver = null;
    this.set({ reading: null, deviceName: null, error: null, state: 'idle', controls: [] });
  };
  // Send a named front-panel control (HOLD, RANGE, SELECT, …) if the active driver maps it.
  // No-op when disconnected or the driver doesn't expose that control.
  sendControl = (name: MeterControl): void => {
    const cmd = this.driver?.controls?.[name];
    if (cmd) void this.transport?.write(cmd);
  };
  toggleBacklight = (): void => this.sendControl('backlight');
  /** Release timers/listeners (call from the binding's unmount cleanup). */
  dispose = (): void => {
    this.stopDemo();
    this.sniffing?.reject(new DOMException('disposed', 'NotFoundError'));
    this.sniffing = null;
    this.waiters = [];
    this.listeners.clear();
  };

  // --- demo ---
  private startDemo(): void {
    if (this.demoTimer) return;
    // Pretend to be a UT60BT so the demo surfaces its control set (writes are no-ops — no transport).
    this.driver = driverById('uni-t') ?? null;
    this.set({ deviceName: 'UT60BT (demo)', state: 'live', controls: this.controlNames() });
    const start = Date.now();
    this.demoTimer = setInterval(() => {
      const ts = Date.now();
      this.set({ reading: demoReading((ts - start) / 1000, ts) });
    }, DEMO_INTERVAL_MS);
  }
  private stopDemo(): void {
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
  }

  // --- real BLE ---
  private async realConnect(): Promise<void> {
    if (!Transport.supported) {
      this.set({ state: 'unsupported' });
      return;
    }
    this.set({ error: null, state: 'connecting' });
    const t = new Transport();
    t.onChunk = this.handleChunk;
    t.onDisconnect = this.handleDisconnect;
    this.transport = t;
    try {
      const id = await t.requestAndConnect();
      const matched = driverById(id) ?? drivers[0]!;
      const candidates = driversForService(matched.gatt.service);
      if (candidates.length > 1) {
        // Several meter families share this GATT service (0xFFF0). The transport can't tell them
        // apart by service alone, so identify by the shape of the first frame.
        this.set({ deviceName: t.deviceName ?? 'Multimeter' });
        await this.sniffDriverForService(candidates);
      } else {
        this.driver = matched;
        this.framer = this.driver.createFramer();
        this.set({ deviceName: t.deviceName ?? this.driver.label, controls: this.controlNames() });
        await this.handshake();
      }
    } catch (e) {
      // User dismissing the chooser throws NotFoundError — a cancel, not a failure.
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        this.set({ state: 'idle' });
        return;
      }
      this.set({ error: errMsg(e), state: 'error' });
    }
  }

  private async realReconnect(): Promise<void> {
    const t = this.transport;
    if (!t) {
      this.connect();
      return;
    }
    this.set({ error: null, state: 'reconnecting' });
    try {
      await t.reconnect();
      await this.handshake();
    } catch (e) {
      this.set({ error: errMsg(e), state: 'error' });
    }
  }

  private async handshake(): Promise<void> {
    if (!this.driver) throw new Error('no driver selected');
    this.framer?.reset();
    await this.driver.handshake(this.io);
  }

  // Resolve once a registered candidate's `sniff` accepts the first frame; reject on timeout.
  private sniffDriverForService(candidates: Driver[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.sniffing) {
          this.sniffing = null;
          reject(new Error('could not identify the meter: no recognizable frame on this service'));
        }
      }, SNIFF_TIMEOUT_MS);
      this.sniffing = {
        candidates,
        buf: [],
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  // Accumulate raw bytes and try to identify the driver. Buffering tolerates a frame split across
  // notifications; once a candidate matches we commit and replay the bytes through its framer so
  // the first reading isn't dropped. The 0xFFF0 families need no handshake (they stream on
  // subscribe), so we go straight to streaming — revisit if a sniffed driver ever needs one.
  private trySniff(chunk: Uint8Array): void {
    const s = this.sniffing;
    if (!s) return;
    for (const b of chunk) s.buf.push(b);
    const frame = Uint8Array.from(s.buf);
    const picked = sniffDriver(s.candidates, frame);
    if (!picked) return; // keep buffering until a frame completes or the timeout fires
    this.sniffing = null;
    this.driver = picked;
    this.framer = picked.createFramer();
    this.set({
      deviceName: this.transport?.deviceName ?? picked.label,
      controls: this.controlNames(),
    });
    s.resolve();
    this.handleChunk(frame);
  }

  private handleChunk = (chunk: Uint8Array): void => {
    if (this.sniffing) {
      this.trySniff(chunk);
      return;
    }
    if (!this.framer || !this.driver) return;
    for (const f of this.framer.push(chunk)) {
      if (f.kind === 'measurement') {
        this.set({ reading: this.driver.decode(f.bytes, Date.now()), state: 'live' });
      } else {
        this.driver.onRequest(f, this.io);
      }
      // Wake any handshake step waiting on this kind of frame.
      for (const w of this.waiters.filter(w => w.pred(f.kind))) w.resolve();
    }
  };

  private handleDisconnect = (): void => {
    // Keep reading/deviceName so the UI can show the last value + offer reconnect.
    if (this.snap.state !== 'idle') this.set({ state: 'disconnected' });
  };

  private waitForFrame(pred: (k: FrameKind) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let settled = false;
      const entry = { pred, resolve: () => finish(true) };
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter(w => w !== entry);
        resolve(ok);
      };
      this.waiters.push(entry);
      setTimeout(() => finish(false), timeoutMs);
    });
  }
}
