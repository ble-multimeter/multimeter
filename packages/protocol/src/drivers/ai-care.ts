// AICARE driver — the "AICARE" clamp-meter family (DevType 3 in the source Windows app's GATT
// table, GATT service 0xFFB0). Covers the AICARE AP-570C-APP Bluetooth clamp meter and rebadges.
//
// Ported from webspiderteam/Bluetooth-DMM-For-Windows `Utilities.cs` `aiCareDecode` (the partial
// method the `isBDM == 3` dispatch actually calls — there is also a `DecoderAI_Care.cs` stub, but
// the live dispatch uses `aiCareDecode`). NOT bench-tested on physical hardware, so `verification`
// is 'ported-unverified' (PLAN §6 "Verification honesty").
//
// Frame format (no AB-CD sync, no checksum, no handshake — the meter streams notifications):
//   * 14 raw bytes, one notification == one frame.
//   * Each byte is SELF-ADDRESSING: high nibble = (1-based position), low nibble = 4 payload bits.
//     A byte at slot i (0-based) reads `((b & 0xf0) >> 4) - 1 == i`. We exploit this both to
//     descramble (scatter each low nibble to its addressed slot) and to sync the stream.
//   * Concatenating the 14 low nibbles in addressed order yields 56 bits ("values").
//   * Bits 0..3 are AC/DC/AUTO/BT flags; then four 8-bit digit fields (point bit + 7 segments)
//     at offsets 4,12,20,28; flags/units are individual bits at fixed offsets >= 36.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

const FRAME_LEN = 14;
const BIT_LEN = FRAME_LEN * 4; // 56

// 7-segment lookup (source `aiCareNumbers`). Key = the 7 segment bits of a digit field, in the
// source's segment order. Empty string = blank digit; 'L' is the overload glyph ("0L"/"0.L").
const SEG: Record<string, string> = {
  '1111101': '0',
  '0000101': '1',
  '1011011': '2',
  '0011111': '3',
  '0100111': '4',
  '0111110': '5',
  '1111110': '6',
  '0010101': '7',
  '1111111': '8',
  '0111111': '9',
  '1101000': 'L',
  '0000000': '', // blank digit (leading-zero suppression / no segments lit)
};

// Descramble: each raw byte addresses its own slot via the high nibble. Scatter the low nibble
// (4 bits) into that slot, then concatenate all 14 slots into a 56-bit string. Out-of-range or
// duplicate addresses are ignored (graceful degradation — never throws). Unaddressed slots stay
// zero, which the 7-segment table reads as a blank digit / cleared flag.
function descramble(bytes: Uint8Array): string {
  const slots = new Array<string>(FRAME_LEN).fill('0000');
  for (let i = 0; i < FRAME_LEN; i++) {
    const slot = ((bytes[i] & 0xf0) >> 4) - 1;
    if (slot >= 0 && slot < FRAME_LEN) {
      slots[slot] = (bytes[i] & 0x0f).toString(2).padStart(4, '0');
    }
  }
  return slots.join('');
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
 * Decode one 14-byte AICARE frame into a Reading. Pure + unit-tested. Degrades gracefully:
 * a short/garbled frame yields a blank reading, and an unknown 7-segment glyph shows '?'
 * (→ non-numeric → value null) rather than throwing (the C# source indexes a Dictionary that
 * would throw on an unknown key; we use a safe lookup instead).
 */
export function decodeAiCare(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < FRAME_LEN) return blank(ts);
  const v = descramble(bytes);
  if (v.length < BIT_LEN) return blank(ts);
  const on = (i: number): boolean => v[i] === '1';
  const seg = (start: number): string => SEG[v.slice(start, start + 7)] ?? '?';

  // Four digits A..D. Each field is 8 bits: a leading point/sign bit then 7 segment bits.
  // Source order: sign bit 4 ("-"), digit A segs 5..11, point bit 12, digit B 13..19, etc.
  const displayText = (
    (on(4) ? '-' : '') +
    seg(5) +
    (on(12) ? '.' : '') +
    seg(13) +
    (on(20) ? '.' : '') +
    seg(21) +
    (on(28) ? '.' : '') +
    seg(29)
  ).trim();

  // Unit annunciators (bit offsets from the source `aiCareDecode`, assembled in source order so
  // prefixes land before the base unit, e.g. "mV", "kΩ", "µA", "nF").
  let displayUnit = '';
  if (on(36)) displayUnit += 'µ';
  if (on(37)) displayUnit += 'n';
  if (on(38)) displayUnit += 'k';
  if (on(40)) displayUnit += 'm';
  if (on(42)) displayUnit += 'M';
  if (on(41)) displayUnit += '%';
  if (on(44)) displayUnit += 'F';
  if (on(45)) displayUnit += 'Ω';
  if (on(48)) displayUnit += 'A';
  if (on(49)) displayUnit += 'V';
  if (on(50)) displayUnit += 'Hz';
  if (on(53)) displayUnit += '°C';

  const acdc: Reading['acdc'] = on(0) ? 'AC' : on(1) ? 'DC' : '';
  const diode = on(39);
  const cont = on(43);

  const overload = displayText.includes('L'); // "0L"/"0.L" — dot floats with the active range
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
      max: false, // not surfaced in the AICARE frame
      min: false,
      hold: on(47),
      rel: on(46),
      auto: on(2),
      lowBattery: on(51),
      hvWarning: false, // not surfaced in the AICARE frame
      peakMax: false,
      peakMin: false,
    },
  };
}

// Framer: AICARE frames carry no sync word or checksum, but every byte is self-addressing — its
// high nibble equals its 1-based slot. We sync on a byte whose high nibble is 0x1 (slot 1, the
// frame start) and slice fixed 14-byte frames. Tolerates split/coalesced notifications like the
// uni-t FrameParser, even though in practice one notification == one frame.
class AiCareFramer implements DriverFramer {
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

  // Drop bytes until the head is a slot-1 byte (high nibble 0x1 = frame start).
  private sync(): void {
    while (this.buf.length >= 1 && (this.buf[0] & 0xf0) >> 4 !== 1) {
      this.buf.shift();
    }
  }
}

const FFB0_SERVICE = '0000ffb0-0000-1000-8000-00805f9b34fb';
const FFB2_NOTIFY = '0000ffb2-0000-1000-8000-00805f9b34fb';
const FFB1_WRITE = '0000ffb1-0000-1000-8000-00805f9b34fb';

export const aiCare: Driver = {
  id: 'ai-care',
  label: 'AICARE clamp meter',
  verification: 'ported-unverified',
  // AICARE owns its own GATT service (0xFFB0), so discovery is unambiguous — no FFF0 collision.
  // Names vary across rebadges; lean on the service filter with the name prefix as a hint.
  namePrefixes: ['AICARE', 'AI-Care'],
  gatt: { service: FFB0_SERVICE, notify: FFB2_NOTIFY, write: [FFB1_WRITE] },

  match: (ctx) =>
    (ctx.services?.includes(FFB0_SERVICE) ?? false) ||
    (ctx.name?.toUpperCase().startsWith('AICARE') ?? false),

  createFramer: () => new AiCareFramer(),

  // No handshake: subscribing to notifications is enough — the meter streams immediately.
  async handshake() {
    /* nothing to do */
  },

  // No request/response keep-alive in this family.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeAiCare(bytes, ts),
};
