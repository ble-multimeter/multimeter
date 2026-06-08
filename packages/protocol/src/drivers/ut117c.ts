// UNI-T UT117C driver — a polled (request/response) AB-CD meter from the UNI-T Smart Measure
// Android app. Ported from the decompiled app
// (sources/com/uni_t/multimeter/ut117c/manager/UT117cManager.java + UT117CTestDataModel.java +
// UT117CUtils.java). NOT bench-tested on physical hardware, so `verification` is
// 'ported-unverified' (PLAN §6 "Verification honesty").
//
// Transport: the shared ISSC "Transparent UART" GATT service (same as uni-t), but this model
// uses the WriteUUID2 (…8841…) characteristic for every write. The meter does NOT stream: the
// app polls by repeatedly writing a "request realtime data" command (AB CD 00 04 05 00 01 81)
// and the meter answers with exactly one frame per request. We model the poll as the handshake's
// kick + an onRequest re-arm so the session keeps measurements flowing.
//
// Frame format (generic AB-CD framing, big-endian length + 16-bit additive checksum):
//   [0]=0xAB [1]=0xCD  sync header
//   [2..3]=LEN (big-endian) = payload byte count starting at the type byte b[4]
//   [4]=packet type: 1=command ACK, 2=realtime measurement data
//   …payload…
//   last 2 bytes = checksum = Σ(all preceding bytes) & 0xFFFF, big-endian.
// For a TYPE-2 measurement frame LEN=0x12 (18) and the total frame is 24 bytes:
//   [5]=funcID  [6]=rangIndex (ASCII digit, value-0x30)  [7]=hzRangIndex
//   [8..14]=7-byte ASCII value string (space-padded, may have leading '-')
//   [15..17]=3-byte ASCII unit string ('o' → 'Ω')
//   [18]=olFlag (0x31='OL', 0x32='-OL')  [19]=maxminFlag
//   [20]=flag1  [21]=flag2  [22..23]=checksum

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

const SOF_H = 0xab;
const SOF_L = 0xcd;

const TYPE_DATA = 2;

// A measurement frame: 4-byte header + 18-byte payload + 2-byte checksum.
const DATA_LEN = 0x12; // payload length field for a measurement frame
const DATA_TOTAL = 4 + DATA_LEN + 2; // 24 bytes

// Build an 8-byte control/poll frame byte-for-byte from the app: AB CD 00 04 <cmd> <arg> 01 <chk>.
// The checksum is the low byte of the 16-bit additive sum of the six bytes b[0..5] (header +
// length + cmd + arg) — it deliberately excludes the trailing 0x01 marker. Verified against the
// captured poll 0x81 (sum b[0..5]=0x181) and hold 0xE8 frames; all nine commands round-trip.
function control(cmd: number, arg: number): Uint8Array {
  const chkBody = [SOF_H, SOF_L, 0x00, 0x04, cmd, arg];
  let sum = 0;
  for (const x of chkBody) sum += x;
  return Uint8Array.from([...chkBody, 0x01, sum & 0xff]);
}

// Soft-button + poll command frames, byte-for-byte from UT117cManager. We build them with the
// checksum helper and assert (in tests) they equal the captured bytes.
const CMD = {
  POLL: control(0x05, 0x00), //        AB CD 00 04 05 00 01 81
  SELECT: control(0x01, 0x5a), //      AB CD 00 04 01 5A 01 D7
  RANGE: control(0x02, 0x01), //       AB CD 00 04 02 01 01 7F  (enter manual)
  RANGE_AUTO: control(0x02, 0x00), //  AB CD 00 04 02 00 01 7E  (exit → auto)
  REL: control(0x03, 0x5a), //         AB CD 00 04 03 5A 01 D9
  MAXMIN: control(0x04, 0x01), //      AB CD 00 04 04 01 01 81  (enter)
  HOLD: control(0x12, 0x5a), //        AB CD 00 04 12 5A 01 E8
  LPF: control(0x14, 0x5a), //         AB CD 00 04 14 5A 01 EA
  BACKLIGHT: control(0x15, 0x5a), //   AB CD 00 04 15 5A 01 EB
} as const;

export const UT117C_COMMANDS = CMD;

// A reading mirroring a blank/garbled frame, returned instead of throwing (decode never throws).
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

// Map a funcID (b[5]) to a stable function key. The authoritative display strings live in the
// app's res/raw/config_ut117c.json (absent from the decompiled sources); these names are
// reverse-engineered from the per-function feature switches in UT117CUtils/UT117CTestDataModel.
const FUNCTIONS: Record<number, string> = {
  1: 'ACV',
  2: 'ACV', // ACV + LPF
  3: 'ACV', // ACV small range
  4: 'DCV',
  5: 'DCV',
  6: 'OHM',
  7: 'CONT',
  8: 'DIODE',
  9: 'CAP',
  10: 'LozV', // Auto V (LoZ) — AC or DC per flag2
  11: 'Hz',
  12: 'Hz', // Hz + LPF
  13: 'NCV',
  14: 'DCA',
  15: 'ACA',
  16: 'Hz', // current AC + Hz
  17: 'ACA', // clamp AC
  18: 'ACA', // clamp AC
  19: 'DCA', // clamp DC
};

const ASCII = (b: number): string => (b === 0 ? '' : String.fromCharCode(b));

// Read an ASCII string from a byte slice; NUL bytes terminate (the app treats all-zero as empty),
// 'o' is remapped to 'Ω' (the meter's display glyph). Trailing/leading whitespace trimmed.
function asciiString(bytes: Uint8Array, start: number, len: number, remapOhm: boolean): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const b = bytes[start + i];
    if (b === undefined || b === 0) break;
    s += remapOhm && b === 0x6f /* 'o' */ ? 'Ω' : ASCII(b);
  }
  return s.trim();
}

const NUMERIC = /^-?\d*\.?\d+$/;

/**
 * Decode one UT117C measurement frame (TYPE 2) into a Reading. Pure + tolerant: a short, mistyped,
 * or otherwise unparseable frame yields a blank reading rather than throwing.
 */
export function decodeUt117c(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < DATA_TOTAL) return blank(ts);
  if (bytes[0] !== SOF_H || bytes[1] !== SOF_L) return blank(ts);
  if (bytes[4] !== TYPE_DATA) return blank(ts);

  const funcID = bytes[5] ?? 0;
  const rangIndex = bytes[6] ?? 0;
  const olFlag = bytes[18] ?? 0;
  const flag1 = bytes[20] ?? 0;
  const flag2 = bytes[21] ?? 0;

  const fn = FUNCTIONS[funcID] ?? `#${funcID}`;

  // flag2 bit1: AC when set, DC when clear (setDc = ((flag2 & 2) == 0)).
  const isAc = (flag2 & 0x02) !== 0;
  // AC/DC is only meaningful for the V/A functions (and LoZ auto-V).
  const acdcRelevant =
    fn === 'ACV' || fn === 'DCV' || fn === 'DCA' || fn === 'ACA' || fn === 'LozV';
  const acdc: Reading['acdc'] = acdcRelevant ? (isAc ? 'AC' : 'DC') : '';

  const valueStr = asciiString(bytes, 8, 7, false);
  const displayUnit = asciiString(bytes, 15, 3, true);

  // NCV (funcID 13) shows a strength label, not a number: HI when rangIndex=='1' (0x31) else LO.
  if (funcID === 13) {
    const text = rangIndex === 0x31 ? 'HI' : 'LO';
    return {
      ...blank(ts),
      function: 'NCV',
      displayText: text,
      displayUnit: '',
      flags: {
        max: false,
        min: false,
        hold: (flag1 & 0x02) !== 0,
        rel: (flag1 & 0x01) !== 0,
        auto: (flag2 & 0x08) !== 0,
        lowBattery: (flag1 & 0x08) !== 0,
        hvWarning: (flag2 & 0x01) !== 0,
        peakMax: false,
        peakMin: false,
      },
    };
  }

  const numeric = valueStr.length > 0 && NUMERIC.test(valueStr);
  // Overload only applies to a numeric reading (olFlag overrides the value string).
  const overload = numeric && (olFlag === 0x31 || olFlag === 0x32);

  let displayText: string;
  if (overload) displayText = olFlag === 0x32 ? '-OL' : 'OL';
  else displayText = valueStr;

  const displayValue = numeric && !overload ? Number(valueStr) : null;

  const { base: baseUnit, exp } = unitInfo(displayUnit);
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  return {
    ts,
    function: fn,
    displayText,
    displayValue,
    displayUnit,
    baseValue,
    baseUnit,
    overload,
    acdc,
    bargraph: 0,
    flags: {
      max: false, // max/min recording state (b[19]) is a mode, not surfaced as a bit here
      min: false,
      hold: (flag1 & 0x02) !== 0,
      rel: (flag1 & 0x01) !== 0,
      auto: (flag2 & 0x08) !== 0,
      lowBattery: (flag1 & 0x08) !== 0,
      hvWarning: (flag2 & 0x01) !== 0,
      peakMax: false,
      peakMin: false,
    },
  };
}

// Classify a complete AB-CD frame by its type byte. Measurement (type 2) → 'measurement';
// the command ACK (type 1) → 'control' (the session resumes polling on it).
function classify(frame: Uint8Array): ParsedFrame['kind'] {
  return frame[4] === TYPE_DATA ? 'measurement' : 'control';
}

// Framer: accumulate bytes, sync on AB CD, read the big-endian LEN at b[2..3], and slice a full
// frame once enough bytes have arrived. A measurement frame is LEN(18)+6 = 24 bytes; the ACK and
// any other type are handled by the same length-driven slice. Validates the trailing 16-bit
// additive checksum on measurement frames so a false AB-CD inside noise resyncs instead of
// corrupting a reading. Tolerates split/coalesced notifications.
class Ut117cFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < 5) break; // need AB CD LEN_H LEN_L type
      const len = (this.buf[2]! << 8) | this.buf[3]!;
      const total = 4 + len + 2; // header + payload + 2-byte checksum
      if (len < 1 || total > 64) {
        this.buf.shift(); // bogus length — false header inside noise; resync
        continue;
      }
      if (this.buf.length < total) break; // frame split across notifications — wait
      const frame = Uint8Array.from(this.buf.slice(0, total));
      if (frame[4] === TYPE_DATA && !checksumOk(frame)) {
        this.buf.shift(); // desync: not a real frame boundary — resync past it
        continue;
      }
      this.buf.splice(0, total);
      out.push({ kind: classify(frame), bytes: frame });
    }
    return out;
  }

  reset(): void {
    this.buf.length = 0;
  }

  private sync(): void {
    while (this.buf.length >= 1) {
      if (this.buf[0] !== SOF_H) {
        this.buf.shift();
        continue;
      }
      if (this.buf.length >= 2 && this.buf[1] !== SOF_L) {
        this.buf.shift();
        continue;
      }
      break;
    }
  }
}

// 16-bit big-endian additive checksum over every byte preceding the trailing 2 checksum bytes.
export function checksumOk(frame: Uint8Array): boolean {
  if (frame.length < 3) return false;
  let sum = 0;
  for (let i = 0; i < frame.length - 2; i++) sum += frame[i]!;
  sum &= 0xffff;
  return (
    ((sum >> 8) & 0xff) === frame[frame.length - 2] && (sum & 0xff) === frame[frame.length - 1]
  );
}

// Sniffer for the shared ISSC service collision: a UT117C measurement frame is 24 bytes, starts
// with AB CD, carries LEN=0x12 and type byte 2, and its 16-bit additive checksum validates.
export function looksLikeUt117cFrame(bytes: Uint8Array): boolean {
  return (
    bytes.length === DATA_TOTAL &&
    bytes[0] === SOF_H &&
    bytes[1] === SOF_L &&
    bytes[2] === 0x00 &&
    bytes[3] === DATA_LEN &&
    bytes[4] === TYPE_DATA &&
    checksumOk(bytes)
  );
}

const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';

export const ut117c: Driver = {
  id: 'ut117c',
  label: 'UT117C Digital Multimeter',
  verification: 'ported-unverified',
  namePrefixes: ['UT117C'],
  // Shares the ISSC service with the other UNI-T models; this model uses WriteUUID2 (…8841…)
  // for every write. The registry's ISSC name-routing picks this driver by name prefix.
  gatt: { service: ISSC_SERVICE, notify: ISSC_NOTIFY, write: [ISSC_WRITE] },

  match: ctx => ctx.name?.startsWith('UT117C') ?? false,

  createFramer: () => new Ut117cFramer(),

  // No persistent handshake — the meter answers one frame per poll. Kick the poll loop once;
  // the session's keep-alive + onRequest re-arm keeps data flowing.
  async handshake(io) {
    await io.write(CMD.POLL);
  },

  // The meter is request/response: re-send the poll whenever it answers (a measurement frame) or
  // ACKs a control command, so the next reading is requested. This mirrors startRealTimeRead's
  // loop and the ACK-resumes-polling behaviour in UT117cManager.
  onRequest(frame, io) {
    void frame;
    void io.write(CMD.POLL);
  },

  decode: (bytes, ts) => decodeUt117c(bytes, ts),

  // Front-panel soft buttons, reverse-engineered from the UNI-T Smart Measure app.
  controls: {
    backlight: CMD.BACKLIGHT,
    hold: CMD.HOLD,
    rel: CMD.REL,
    select: CMD.SELECT,
    range: CMD.RANGE,
    rangeAuto: CMD.RANGE_AUTO,
    maxMin: CMD.MAXMIN,
  },

  sniff: looksLikeUt117cFrame,
};
