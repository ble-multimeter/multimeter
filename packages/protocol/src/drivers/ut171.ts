// UNI-T UT171 (UT171A/B/C) true-RMS multimeter driver.
//
// Ported from the UNI-T "Smart Measure" Android app (manager/UT171AManager.java,
// bean/InnerRecordBean.java, ui/main/anjianview/Anjianview171.java, manager/BleManager.java).
// The UT171 is typically reached through the UT-D07A IR/optical-to-BLE adapter and shares the
// ISSC "Transparent UART" GATT service with the UT60BT/UT161 family, but speaks its own AB-CD
// length-prefixed protocol. NOT bench-tested on physical hardware, so `verification` is
// 'ported-unverified' (PLAN §6 "Verification honesty").
//
// Protocol summary (all little-endian; numeric values are LE IEEE-754 32-bit floats):
//   Container:  AB CD <len:u16> <cmd:u8> <payload...> <chk:u16>
//     len      = number of body bytes (cmd + payload + the 2 checksum bytes) for live/stored
//                frames; the frame total is therefore 4 + len.
//     checksum = (Σ bytes[2 .. 4+len-3]) & 0xFFFF, i.e. the two length bytes + cmd + payload,
//                excluding the 0xAB,0xCD header and the checksum itself; stored little-endian.
//   The meter does NOT free-run: handshake() sends START (cmd 10 {1}) to turn the live stream
//   on, then a device-info request (cmd 22 {0x5A}). After START the meter pushes cmd-2 LIVEDATA
//   frames continuously.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
// Write quirk (gattSendData): prefer the 8841 write-no-response characteristic when present,
// otherwise fall back to the 6daa characteristic.
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const ISSC_WRITE_FALLBACK = '49535343-6daa-4d02-abf6-19569aca69fe';

const CMD_LIVEDATA = 2; // reply cmdID for streamed measurement frames

// ── AB-CD frame builder ────────────────────────────────────────────────────
// Mirrors UT171AManager.createCmd: AB CD <len:LE> <cmd> <payload...> <chk:LE>, where the
// checksum sums the two length bytes + cmd + payload. `len` here matches the value the spec's
// control-code examples carry (cmd + payload count); the trailing checksum follows.
function createCmd(cmd: number, payload: readonly number[]): Uint8Array {
  const len = 1 + payload.length; // cmd + payload
  const head = [
    0xab,
    0xcd,
    len & 0xff,
    (len >> 8) & 0xff,
    cmd & 0xff,
    ...payload.map(b => b & 0xff),
  ];
  let sum = 0;
  for (let i = 2; i < head.length; i++) sum += head[i]!;
  sum &= 0xffff;
  return Uint8Array.from([...head, sum & 0xff, (sum >> 8) & 0xff]);
}

// float32 → 4 LE bytes (for REL value and OUTPUT freq/duty payloads).
function f32le(v: number): number[] {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, v, true);
  return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)];
}

// ── Unit table (getUnitString171) ──────────────────────────────────────────
// Per-value unit code → { display unit (with metric prefix), acdc, function key }. The display
// string already embeds the prefix + AC/DC; the numeric magnitude is scaled only by the dot
// nibble. baseValue normalization is then derived from the display prefix via unitInfo().
interface UnitEntry {
  unit: string; // displayUnit, e.g. "mV", "kΩ", "µF"
  acdc: '' | 'AC' | 'DC';
  fn: string; // function key (range-independent), e.g. "DCV", "OHM"
}

const UNIT_TABLE: Record<number, UnitEntry> = {
  0: { unit: 'V', acdc: 'DC', fn: 'DCV' },
  1: { unit: 'V', acdc: 'AC', fn: 'ACV' },
  2: { unit: 'V', acdc: '', fn: 'AC+DC' }, // VADC (AC+DC)
  3: { unit: 'mV', acdc: 'DC', fn: 'DCV' },
  4: { unit: 'mV', acdc: 'AC', fn: 'ACV' },
  5: { unit: 'mV', acdc: '', fn: 'AC+DC' },
  6: { unit: 'µA', acdc: 'DC', fn: 'DCA' },
  7: { unit: 'µA', acdc: 'AC', fn: 'ACA' },
  8: { unit: 'µA', acdc: '', fn: 'AC+DC' },
  9: { unit: 'mA', acdc: 'DC', fn: 'DCA' },
  10: { unit: 'mA', acdc: 'AC', fn: 'ACA' },
  11: { unit: 'mA', acdc: '', fn: 'AC+DC' },
  12: { unit: 'A', acdc: 'DC', fn: 'DCA' },
  13: { unit: 'A', acdc: 'AC', fn: 'ACA' },
  14: { unit: 'A', acdc: '', fn: 'AC+DC' },
  15: { unit: 'Ω', acdc: '', fn: 'OHM' },
  16: { unit: 'kΩ', acdc: '', fn: 'OHM' },
  17: { unit: 'MΩ', acdc: '', fn: 'OHM' },
  18: { unit: 'Hz', acdc: '', fn: 'Hz' },
  19: { unit: 'kHz', acdc: '', fn: 'Hz' },
  20: { unit: 'MHz', acdc: '', fn: 'Hz' },
  21: { unit: '%', acdc: '', fn: '%' },
  22: { unit: 'nF', acdc: '', fn: 'CAP' },
  23: { unit: 'µF', acdc: '', fn: 'CAP' },
  24: { unit: 'mF', acdc: '', fn: 'CAP' },
  25: { unit: '°C', acdc: '', fn: '°C' },
  26: { unit: '°F', acdc: '', fn: '°F' },
  27: { unit: 'V', acdc: '', fn: 'DIODE' }, // diode
  28: { unit: 'Ω', acdc: '', fn: 'CONT' }, // continuity/beep
  29: { unit: 'nS', acdc: '', fn: 'COND' }, // conductance (siemens)
  30: { unit: 'µS', acdc: '', fn: 'COND' },
  31: { unit: 'mS', acdc: '', fn: 'COND' },
};

const MEASURE_CODE_OUTPUT = 29; // measureCode==29 → parseOutPutData171 (freq/duty/width)

// A reading mirroring a blank/garbled frame, never throwing (decode never throws).
function blank(ts: number): Reading {
  return {
    ts,
    function: '?',
    displayText: '',
    displayValue: null,
    displayUnit: '',
    baseValue: null,
    baseUnit: '',
    overload: false,
    acdc: '',
    bargraph: 0,
    flags: {
      max: false,
      min: false,
      hold: false,
      rel: false,
      auto: false,
      lowBattery: false,
      hvWarning: false,
      peakMax: false,
      peakMin: false,
    },
  };
}

// Read a LE IEEE-754 float32 at offset `i`; returns null if out of range.
function readF32(b: Uint8Array, i: number): number | null {
  if (i + 3 >= b.length) return null;
  const dv = new DataView(b.buffer, b.byteOffset + i, 4);
  return dv.getFloat32(0, true);
}

// Round to `dot` decimal places (display rounding precision, not a divisor).
function roundDot(f: number, dot: number): number {
  const p = 10 ** dot;
  return Math.round(f * p) / p;
}

/**
 * Decode one UT171 live-measurement frame (full AB-CD container, CMDID=2) into a Reading.
 * Degrades gracefully: a short/garbled/unknown frame yields a blank reading rather than throwing.
 * Stored-record frames (CMDID=3) and other replies are not measurements → blank.
 */
export function decodeUt171(frame: Uint8Array, ts = 0): Reading {
  // Minimum live frame: AB CD len(2) cmd flagA flagB mc ri + main(6) + chk(2) = 17 bytes.
  if (frame.length < 17) return blank(ts);
  if (frame[0] !== 0xab || frame[1] !== 0xcd) return blank(ts);
  if (frame[4] !== CMD_LIVEDATA) return blank(ts);

  const flagA = frame[5]!;
  const flagB = frame[6]!;
  const measureCode = frame[7]!;

  const flags = {
    rel: (flagA & 0x10) !== 0,
    hold: (flagA & 0x80) !== 0,
    lowBattery: (flagA & 0x04) !== 0,
    max: false,
    min: false,
    auto: (flagB & 0x01) !== 0,
    hvWarning: (flagB & 0x02) !== 0,
    peakMax: false,
    peakMin: false,
  };
  // flagA bit5 = MAX/MIN active, flagB bits5-6 = which of max/min/avg is shown (1=max,2=min).
  const maxMin = (flagA & 0x20) !== 0;
  const maxMode = (flagB & 0x60) >> 5;
  if (maxMin) {
    flags.max = maxMode === 1;
    flags.min = maxMode === 2;
  }
  // flagA bit6 = PEAK active; reuse maxMode to distinguish peak max/min.
  if ((flagA & 0x40) !== 0) {
    flags.peakMax = maxMode === 1;
    flags.peakMin = maxMode === 2;
  }
  const bargraph = (flagA & 0x08) !== 0 ? 1 : 0; // bit3 = bargraph present (count not in frame)

  // OUTPUT/pulse mode: frequency + duty (+ width). Reported as a Hz reading.
  if (measureCode === MEASURE_CODE_OUTPUT) {
    const freq = readF32(frame, 9);
    if (freq === null || !Number.isFinite(freq)) {
      return { ...blank(ts), function: 'Hz', displayUnit: 'Hz', baseUnit: 'Hz', flags, bargraph };
    }
    const v = roundDot(freq, 1);
    return {
      ts,
      function: 'Hz',
      displayText: String(v),
      displayValue: v,
      displayUnit: 'Hz',
      baseValue: v,
      baseUnit: 'Hz',
      overload: false,
      acdc: '',
      bargraph,
      flags,
    };
  }

  // parseCommonData171, base i = 9: MAIN value(4) + flag(1) + unit(1).
  const i = 9;
  const mainFloat = readF32(frame, i);
  const mainFlag = frame[i + 4];
  const mainUnitCode = frame[i + 5];
  if (mainFloat === null || mainFlag === undefined || mainUnitCode === undefined) {
    return { ...blank(ts), flags, bargraph };
  }

  const ol = mainFlag & 0x0f; // 0=normal, 1=OL, 2=-OL
  const dot = (mainFlag & 0xf0) >> 4;
  const entry = UNIT_TABLE[mainUnitCode] ?? { unit: '', acdc: '' as const, fn: '?' };

  const overload = ol === 1 || ol === 2;
  let displayText: string;
  let displayValue: number | null;
  if (overload) {
    displayText = ol === 2 ? '-OL' : 'OL';
    displayValue = null;
  } else if (!Number.isFinite(mainFloat)) {
    // Non-OL but non-finite float (corrupt): treat as overload-ish, no numeric value.
    displayText = 'OL';
    displayValue = null;
  } else {
    displayValue = roundDot(mainFloat, dot);
    displayText = displayValue.toFixed(dot);
  }

  const { base: baseUnit, exp } = unitInfo(entry.unit);
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  return {
    ts,
    function: entry.fn,
    displayText,
    displayValue,
    displayUnit: entry.unit,
    baseValue,
    baseUnit,
    overload,
    acdc: entry.acdc,
    bargraph,
    flags,
  };
}

// ── Framer ─────────────────────────────────────────────────────────────────
// Buffered AB-CD reassembly (UT171AManager.checkCmdData): sync on AB CD, read the LE length,
// validate the trailing LE checksum, and emit complete frames. Handles split/coalesced
// notifications and multiple frames per buffer.
class Ut171Framer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < 4) break; // need AB CD len(2)
      const len = this.buf[2]! | (this.buf[3]! << 8);
      const total = 4 + len; // body (cmd+payload+checksum) follows the 4-byte header
      if (len < 3 || total > 256) {
        // Implausible length: a false AB CD inside noise. Drop one byte and resync.
        this.buf.shift();
        continue;
      }
      if (this.buf.length < total) break; // frame split across notifications — wait
      const frame = Uint8Array.from(this.buf.slice(0, total));
      if (!checksumOk(frame)) {
        this.buf.shift(); // desync: not a real boundary, resync past it
        continue;
      }
      this.buf.splice(0, total);
      out.push({ kind: classifyKind(frame), bytes: frame });
    }
    return out;
  }

  reset(): void {
    this.buf.length = 0;
  }

  private sync(): void {
    while (this.buf.length >= 1) {
      if (this.buf[0] !== 0xab) {
        this.buf.shift();
        continue;
      }
      if (this.buf.length >= 2 && this.buf[1] !== 0xcd) {
        this.buf.shift();
        continue;
      }
      break;
    }
  }
}

// Verify the trailing LE checksum: Σ(bytes[2 .. total-3]) & 0xFFFF == (chk_hi<<8)|chk_lo.
export function checksumOk(frame: Uint8Array): boolean {
  const len = frame.length;
  if (len < 6) return false; // AB CD len(2) ... chk(2)
  let sum = 0;
  for (let idx = 2; idx <= len - 3; idx++) sum += frame[idx]!;
  sum &= 0xffff;
  const chk = frame[len - 2]! | (frame[len - 1]! << 8);
  return sum === chk;
}

function classifyKind(frame: Uint8Array): ParsedFrame['kind'] {
  const cmd = frame[4];
  if (cmd === CMD_LIVEDATA) return 'measurement';
  // CMDID 114 = device-info/record-count reply → treat as a control frame.
  return 'control';
}

/**
 * Sniff: a UT171 live frame is a valid AB-CD container whose body command is CMDID=2 and whose
 * trailing little-endian checksum verifies. Distinguishes it from the UT60BT/UT161 frames that
 * share the ISSC service (those carry a big-endian checksum over a fixed 19-byte layout).
 */
export function looksLikeUt171Frame(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  if (bytes[0] !== 0xab || bytes[1] !== 0xcd) return false;
  const len = bytes[2]! | (bytes[3]! << 8);
  if (4 + len !== bytes.length) return false;
  if (bytes[4] !== CMD_LIVEDATA) return false;
  return checksumOk(bytes);
}

// ── Control frames (Anjianview171 / BleManager) ─────────────────────────────
// Soft-button commands, framed AB CD <len> <cmd> <payload> <chk>. Cited from the spec's
// controlCodes section; rebuilt via createCmd so they always carry a correct checksum.
export const UT171_COMMANDS = {
  // START / DEVICE_INFO carry LEN = cmd+payload+2 in the app's wire bytes (the checksum is
  // counted in the length), unlike the LEN = cmd+payload soft-button frames below; reproduced
  // verbatim from the spec so the on-wire bytes match exactly.
  START: Uint8Array.from([0xab, 0xcd, 0x04, 0x00, 0x0a, 0x01, 0x16, 0x00]), // CMDID_DATA_TREAFER
  DEVICE_INFO: Uint8Array.from([0xab, 0xcd, 0x04, 0x00, 0x16, 0x5a, 0x7b, 0x00]), // CMDID_REQUESTDEVICEINFO
  HOLD: createCmd(7, [0x5a]), // CMDID_HOLD
  HZ_DUTY: createCmd(3, [0x5a]), // CMDID_CHANGE_hz
  PEAK_ENTER: createCmd(6, [0x01]),
  PEAK_EXIT: createCmd(6, [0x00]),
  MAXMIN_ENTER: createCmd(5, [0x01]),
  MAXMIN_EXIT: createCmd(5, [0x00]),
  REL_EXIT: createCmd(4, [0x00]),
  RANGE: createCmd(2, [0x00]), // changeRange171(idx=0) — manual range select
  SELECT: createCmd(1, [0x00]), // changeFunc171(code=0) — function change
} as const;

// REL set: cmd 4, payload {0x01, <float32 LE value>}.
export function relSetCmd(value: number): Uint8Array {
  return createCmd(4, [0x01, ...f32le(value)]);
}
// RANGE set to an explicit index: cmd 2, payload {idx}.
export function rangeSetCmd(idx: number): Uint8Array {
  return createCmd(2, [idx & 0xff]);
}
// FUNCTION change to an explicit code: cmd 1, payload {code}.
export function funcSetCmd(code: number): Uint8Array {
  return createCmd(1, [code & 0xff]);
}
// OUTPUT/pulse: cmd 20, payload = float32 LE freq then float32 LE duty.
export function outputCmd(freq: number, duty: number): Uint8Array {
  return createCmd(20, [...f32le(freq), ...f32le(duty)]);
}

export const ut171: Driver = {
  id: 'ut171',
  label: 'UT171',
  verification: 'ported-unverified',
  // The UT171 shares the ISSC service with UT60BT/UT161; discovery is by name (or via the
  // UT-D07A adapter, which advertises a UT171/UT-D07A name). The registry routes ISSC matches
  // by name so this driver only claims UT171-family devices.
  namePrefixes: ['UT171', 'UT171C', 'UT-D07A'],
  gatt: { service: ISSC_SERVICE, notify: ISSC_NOTIFY, write: [ISSC_WRITE, ISSC_WRITE_FALLBACK] },

  match: ctx =>
    (ctx.name?.startsWith('UT171') ?? false) || (ctx.name?.startsWith('UT-D07A') ?? false),

  createFramer: () => new Ut171Framer(),

  // The meter is not free-running: send START to enable the live stream, then request device
  // info. The app re-sends START a couple of times for the UT-D07A adapter; one nudge is enough
  // here, and onRequest can't help (the meter sends no keep-alive requests).
  async handshake(io) {
    await io.write(UT171_COMMANDS.START);
    await io.write(UT171_COMMANDS.DEVICE_INFO);
    // Mirror the app's re-arm for the UT-D07A adapter: if no measurement arrives, nudge again.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await io.waitForFrame(k => k === 'measurement', 1000)) return;
      await io.write(UT171_COMMANDS.START);
    }
  },

  // No request/response keep-alive: after START the meter streams cmd-2 frames on its own.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeUt171(bytes, ts),

  sniff: looksLikeUt171Frame,

  // Front-panel soft buttons (reverse-engineered from the Smart Measure app). The generic
  // MeterControl names map onto the closest UT171 command.
  controls: {
    hold: UT171_COMMANDS.HOLD,
    rel: UT171_COMMANDS.REL_EXIT, // toggle: REL set takes a value (relSetCmd); exit is parameterless
    select: UT171_COMMANDS.SELECT,
    range: UT171_COMMANDS.RANGE,
    hzDuty: UT171_COMMANDS.HZ_DUTY,
    maxMin: UT171_COMMANDS.MAXMIN_ENTER,
  },
};
