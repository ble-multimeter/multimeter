// UT181A driver — UNI-T UT181A datalogging true-RMS multimeter (deviceTypeInt 3 in the source
// app). Shares the ISSC "Transparent UART" GATT service with the other UNI-T BLE meters, but
// speaks its OWN AB-CD protocol (UT181AManager / InnerRecordBean), distinct from the generic
// uni-t 19-byte frame. Routed by advertised-name (contains "UT181") rather than by service.
//
// Ported from the UNI-T Smart Measure Android app (UT181AManager.java createCmd/checkCmdData,
// InnerRecordBean.anylseLiveDataUt181/parseCommonData, BleManager.java handshake). NOT bench-
// tested on physical hardware, so `verification` is 'ported-unverified' (PLAN §6).
//
// Frame envelope (both TX and RX):
//   [0]=0xAB [1]=0xCD                       header
//   [2]=lenLo [3]=lenHi                     len16 = payloadLen + 3 = total_len - 4
//   [4]=opcode
//   [5..]=body (len16-1 bytes)
//   [last-1]=chkLo [last]=chkHi             chk16 = Σ(bytes[2 .. 4+payloadLen-1]) & 0xFFFF, LE
//
// Live measurement frame (opcode 0x02), body offset 0 == frame[5]:
//   frame[5]=flagsA, frame[6]=flagsB, frame[7..8]=measureCode LE, frame[9]=rangeIndex,
//   frame[10..] = value block. parseCommonData: float32 LE at b..b+3, status/scale byte b+4
//   (low nibble = OL/status, high nibble = decimal places), 8-byte ASCII unit at b+5..b+12.
//   The human-readable unit (incl. metric prefix) is sent IN-BAND, so we never need the
//   absent measureCode->name JSON table to render value+unit.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

const H0 = 0xab;
const H1 = 0xcd;
const OPCODE_LIVE = 0x02;

// Build an AB-CD frame: AB CD <len LE> <opcode> <body...> <chk LE>. len16 = payloadLen + 3
// (= total_len - 4); chk16 = Σ(bytes from the length field through the end of body) & 0xFFFF,
// stored little-endian (low byte first). Mirrors UT181AManager.createCmd, verified against the
// byte-exact start (AB CD 04 00 05 01 0A 00) and hold (AB CD 04 00 12 5A 70 00) vectors.
function createCmd(opcode: number, body: readonly number[]): Uint8Array {
  const len16 = body.length + 3;
  const pre = [
    H0,
    H1,
    len16 & 0xff,
    (len16 >> 8) & 0xff,
    opcode & 0xff,
    ...body.map(b => b & 0xff),
  ];
  let sum = 0;
  for (let i = 2; i < pre.length; i++) sum += pre[i]!;
  sum &= 0xffff;
  return Uint8Array.from([...pre, sum & 0xff, (sum >> 8) & 0xff]);
}

// Validate a received frame's header, length, and trailing little-endian checksum.
function checksumOk(frame: Uint8Array): boolean {
  if (frame.length < 7) return false;
  if (frame[0] !== H0 || frame[1] !== H1) return false;
  const len16 = frame[2]! | (frame[3]! << 8);
  const total = len16 + 4;
  if (total !== frame.length) return false;
  let sum = 0;
  for (let i = 2; i < total - 2; i++) sum += frame[i]!;
  sum &= 0xffff;
  return (sum & 0xff) === frame[total - 2] && ((sum >> 8) & 0xff) === frame[total - 1];
}

// A reading that mirrors a blank/garbled frame without throwing (decode never throws).
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

// Decode the 8-byte in-band ASCII unit, NUL-terminated and trimmed. Byte 0xB0 -> "°",
// 0x7E -> "Ω" (UT181AManager.newStringFromBytes).
function decodeUnit(bytes: Uint8Array, at: number): string {
  let s = '';
  for (let i = at; i < at + 8 && i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 0x00) break;
    if (c === 0xb0) s += '°';
    else if (c === 0x7e) s += 'Ω';
    else s += String.fromCharCode(c);
  }
  return s.trim();
}

// Read a wire-LE IEEE-754 float32. The app reverses the 4 wire bytes into a big-endian int and
// calls Float.intBitsToFloat; reading the 4 bytes as little-endian is equivalent.
function readFloatLE(bytes: Uint8Array, at: number): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + at, 4);
  return dv.getFloat32(0, true);
}

// Map an in-band unit (base, sans prefix) + AC/DC to a range-independent function key so range
// changes stay one chart segment while a real mode change splits (PLAN §3.4). measureCode's
// friendly name needs the absent JSON, so we derive the function from the decoded unit instead.
function functionFor(baseUnit: string, acdc: string): string {
  switch (baseUnit) {
    case 'V':
      return acdc ? `${acdc}V` : 'V';
    case 'A':
      return acdc ? `${acdc}A` : 'A';
    case 'Ω':
      return 'OHM';
    case 'F':
      return 'CAP';
    case 'Hz':
      return 'Hz';
    case '%':
      return '%';
    case 's':
      return 's';
    case 'dBm':
      return 'dBm';
    case '°C':
      return '°C';
    case '°F':
      return '°F';
    default:
      return baseUnit || '?';
  }
}

// Per-value status nibble (low nibble of the byte after the float): 0=normal, 1=OL, 2=-OL,
// 4=LEAD, 5=DISC, 6=Lo, 7=Hi (InnerRecordBean.getMainValueShowString).
function statusText(status: number): string | null {
  switch (status & 0x0f) {
    case 1:
      return 'OL';
    case 2:
      return '-OL';
    case 4:
      return 'LEAD';
    case 5:
      return 'DISC';
    case 6:
      return 'Lo';
    case 7:
      return 'Hi';
    default:
      return null;
  }
}

/**
 * Decode one UT181A live measurement frame (opcode 0x02) into a Reading. Pure + unit-tested.
 * Degrades gracefully: a wrong-opcode, short, or checksum-failing frame yields a blank reading
 * (overload/status surfaces "OL"/"-OL" with a null value) rather than throwing.
 */
export function decodeUt181a(bytes: Uint8Array, ts = 0): Reading {
  // The MAIN value block needs frame[5..22] (flags + code + range + float + status + 8-byte unit).
  if (bytes.length < 23) return blank(ts);
  if (bytes[0] !== H0 || bytes[1] !== H1) return blank(ts);
  if (bytes[4] !== OPCODE_LIVE) return blank(ts);
  if (!checksumOk(bytes)) return blank(ts);

  const flagsA = bytes[5]!;
  const flagsB = bytes[6]!;

  const b = 10; // base index of the MAIN value block (parseCommonData)
  const raw = readFloatLE(bytes, b);
  const statusByte = bytes[b + 4]!;
  const dot = (statusByte >> 4) & 0x0f;
  const status = statusText(statusByte);
  const displayUnit = decodeUnit(bytes, b + 5);

  const { base: baseUnit, exp } = unitInfo(displayUnit);

  // AC/DC isn't a single live-frame flag; the in-band unit string carries it for AC ranges
  // (e.g. "V AC"). Fall back to '' (DC/none) — exact AC/DC needs the absent measureCode JSON.
  const u = displayUnit.toUpperCase();
  const acdc: Reading['acdc'] = u.includes('AC') ? 'AC' : u.includes('DC') ? 'DC' : '';

  const overload = status === 'OL' || status === '-OL';

  let displayValue: number | null;
  let displayText: string;
  if (status !== null) {
    // Over-range / lead / discontinuity etc.: non-numeric display, null value.
    displayValue = null;
    displayText = status;
  } else if (!Number.isFinite(raw)) {
    displayValue = null;
    displayText = '';
  } else {
    const f = 10 ** dot;
    displayValue = Math.round(raw * f) / f;
    displayText = displayValue.toFixed(dot);
  }

  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  return {
    ts,
    function: functionFor(baseUnit, acdc),
    displayText,
    displayValue,
    displayUnit,
    baseValue,
    baseUnit,
    overload,
    acdc,
    bargraph: 0,
    flags: {
      max: (flagsA & 0x20) !== 0, // bit5 isMaxMin
      min: (flagsA & 0x20) !== 0,
      hold: (flagsA & 0x80) !== 0, // bit7 isHold
      rel: (flagsA & 0x10) !== 0, // bit4 isRel
      auto: (flagsB & 0x01) !== 0, // bit0 isAuto
      lowBattery: false, // no low-battery bit in this frame layout
      hvWarning: (flagsB & 0x02) !== 0, // bit1 isHV
      peakMax: (flagsA & 0x40) !== 0, // bit6 isPeak
      peakMin: (flagsA & 0x40) !== 0,
    },
  };
}

// Framer: AB-CD envelope with a little-endian length field. Accumulate bytes, sync on AB CD,
// slice by len16+4, validate the trailing checksum to recover from desync. Tolerates split/
// coalesced notifications. Only live frames (opcode 0x02) are surfaced as 'measurement'.
class Ut181aFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < 4) break; // need AB CD lenLo lenHi
      const len16 = this.buf[2]! | (this.buf[3]! << 8);
      const total = len16 + 4;
      if (total < 7 || total > 512) {
        this.buf.shift(); // bogus length — false AB CD in noise; resync
        continue;
      }
      if (this.buf.length < total) break; // frame split across notifications — wait
      const frame = Uint8Array.from(this.buf.slice(0, total));
      if (!checksumOk(frame)) {
        this.buf.shift(); // desync: not a real frame boundary, resync past it
        continue;
      }
      this.buf.splice(0, total);
      const opcode = frame[4]!;
      out.push({ kind: opcode === OPCODE_LIVE ? 'measurement' : 'control', bytes: frame });
    }
    return out;
  }

  reset(): void {
    this.buf.length = 0;
  }

  private sync(): void {
    while (this.buf.length >= 1) {
      if (this.buf[0] !== H0) {
        this.buf.shift();
        continue;
      }
      if (this.buf.length >= 2 && this.buf[1] !== H1) {
        this.buf.shift();
        continue;
      }
      break;
    }
  }
}

// Command frames, reverse-engineered from the UNI-T Smart Measure app (UT181AManager.createCmd).
// START streams live data; the others map to front-panel soft buttons.
const CMD_START = createCmd(5, [0x01]); // CMDID_DATA_TREAFER {0x01} -> AB CD 04 00 05 01 0A 00
const CMD_HOLD = createCmd(18, [0x5a]); // CMDID_HOLD magic 0x5A -> AB CD 04 00 12 5A 70 00
const CMD_MAXMIN_ENTER = createCmd(4, [0x01]); // CMDID_MaxMin enter -> AB CD 04 00 04 01 09 00
const CMD_RANGE = createCmd(2, [0x00]); // CMDID_Range, idx 0 = cycle -> AB CD 04 00 02 00 06 00
const CMD_SELECT = createCmd(1, [0x11, 0x00]); // CMDID_CHANGE_FUNC, low byte 0x11 = select group

// Sniffer for the shared ISSC service: a UT181A live frame is AB CD + LE-length + opcode 0x02
// + a valid trailing checksum. Distinguishes it from the generic uni-t 19-byte frame (which has
// no AB-CD checksum of this form and uses opcode bytes in a different position).
export function looksLikeUt181aFrame(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 7 &&
    bytes[0] === H0 &&
    bytes[1] === H1 &&
    bytes[4] === OPCODE_LIVE &&
    checksumOk(bytes)
  );
}

// ISSC "Transparent UART" — shared with the other UNI-T BLE meters (BleManager.java:77-80).
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3'; // WriteUUID2, preferred when present
const ISSC_WRITE_FALLBACK = '49535343-6daa-4d02-abf6-19569aca69fe';

export const ut181a: Driver = {
  id: 'ut181a',
  label: 'UT181A datalogging true-RMS multimeter',
  verification: 'ported-unverified',
  // The UT181A shares the ISSC service with the generic uni-t driver but has its own protocol,
  // so it must be matched by advertised name (contains "UT181") and disambiguated by sniff().
  namePrefixes: ['UT181A', 'UT181'],
  gatt: { service: ISSC_SERVICE, notify: ISSC_NOTIFY, write: [ISSC_WRITE, ISSC_WRITE_FALLBACK] },

  match: ctx => ctx.name?.includes('UT181') ?? false,

  createFramer: () => new Ut181aFramer(),

  // Send the start-live-data command, then re-issue it as a keep-alive/retry until measurements
  // arrive (BleManager re-issues startReadTestValue181A at +3000ms and +5000ms). The meter
  // pushes opcode-2 LIVEDATA frames continuously once started.
  async handshake(io) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await io.write(CMD_START);
      if (await io.waitForFrame(k => k === 'measurement', 1500)) return;
    }
    // Best-effort: leave the stream armed even if the first frames haven't landed yet.
  },

  // No request/response keep-alive frames are sent by this meter; start is the only nudge.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeUt181a(bytes, ts),

  // Front-panel soft buttons (UT181AManager soft-button command builders). No backlight/Hz/
  // rangeAuto opcode exists for this model; RANGE idx 0 cycles, SELECT changes the function.
  controls: {
    hold: CMD_HOLD,
    maxMin: CMD_MAXMIN_ENTER,
    range: CMD_RANGE,
    select: CMD_SELECT,
  },

  sniff: looksLikeUt181aFrame,
};
