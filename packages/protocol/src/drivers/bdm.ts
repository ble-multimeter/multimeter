// BDM driver — the "Bluetooth DMM" family (DevType 0 in the source Windows app's GATT table,
// GATT service 0xFFF0). One decoder unlocks ~12 rebadged clones: Aneng V05B/AN9002/ST207/AN999S,
// BSIDE ZT-5B/ZT-300AB/ZT-5BQ, ZOYI ZT-5B/ZT-300AB/ZT-5BQ/ZT-5566SE, BABATools AD900 (PLAN §6).
//
// Ported from webspiderteam/Bluetooth-DMM-For-Windows `DecoderBluetoothDMM.cs` (BDMDecode, the
// 11-byte `data.Count() == 11` path). Verified against the 36 annotated frames in the source's
// `Binary raw data.md` — but NOT bench-tested on physical hardware, so `verification` is
// 'ported-unverified' (PLAN §6 "Verification honesty").
//
// Frame format (no AB-CD sync, no checksum, no handshake — the meter just streams notifications):
//   * 11 raw bytes, one notification == one frame.
//   * Each byte is XOR-scrambled with a fixed key; descrambling yields 88 bits.
//   * The first two raw bytes are constant (0x1B 0x84), which we use as the framing sync header.
//   * Four 7-segment digits live at fixed bit offsets; flags/units are individual bits.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

// XOR descramble key (first 11 of the source's 20-byte `datashift`; only 11 are used for the
// 11-byte BDM frame). Source literal: { 65,33,115,85,256-94,256-63,50,113,102,256-86,59,... }.
const DATASHIFT = [65, 33, 115, 85, 162, 193, 50, 113, 102, 170, 59] as const;

const FRAME_LEN = 11;
// Constant raw header (= descrambled 0x1B 0x84 XOR datashift[0..1]); used only to sync the stream.
const SYNC0 = 0x1b;
const SYNC1 = 0x84;

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

// Descramble 11 raw bytes into the 88-bit string the source calls `newValue`.
function descramble(bytes: Uint8Array): string {
  let bits = '';
  for (let i = 0; i < FRAME_LEN; i++) {
    bits += ((bytes[i] ^ DATASHIFT[i]) & 0xff).toString(2).padStart(8, '0');
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

/**
 * Decode one 11-byte BDM frame into a Reading. Pure + unit-tested. Degrades gracefully:
 * a short/garbled frame yields a blank reading, and an unknown 7-segment glyph shows '?'
 * (→ non-numeric → value null) rather than throwing.
 */
export function decodeBdm(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < FRAME_LEN) return blank(ts);
  const bits = descramble(bytes);
  const on = (i: number): boolean => bits[i] === '1';

  // Four digits. Digit n: a sign/decimal-point prefix bit, then a 7-bit segment field
  // (3 bits + 4 bits at non-adjacent offsets), per the source's BDMDecode loop.
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

  // Unit annunciators (bit offsets from the source's `data.Count() == 11` branch). Assembled
  // in the source's order so prefixes land before the base unit ("mV", "kΩ", "µA", "nF").
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

  const acdc: Reading['acdc'] = on(68) ? 'AC' : on(73) ? 'DC' : '';
  const diode = on(56);
  const cont = on(28);

  const overload = displayText.includes('L'); // "OL"/"0.L"/"0L."/".0L" — dot floats with range
  const numeric = !overload && NUMERIC.test(displayText);
  const displayValue = numeric ? Number(displayText) : null;

  const { base: baseUnit, exp } = unitInfo(displayUnit);
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  return {
    ts,
    function: functionFor(baseUnit, acdc, diode, cont),
    displayText,
    displayValue,
    displayUnit,
    baseValue,
    baseUnit,
    overload,
    acdc,
    bargraph: 0,
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
  };
}

// Framer: BDM frames carry no sync word or checksum, but the first two raw bytes are constant
// (0x1B 0x84), so we sync on those and slice fixed 11-byte frames. Tolerates split/coalesced
// notifications like the uni-t FrameParser, even though in practice one notification == one frame.
class BdmFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]);
    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < FRAME_LEN) break;
      out.push({ kind: 'measurement', bytes: Uint8Array.from(this.buf.slice(0, FRAME_LEN)) });
      this.buf.splice(0, FRAME_LEN);
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

const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF4_NOTIFY = '0000fff4-0000-1000-8000-00805f9b34fb';
const FFF3_WRITE = '0000fff3-0000-1000-8000-00805f9b34fb';

export const bdm: Driver = {
  id: 'bdm',
  label: 'Bluetooth DMM (Aneng/BSIDE/ZOYI)',
  verification: 'ported-unverified',
  // These meters advertise inconsistent names ("BDM" is common); discovery leans on the
  // service-UUID filter (transport offers 0xFFF0), with the name prefix as a hint.
  namePrefixes: ['BDM'],
  gatt: { service: FFF0_SERVICE, notify: FFF4_NOTIFY, write: [FFF3_WRITE] },

  match: (ctx) =>
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
};
