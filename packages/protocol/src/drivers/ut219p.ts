// UT219P driver — the UNI-T UT219P AC Power / Clamp Meter (shared ISSC "Transparent UART"
// service 49535343-…). Unlike the UT60BT streamer, this model does NOT free-run: the host must
// poll. The handshake mirrors the UNI-T Smart Measure Android app's UT219pManager:
//   1. request device-info (CMDID 0x17)  →  unlocks the next step,
//   2. request battery     (CMDID 0x20)  →  app refuses to poll until deviceBattery>0,
//   3. start polling live-data (CMDID 0x05, type 0) every ~300 ms; the meter answers each poll.
//
// Ported from the UNI-T Smart Measure app (`com.uni_t.multimeter.ut219p.manager.UT219pManager`,
// `analyseCMD0`/`setStatusFlag`/`requestLiveDate`). NOT bench-tested on physical hardware, so
// `verification` is 'ported-unverified' (PLAN §6 "Verification honesty"). The standard-measurement
// frame layout and command-frame checksums are verified against the decompiled source; the
// daoPos→parameter-set dispatch (UTDeviceBean.setValue) was not decompilable and is inferred.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, FrameKind, ParsedFrame } from './types';

// Shared ISSC service (same family as uni-t.ts; the registry routes by name prefix to avoid the
// two drivers fighting over the service). Source: UT219pManager.java:57-59.
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';

const SOF0 = 0xab;
const SOF1 = 0xcd;

// CMDIDs (frame byte[4]). Device-info (0x17) and battery (0x20) replies are handled by literal
// request frames in the handshake; only the live CMDID is referenced during decode.
const CMD_LIVE = 0x05;

// ---- Command frames (literal byte arrays straight from the source; checksums verified). ----
// These small frames carry LEN=0x0004 and store their 16-bit LE checksum immediately after the
// LEN-counted region (chk over bytes[2 .. 2+LEN), stored at [2+LEN]). The battery probe is special:
// LEN=0x0005 and the trailing bytes are a fixed probe payload, NOT a checksum (UT219pManager
// :667 sends it verbatim).
const DEVINFO_REQ = new Uint8Array([0xab, 0xcd, 0x00, 0x04, 0x17, 0x00, 0x1b, 0x00]);
const BATTERY_REQ = new Uint8Array([0xab, 0xcd, 0x00, 0x05, 0x20, 0xe8, 0x03, 0x13, 0x01]);
const LIVE_STD = liveDataReq(0); // AB CD 00 04 05 00 09 00
const LOCK = new Uint8Array([0xab, 0xcd, 0x00, 0x04, 0x19, 0x5a, 0x77, 0x00]);
const UNLOCK = new Uint8Array([0xab, 0xcd, 0x00, 0x04, 0x19, 0xa5, 0xc2, 0x00]);
const OTA = new Uint8Array([0xab, 0xcd, 0x00, 0x04, 0x90, 0x00, 0x94, 0x00]);

// Build a live-data poll frame for a given screen `type` (0=standard, 7=wave-V, 8=wave-A,
// 3/4/5/6=harmonic variants). Source `requestLiveDate` :611-633:
//   AB CD 00 04 05 <type> <(type+9)&0xFF> <((type+9)>>8)&0xFF>
// The trailing two bytes are the LE checksum = sum(bytes[2..6)) = 0x04+0x05+type = type+9.
export function liveDataReq(type: number): Uint8Array {
  const sum = (type + 9) & 0xffff;
  return new Uint8Array([
    SOF0,
    SOF1,
    0x00,
    0x04,
    CMD_LIVE,
    type & 0xff,
    sum & 0xff,
    (sum >> 8) & 0xff,
  ]);
}

// ---- Reply envelope (parser convention, UT219pManager onDataReceive :271-435) ----
// [0]=AB [1]=CD [2..3]=LEN (big-endian) [4]=CMDID body… then 16-bit LE checksum at [i+4],[i+5]
// where i=LEN. Total reply length = i+6. The checksum covers bytes[2 .. i+4).
function payloadLen(frame: Uint8Array): number {
  return ((frame[2]! & 0xff) << 8) | (frame[3]! & 0xff);
}

// Validate a reply frame's checksum (chk over [2..i+4), LE at [i+4],[i+5]). Returns false on any
// shape problem so the framer/decoder degrades gracefully rather than throwing.
export function checksumOk(frame: Uint8Array): boolean {
  if (frame.length < 6) return false;
  if (frame[0] !== SOF0 || frame[1] !== SOF1) return false;
  const i = payloadLen(frame);
  if (i > frame.length - 6) return false;
  let sum = 0;
  for (let k = 2; k < i + 4; k++) sum += frame[k]!;
  sum &= 0xffff;
  return (sum & 0xff) === frame[i + 4] && ((sum >> 8) & 0xff) === frame[i + 5];
}

// Decode a 32-bit LE IEEE-754 float at byte offset `n` (buf[n] is LSB). Mirrors the source's
// Float.intBitsToFloat(getIntValue(buf[n+3],buf[n+2],buf[n+1],buf[n])).
function floatLE(frame: Uint8Array, n: number): number {
  const bits = (frame[n + 3]! << 24) | (frame[n + 2]! << 16) | (frame[n + 1]! << 8) | frame[n]!;
  const dv = new DataView(new ArrayBuffer(4));
  dv.setInt32(0, bits, false);
  return dv.getFloat32(0, false);
}

// Per-value overload codes packed in bytes[13..16]: 16 two-bit fields, MSB-first.
// 0=normal, 1=OL, 2=Err, 3='--' (negative overload). analyseCMD0 :564-585.
function overloadCodes(frame: Uint8Array): number[] {
  let j = ((frame[13]! << 24) | (frame[14]! << 16) | (frame[15]! << 8) | frame[16]!) >>> 0;
  const out: number[] = [];
  for (let k = 0; k < 16; k++) {
    out.push((j & 0xc0000000) >>> 30);
    j = (j << 2) >>> 0;
  }
  return out;
}

// statusByte1 (buf[7]) / statusByte2 (buf[8]) bit map — setStatusFlag :595-609.
function parseFlags(
  b1: number,
  b2: number,
): Reading['flags'] & {
  rangeValue: number;
  thd: boolean;
  hv: boolean;
} {
  const maxMin = (b1 & 0xc0) >> 6; // 0 none,1 MAX,2 MIN,3 AVG
  return {
    max: maxMin === 1,
    min: maxMin === 2,
    hold: (b1 & 0x10) !== 0,
    rel: (b2 & 0x08) !== 0,
    auto: (b1 & 0x02) === 0, // bit1 set = manual range
    lowBattery: false, // battery arrives via a separate CMDID-0x20 reply, not the status byte
    hvWarning: (b2 & 0x04) !== 0,
    peakMax: false,
    peakMin: false,
    rangeValue: (b1 & 0x0c) >> 2,
    thd: (b2 & 0x10) !== 0,
    hv: (b2 & 0x04) !== 0,
  };
}

// ---- Function / parameter-set tables (from UTDeviceBean param-set methods) ----
// Each parameter set is a 1-based list of [title, unit] entries keyed by the nibble index code.
// The exact daoPos→set dispatch is opaque in the source (UTDeviceBean.setValue not decompiled),
// so we expose the dominant ACV set as the default and a small lookup for the others. The decoder
// keys off byte[6] (daoPos) when a confident mapping is known, else falls back to the index code.
interface ParamLine {
  title: string;
  unit: string;
}

// ACV set (setACVParam): index 1..9.
const ACV_SET: Record<number, ParamLine> = {
  1: { title: 'ACV', unit: 'V' },
  2: { title: 'V(PEAK)', unit: 'V' },
  3: { title: 'Hz(V)', unit: 'Hz' },
  4: { title: 'V(MAX)', unit: 'V' },
  5: { title: 'TIME(MAX)', unit: '' },
  6: { title: 'V(MIN)', unit: 'V' },
  7: { title: 'TIME(MIN)', unit: '' },
  8: { title: 'V(AVG)', unit: 'V' },
  9: { title: 'TIME', unit: '' },
};

// ACA set (setACAParam): index 1..9.
const ACA_SET: Record<number, ParamLine> = {
  1: { title: 'ACA', unit: 'A' },
  2: { title: 'A(PEAK)', unit: 'A' },
  3: { title: 'Hz(A)', unit: 'Hz' },
  4: { title: 'A(MAX)', unit: 'A' },
  5: { title: 'TIME(MAX)', unit: '' },
  6: { title: 'A(MIN)', unit: 'A' },
  7: { title: 'TIME(MIN)', unit: '' },
  8: { title: 'A(AVG)', unit: 'A' },
  9: { title: 'TIME', unit: '' },
};

// Decimal places by rangeValue per the source dotNum switch tables (unitTable in the spec):
// ACV always 1dp; ACA range0→2dp,1→1dp,2→0dp; PF 3dp; θ/Hz 1dp.
function decimalsFor(unit: string, title: string, rangeValue: number): number {
  if (title === 'ACV' || unit === 'V') return 1;
  if (unit === 'A') return [2, 1, 0, 0][rangeValue] ?? 1;
  if (unit === 'kW' || unit === 'kVAr' || unit === 'kVA') return [2, 1, 0, 0][rangeValue] ?? 1;
  if (title === 'PF') return 3;
  if (unit === 'Hz') return 1;
  if (unit === '°') return 1;
  if (unit === '%') return 1;
  return 1;
}

// Map a parameter line + AC-clamp context to a stable function key (this is an AC meter — all
// V/A readings are AC). TIME/PF/θ keep their own key.
function functionFor(line: ParamLine): string {
  switch (line.unit) {
    case 'V':
      return 'ACV';
    case 'A':
      return 'ACA';
    case 'Hz':
      return 'Hz';
    case 'kW':
      return 'kW';
    case 'kVAr':
      return 'kVAr';
    case 'kVA':
      return 'kVA';
    case '°':
      return 'angle';
    case '%':
      return 'THD';
    case 'Wh':
      return 'Wh';
    default:
      return line.title || '?';
  }
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

const OVERLOAD_TEXT: Record<number, string> = { 1: 'OL', 2: 'Err', 3: '--' };

/**
 * Decode one UT219P reply frame into a Reading. Only the standard live-data measurement
 * (CMDID 0x05, cmdCode 0) yields a numeric reading; every other frame (waveform/harmonic tables,
 * device-info, battery, command echoes) returns a blank reading so the chart simply skips them.
 * Degrades gracefully: short/garbled/bad-checksum frames yield a blank reading rather than throwing.
 *
 * The first float (byte 19) is the meter's primary line; its title/unit come from the daoPos +
 * the first nibble index code (byte[11] hi-nibble). The per-value overload code (the first of the
 * 16 two-bit fields) replaces the number with OL / Err / -- when set.
 */
export function decodeUt219p(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < 6) return blank(ts);
  if (bytes[0] !== SOF0 || bytes[1] !== SOF1) return blank(ts);
  if (!checksumOk(bytes)) return blank(ts);

  const cmdId = bytes[4]!;
  if (cmdId !== CMD_LIVE) return blank(ts); // devinfo / battery / etc. carry no reading
  const cmdCode = bytes[5]!;
  if (cmdCode !== 0) return blank(ts); // waveform/harmonic frames are not chart readings here

  // Standard measurement (analyseCMD0). Need at least one float (frame must reach byte 22).
  if (bytes.length < 23) return blank(ts);

  const daoPos = bytes[6]!;
  const flagsFull = parseFlags(bytes[7]!, bytes[8]!);
  const codes = overloadCodes(bytes);

  // First nibble index code (byte[11] hi-nibble) selects the primary line in the active set.
  const idx = (bytes[11]! & 0xf0) >> 4;

  // daoPos→set dispatch is inferred. We default to ACV; daoPos values seen as the ACA set route
  // there. Without a decompiled setValue we keep this conservative: ACV set unless the index code
  // is clearly out of the ACV range. The unit/title is the load-bearing output; the float value is
  // always correct regardless.
  const set = chooseSet(daoPos);
  const line: ParamLine = set[idx] ?? set[1] ?? { title: `#${daoPos}.${idx}`, unit: '' };

  const code0 = codes[0] ?? 0;
  const overload = code0 === 1 || code0 === 3;

  const flags: Reading['flags'] = {
    max: flagsFull.max,
    min: flagsFull.min,
    hold: flagsFull.hold,
    rel: flagsFull.rel,
    auto: flagsFull.auto,
    lowBattery: flagsFull.lowBattery,
    hvWarning: flagsFull.hvWarning,
    peakMax: false,
    peakMin: false,
  };

  // Float count = (LEN-15)/4; first float at byte 19 (guarded by the length check above).
  const value = floatLE(bytes, 19);

  if (code0 !== 0) {
    // Per-value overload / error: blank the number and the unit (UT219ShowDataBean.getShowValue).
    return {
      ts,
      function: functionFor(line),
      displayText: OVERLOAD_TEXT[code0] ?? '--',
      displayValue: null,
      displayUnit: '',
      baseValue: null,
      baseUnit: '',
      overload,
      acdc: line.unit === 'V' || line.unit === 'A' ? 'AC' : '',
      bargraph: 0,
      flags,
    };
  }

  const dp = decimalsFor(line.unit, line.title, flagsFull.rangeValue);
  const displayText = Number.isFinite(value) ? value.toFixed(dp) : '';
  const displayValue = Number.isFinite(value) ? Number(displayText) : null;
  const displayUnit = line.unit;
  const { base: baseUnit, exp } = unitInfo(displayUnit);
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  return {
    ts,
    function: functionFor(line),
    displayText,
    displayValue,
    displayUnit,
    baseValue,
    baseUnit,
    overload: false,
    acdc: line.unit === 'V' || line.unit === 'A' ? 'AC' : '',
    bargraph: 0,
    flags,
  };
}

// Inferred daoPos→parameter-set dispatch. The precise integer values live in the non-decompiled
// UTDeviceBean.setValue; we expose the two confidently-tabled sets (ACV/ACA) and default to ACV.
function chooseSet(daoPos: number): Record<number, ParamLine> {
  // Without the decompiled mapping we treat unknown positions as ACV. A future hardware capture
  // can refine which daoPos values select ACA / 3P3W / 3P4W / Wh / phase-detect.
  switch (daoPos) {
    case 2:
      return ACA_SET;
    default:
      return ACV_SET;
  }
}

// Classify a reply frame for the engine: only CMDID 0x05 cmdCode 0 frames are measurements; the
// devinfo/battery replies are 'control' (they gate the handshake), everything else 'control'.
function classify(frame: Uint8Array): FrameKind {
  if (frame.length < 6) return 'control';
  if (frame[4] === CMD_LIVE && frame[5] === 0) return 'measurement';
  return 'control';
}

// Framer: slice the AB-CD envelope by the big-endian LEN at [2..3] (total = LEN+6) and validate
// the trailing LE checksum, tolerating split/coalesced notifications like the uni-t FrameParser.
class Ut219pFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < 4) break; // need AB CD LEN_h LEN_l
      const i = ((this.buf[2]! & 0xff) << 8) | (this.buf[3]! & 0xff);
      const total = i + 6;
      if (i < 1 || total > 2048) {
        this.buf.shift(); // bogus length → false AB CD; resync
        continue;
      }
      if (this.buf.length < total) break; // frame split across notifications — wait
      const frame = Uint8Array.from(this.buf.slice(0, total));
      if (!checksumOk(frame)) {
        this.buf.shift(); // desync; resync past this false boundary
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
      if (this.buf[0] !== SOF0) {
        this.buf.shift();
        continue;
      }
      if (this.buf.length >= 2 && this.buf[1] !== SOF1) {
        this.buf.shift();
        continue;
      }
      break;
    }
  }
}

export const ut219p: Driver = {
  id: 'ut219p',
  label: 'UT219P AC Power Clamp Meter',
  verification: 'ported-unverified',
  namePrefixes: ['UT219P', 'UT-219P'],
  gatt: { service: ISSC_SERVICE, notify: ISSC_NOTIFY, write: [ISSC_WRITE] },

  // Shared ISSC service: registry routes by name prefix so this and uni-t.ts don't collide.
  match: ctx =>
    (ctx.name?.startsWith('UT219P') ?? false) || (ctx.name?.startsWith('UT-219P') ?? false),

  createFramer: () => new Ut219pFramer(),

  // Polled handshake (UT219pManager): the meter does not stream. Request device-info, then the
  // battery probe (the app refuses to poll until deviceBattery>0), then start the standard
  // live-data poll. We nudge the live poll a few times until the first measurement arrives.
  async handshake(io) {
    await io.write(DEVINFO_REQ);
    await io.waitForFrame(k => k === 'control', 1500);
    await io.write(BATTERY_REQ);
    await io.waitForFrame(k => k === 'control', 1000);
    for (let attempt = 0; attempt < 5; attempt++) {
      await io.write(LIVE_STD);
      if (await io.waitForFrame(k => k === 'measurement', 700)) return;
    }
    throw new Error('UT219P did not answer live-data poll after handshake');
  },

  // The meter never asks us to re-send; the host keeps polling on its own cadence (handled by the
  // session's keep-alive timer issuing LIVE_STD). Nothing to do per inbound frame.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeUt219p(bytes, ts),

  // Sniffer for the shared ISSC service: a UT219P reply is an AB-CD envelope whose big-endian LEN
  // and trailing LE checksum line up (distinct from the uni-t 19-byte BE-checksum frame).
  sniff: bytes => checksumOk(bytes),

  // Front-panel / device controls (controlCodes in the spec). UT219P has no AB-CD-03 soft-button
  // scheme; HOLD is app-local (no BLE frame). The real device commands are lock/unlock (freeze for
  // waveform capture) and OTA. We map the generic control slots to the closest device action:
  //   hold       → LOCK (freeze the device readout; the app's HOLD is local-only)
  //   rel        → UNLOCK
  // plus the non-generic frames are exported above for callers that want them directly.
  controls: {
    hold: LOCK,
    rel: UNLOCK,
  },
};

// Exported command frames for callers that drive lock/waveform/OTA directly (not part of the
// generic MeterControl set).
export const COMMANDS = {
  DEVINFO_REQ,
  BATTERY_REQ,
  LIVE_STD,
  LOCK,
  UNLOCK,
  OTA,
} as const;
