// The driver abstraction: everything device-specific about turning a BLE byte stream into
// Readings, expressed as plain data + pure functions so this package stays I/O-free and
// Node-testable. The transport package (web-bluetooth) performs the actual GATT calls using
// the UUIDs carried here; the MeterSession engine drives `handshake`/`onRequest`/`decode`.
//
// Phase 5 ships exactly one driver (uni-t). Phase 6 adds more (bdm, owon, …) — at which point
// `match()` disambiguates the families that share a GATT service (e.g. 0xFFF0). See PLAN §6.

import type { Reading } from '../types';
import type { FrameKind, ParsedFrame } from '../framing';

// Re-export the framing types so drivers can pull everything they need from one module
// (`./types`) — several drivers import ParsedFrame/FrameKind from here.
export type { FrameKind, ParsedFrame } from '../framing';

// A stateful framing buffer (one per connection). Structurally matches FrameParser so a
// driver can return `new FrameParser()` directly.
export interface DriverFramer {
  push(chunk: Uint8Array): ParsedFrame[];
  reset(): void;
}

// What a driver's handshake/keep-alive needs from the live connection. The engine supplies
// it; the driver never touches the transport directly. `waitForFrame` resolves true when a
// frame of a matching kind arrives before the timeout, false otherwise.
export interface DriverIO {
  write(bytes: Uint8Array): Promise<void> | void;
  waitForFrame(pred: (kind: FrameKind) => boolean, timeoutMs: number): Promise<boolean>;
}

// The GATT profile to find on the device, as data. `write` lists candidate characteristic
// UUIDs (first match wins) to tolerate firmware reshuffles.
export interface DriverGattProfile {
  service: string;
  notify: string;
  write: string[];
}

// Post-connect identification inputs. Auto-detect by advertised service where unambiguous;
// fall back to the device name prefix.
export interface DriverMatchContext {
  name?: string;
  services?: string[];
}

// Named front-panel soft-button controls a meter may honor (written on demand). Each maps to a
// command frame in the driver's `controls` map; the session/bindings expose them generically.
export type MeterControl =
  | 'backlight'
  | 'hold'
  | 'rel'
  | 'select' // function / mode
  | 'range' // step manual range
  | 'rangeAuto' // toggle auto range
  | 'hzDuty' // Hz / duty %
  | 'maxMin';

export interface Driver {
  id: string; // 'uni-t'
  label: string; // 'UNI-T BLE'
  // How far the driver's decode has been validated (PLAN §6 "Verification honesty"). The UI
  // surfaces this rather than implying all are bench-tested:
  //   * 'live-tested'       — verified on real physical hardware.
  //   * 'app-verified'      — verified byte-for-byte against the vendor app via a BLE emulator
  //                           oracle (a hardware-free bench test), but not yet on a physical meter.
  //   * 'ported-unverified' — ported from the source app / annotations, no live validation.
  verification: 'live-tested' | 'app-verified' | 'ported-unverified';
  namePrefixes: string[]; // requestDevice name filters
  gatt: DriverGattProfile;
  match(ctx: DriverMatchContext): boolean;
  createFramer(): DriverFramer;
  handshake(io: DriverIO): Promise<void>;
  onRequest(frame: ParsedFrame, io: DriverIO): void; // answer keep-alive requests
  decode(bytes: Uint8Array, ts: number): Reading;
  controls?: Partial<Record<MeterControl, Uint8Array>>; // optional meter commands the device honors
  // Disambiguate families that share one GATT service (the 0xFFF0 group: bdm/owon-plus/owon-old/
  // voltcraft). Given a raw notification frame, return true iff it matches this driver's format
  // (length + header/marker/checksum). Only required when >1 registered driver shares a service;
  // the session sniffs the first frame against the candidates to pick the right decoder (PLAN §6).
  sniff?(bytes: Uint8Array): boolean;
}
