// BDM driver — the "Bluetooth DMM" family (DevType 0 in the source Windows app's GATT table,
// GATT service 0xFFF0). One decoder unlocks ~12 rebadged clones: Aneng V05B/AN9002/ST207/AN999S,
// BSIDE ZT-5B/ZT-300AB/ZT-5BQ, ZOYI ZT-5B/ZT-300AB/ZT-5BQ/ZT-5566SE, BABATools AD900 (PLAN §6).
//
// Originally ported from webspiderteam/Bluetooth-DMM-For-Windows `DecoderBluetoothDMM.cs`, then
// cross-checked byte-exact against the official "Bluetooth DMM" Android app (com.yscoco.wyboem).
// Two device-types are decoded (dispatched on descrambled byte[2]):
//   * AB_300 (3, 11 bytes) — bench-verified on an Aneng AN9002.
//   * S_5G   (2, 10 bytes) — bench-verified on a ZOYI ZT-5B (value/unit/AC-DC/diode/cont/hold/rel/
//     battery confirmed live); annunciator bits derived from the app's getAllResult→getUnit/getTag
//     mapping. The S_5G max/min/auto bit positions are still unconfirmed (left false).
// → `verification` is 'live-tested' (PLAN §6 "Verification honesty").
//
// Frame format (no AB-CD sync, no checksum, no handshake — the meter just streams notifications):
//   * one notification == one frame; length is set by the device-type byte (see TYPE_LEN).
//   * Each byte is XOR-scrambled with a fixed key; descrambling yields the MSB-first bit string.
//   * The first two raw bytes are constant (0x1B 0x84), which we use as the framing sync header.
//   * Four 7-segment digits live at fixed bit offsets; flags/units are individual bits.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

// XOR descramble key (first 11 of the source's 20-byte `datashift`; only 11 are used for the
// 11-byte BDM frame). Source literal: { 65,33,115,85,256-94,256-63,50,113,102,256-86,59,... }.
const DATASHIFT = [65, 33, 115, 85, 162, 193, 50, 113, 102, 170, 59] as const;

// Every "Bluetooth DMM" device-type shares the raw header 0x1B 0x84 and the same 4-digit value
// decode (bytes 3..7); they differ in frame length and annunciator bit layout. Descrambled byte[2]
// is the device-type (1=QB_5G, 2=S_5G, 3=AB_300, 4=P_66). We decode the two that map cleanly to the
// app's canonical getUnit/getTag tables and that we've seen on real hardware:
//   * AB_300 (3, 11 bytes) — Aneng AN9002, bench-verified.
//   * S_5G   (2, 10 bytes) — ZOYI ZT-5B.
// QB_5G(1)/P_66(4) advertise on the same family but aren't decoded — their frames aren't claimed by
// the sniffer/framer, so such a device just fails to identify rather than mis-decoding.
const TYPE_LEN: Record<number, number> = { 2: 10, 3: 11 };

// Constant raw header (= descrambled 0x1B 0x84 XOR datashift[0..1]); used only to sync the stream.
const SYNC0 = 0x1b;
const SYNC1 = 0x84;

// Descrambled byte[2] selects the device-type (valid only once the 0x1B 0x84 header is confirmed).
const deviceType = (bytes: Uint8Array): number => (bytes[2]! ^ DATASHIFT[2]!) & 0xff;

// 7-segment lookup (source `ParsedigitBDM`). Key = first-3-bits + second-4-bits of a digit field.
const SEG: Record<string, string> = {
  '0000000': ' ',
  '1111110': 'A',
  '0010011': 'U',
  '0110101': 'T',
  '0010111': 'O',
  '1110101': 'E',
  '1110100': 'F',
  '0110001': 'L',
  '0000100': '-',
  '1111011': '0',
  '0001010': '1',
  '1011101': '2',
  '1001111': '3',
  '0101110': '4',
  '1100111': '5',
  '1110111': '6',
  '1001010': '7',
  '1111111': '8',
  '1101111': '9',
};

// Descramble `len` raw bytes into the MSB-first bit string the source calls `newValue`.
function descramble(bytes: Uint8Array, len: number): string {
  let bits = '';
  for (let i = 0; i < len; i++) {
    bits += ((bytes[i]! ^ DATASHIFT[i]!) & 0xff).toString(2).padStart(8, '0');
  }
  return bits;
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

// Map a displayed unit + AC/DC + mode flags to a range-independent function key, so range
// changes (mV↔V, kΩ↔MΩ) stay one chart segment while a real mode change splits (PLAN §3.4).
function functionFor(baseUnit: string, acdc: string, diode: boolean, cont: boolean): string {
  if (diode) return 'DIODE';
  if (cont) return 'CONT';
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
    case '°C':
      return '°C';
    case '°F':
      return '°F';
    default:
      return baseUnit || '?';
  }
}

const NUMERIC = /^-?\d*\.?\d+$/;

// Shared 4-digit 7-segment value decode (descrambled bytes 3..7). The app calls the identical
// getCount/getStringCount for every device-type, so this is type-independent. Digit n: a
// sign/decimal-point prefix bit, then a 7-bit segment field (3 bits + 4 bits at non-adjacent
// offsets), per the source's BDMDecode loop.
function decodeDigits(
  bits: string,
  on: (i: number) => boolean,
): { displayText: string; displayValue: number | null; overload: boolean } {
  const prePoints = ['-', '.', '.', '.'];
  let text = '';
  for (let n = 0; n < 4; n++) {
    const fi = (n + 3) * 8;
    const first = bits.slice(fi, fi + 3);
    const si = (n + 4) * 8 + 4;
    const second = bits.slice(si, si + 4);
    const prefix = on((n + 3) * 8 + 3) ? prePoints[n] : '';
    text += prefix + (SEG[first + second] ?? '?');
  }
  const displayText = text.trim();
  const overload = displayText.includes('L'); // "OL"/"0.L"/"0L."/".0L" — dot floats with range
  const numeric = !overload && NUMERIC.test(displayText);
  return { displayText, overload, displayValue: numeric ? Number(displayText) : null };
}

// Assemble the common tail of a Reading (unit scaling + range-independent function key) once, so the
// per-device-type decoders only differ in how they read digits/annunciators off the frame.
function finishReading(
  ts: number,
  p: {
    displayText: string;
    displayValue: number | null;
    overload: boolean;
    displayUnit: string;
    acdc: Reading['acdc'];
    diode: boolean;
    cont: boolean;
    flags: Reading['flags'];
  },
): Reading {
  const { base: baseUnit, exp } = unitInfo(p.displayUnit);
  const baseValue = p.displayValue === null ? null : p.displayValue * 10 ** exp;
  return {
    ts,
    function: functionFor(baseUnit, p.acdc, p.diode, p.cont),
    displayText: p.displayText,
    displayValue: p.displayValue,
    displayUnit: p.displayUnit,
    baseValue,
    baseUnit,
    overload: p.overload,
    acdc: p.acdc,
    bargraph: 0,
    flags: p.flags,
  };
}

// AB_300 (device-type 3, 11-byte) — ported from the C# app and cross-checked against the official
// app's getRightOrderTable300 reorder. Bench-verified on an Aneng AN9002. Unit annunciators are
// assembled in the source's order so prefixes land before the base unit ("mV", "kΩ", "µA", "nF").
function decodeAb300(bytes: Uint8Array, ts: number): Reading {
  const bits = descramble(bytes, 11);
  const on = (i: number): boolean => bits[i] === '1';
  const { displayText, displayValue, overload } = decodeDigits(bits, on);

  let displayUnit = '';
  if (on(57)) displayUnit += '°C';
  if (on(58)) displayUnit += '°F';
  if (on(74)) displayUnit += 'm';
  if (on(75)) displayUnit += 'V';
  if (on(64)) displayUnit += 'n';
  if (on(65)) displayUnit += 'm';
  if (on(66)) displayUnit += 'µ';
  if (on(67)) displayUnit += 'F';
  if (on(69)) displayUnit += '%';
  if (on(76)) displayUnit += 'M';
  if (on(77)) displayUnit += 'k';
  if (on(78)) displayUnit += 'Ω';
  if (on(79)) displayUnit += 'Hz';
  if (on(85)) displayUnit += 'µ';
  if (on(84)) displayUnit += 'm';
  if (on(72)) displayUnit += 'A';

  return finishReading(ts, {
    displayText,
    displayValue,
    overload,
    displayUnit,
    acdc: on(68) ? 'AC' : on(73) ? 'DC' : '',
    diode: on(56),
    cont: on(28),
    flags: {
      max: on(71),
      min: on(70),
      hold: on(59),
      rel: on(30),
      auto: on(87),
      lowBattery: on(31),
      hvWarning: false, // not surfaced in the 11-byte BDM frame
      peakMax: false,
      peakMin: false,
    },
  });
}

// S_5G (device-type 2, 10-byte) — ZOYI ZT-5B et al. Same canonical getUnit/getTag semantics as
// AB_300, but the app feeds getAllResult straight in (no getRightOrderTable300 reorder), so the
// physical bit offsets differ. Derived from that mapping and cross-checked against AB_300's verified
// offsets; prefix/base follow the app's getStartUnitString/getEndUnitString priority order.
function decodeS5g(bytes: Uint8Array, ts: number): Reading {
  const bits = descramble(bytes, 10);
  const on = (i: number): boolean => bits[i] === '1';
  const { displayText, displayValue, overload } = decodeDigits(bits, on);

  const prefix = on(71) ? 'n' : on(64) ? 'µ' : on(76) ? 'M' : on(77) ? 'm' : on(78) ? 'k' : '';
  const base = on(70)
    ? 'V'
    : on(65)
      ? 'A'
      : on(67)
        ? 'F'
        : on(79)
          ? 'Ω'
          : on(74)
            ? 'Hz'
            : on(73)
              ? '°F'
              : on(72)
                ? '°C'
                : '';

  return finishReading(ts, {
    displayText,
    displayValue,
    overload,
    displayUnit: prefix + base,
    acdc: on(68) ? 'AC' : on(69) ? 'DC' : '',
    diode: on(66),
    cont: on(28),
    flags: {
      // hold/rel/lowBattery sit at the canonical zArr[2]/[1]/[3] bits (same meaning as AB_300,
      // re-derived for this layout). max/min/auto aren't defined by the app's getUnit/getTag path
      // and their S_5G positions are unconfirmed, so they stay false pending live validation.
      max: false,
      min: false,
      hold: on(30),
      rel: on(29),
      auto: false,
      lowBattery: on(31),
      hvWarning: false,
      peakMax: false,
      peakMin: false,
    },
  });
}

/**
 * Decode one BDM frame into a Reading. Pure + unit-tested. Degrades gracefully: a short/garbled or
 * unknown-device-type frame yields a blank reading, and an unknown 7-segment glyph shows '?' rather
 * than throwing. Dispatches on the descrambled device-type byte (byte[2]).
 */
export function decodeBdm(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < 3 || bytes[0] !== SYNC0 || bytes[1] !== SYNC1) return blank(ts);
  const len = TYPE_LEN[deviceType(bytes)];
  if (len === undefined || bytes.length < len) return blank(ts);
  return deviceType(bytes) === 2 ? decodeS5g(bytes, ts) : decodeAb300(bytes, ts);
}

// Framer: BDM frames carry no sync word or checksum, but the first two raw bytes are constant
// (0x1B 0x84), so we sync on those and slice fixed 11-byte frames. Tolerates split/coalesced
// notifications like the uni-t FrameParser, even though in practice one notification == one frame.
class BdmFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < 3) break; // need the device-type byte (byte[2]) to size the frame
      const len = TYPE_LEN[(this.buf[2]! ^ DATASHIFT[2]!) & 0xff];
      if (len === undefined) {
        this.buf.shift(); // a 0x1B 0x84 header but an undecoded device-type — drop it and resync
        continue;
      }
      if (this.buf.length < len) break;
      out.push({ kind: 'measurement', bytes: Uint8Array.from(this.buf.slice(0, len)) });
      this.buf.splice(0, len);
    }
    return out;
  }

  reset(): void {
    this.buf.length = 0;
  }

  private sync(): void {
    while (this.buf.length >= 1) {
      if (this.buf[0] !== SYNC0) {
        this.buf.shift();
        continue;
      }
      if (this.buf.length >= 2 && this.buf[1] !== SYNC1) {
        this.buf.shift();
        continue;
      }
      break;
    }
  }
}

/**
 * Frame sniffer for the shared-0xFFF0 collision: a BDM frame starts with the constant raw header
 * 0x1B 0x84 and is exactly the length its descrambled device-type byte calls for (S_5G 10, AB_300
 * 11). Distinct from the other FFF0 families, which use different headers/lengths (owon-plus 6,
 * owon-old 14, voltcraft 15).
 */
export function looksLikeBdmFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 3 || bytes[0] !== SYNC0 || bytes[1] !== SYNC1) return false;
  const len = TYPE_LEN[deviceType(bytes)];
  return len !== undefined && bytes.length >= len;
}

const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF4_NOTIFY = '0000fff4-0000-1000-8000-00805f9b34fb';
const FFF3_WRITE = '0000fff3-0000-1000-8000-00805f9b34fb';

export const bdm: Driver = {
  id: 'bdm',
  label: 'Bluetooth DMM (Aneng/BSIDE/ZOYI)',
  verification: 'live-tested',
  // These meters advertise inconsistent names ("BDM" is common); discovery leans on the
  // service-UUID filter (transport offers 0xFFF0), with the name prefix as a hint.
  namePrefixes: ['BDM'],
  gatt: { service: FFF0_SERVICE, notify: FFF4_NOTIFY, write: [FFF3_WRITE] },

  match: ctx =>
    (ctx.services?.includes(FFF0_SERVICE) ?? false) || (ctx.name?.startsWith('BDM') ?? false),

  createFramer: () => new BdmFramer(),

  // No handshake: subscribing to notifications is enough — the meter streams immediately.
  async handshake() {
    /* nothing to do */
  },

  // No request/response keep-alive in this family.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeBdm(bytes, ts),

  sniff: looksLikeBdmFrame,
};
