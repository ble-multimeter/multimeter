// owon-old driver — the legacy OWON B35T(+) text protocol (the source Windows app's
// `b35tDecodeOld`, dispatched when `isBDM == 1`). GATT service 0xFFF0, the same service the
// bdm / owon-plus / voltcraft families also advertise (the orchestrator resolves the
// collision via `looksLikeOwonOldFrame` below).
//
// Ported from webspiderteam/Bluetooth-DMM-For-Windows `Decoders/DecoderOwon.cs`
// (`b35tDecodeOld`), then validated byte-exact against the official OWON Multimeter BLE4.0 app's
// `handleReceivedData_B35` decoder via the fake-ble-meter emulator oracle (a hardware-free bench
// test). That validation fixed two real bugs vs. the third-party C# port: byte6 is an ASCII
// decimal-point digit (not a bitmask), and the nano prefix is byte8 bit1 (not byte10 bit2). So
// `verification` is 'app-verified' — decode-verified against the vendor app, not yet live on a
// physical meter (the OWON app couldn't render this meter live due to its own CCCD bug).
//
// Frame format — unlike its XOR-scrambled bdm sibling, owon-old streams *plain ASCII*:
//   * 14 bytes, one notification == one frame, terminated by CR LF (0x0D 0x0A).
//   * byte 0 : sign — '+' (0x2B/43) or '-' (0x2D/45).
//   * bytes 1..4 : four ASCII value digits '0'..'9'; '?' in the outer positions means OL.
//   * byte 5 : a literal space (0x20/32).
//   * byte 6 : decimal-point position, an ASCII DIGIT (NOT a bitmask) — the vendor app's
//              `handleReceivedData_B35` switches on the char: '1'(0x31)→3 decimals,
//              '2'(0x32)→2, '4'(0x34)→1, anything else→0.
//   * byte 7 : mode bitfield — hold/rel/AC/DC/auto.
//   * byte 8 : min/max + battery bitfield, plus the nano prefix (bit1, BIT_NANO).
//   * byte 9, byte 10 : scale-prefix (m/µ/M/k) + unit bitfields (assembled into "mV", "kΩ",
//                       "µA", "nF", …). The nano prefix is NOT here — it's byte 8 bit 1.
//   * byte 11 : a vendor status/checksum byte (not decoded).
//   * bytes 12..13 : CR LF.

import { unitInfo, type Reading } from '../types';
import type { ParsedFrame } from '../framing';
import type { Driver, DriverFramer } from './types';

const FRAME_LEN = 14;
const SIGN_PLUS = 0x2b; // '+'
const SIGN_MINUS = 0x2d; // '-'
const SPACE = 0x20; // byte 5
const CR = 0x0d;
const LF = 0x0a;

const isBitSet = (b: number, pos: number): boolean => (b & (1 << pos)) !== 0;

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
// Mirrors bdm.ts `functionFor`.
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
 * Decode one 14-byte owon-old ASCII frame into a Reading. Pure + unit-tested. Degrades
 * gracefully: a short frame yields a blank reading, and the source's OL sentinel ("?…?")
 * is surfaced as overload (→ non-numeric → value null) rather than throwing.
 */
export function decodeOwonOld(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < FRAME_LEN) return blank(ts);

  // Sign (source: only '-' / dec 45 flips it; anything else is positive).
  let text = bytes[0] === SIGN_MINUS ? '-' : '';

  // Decimal-point position: byte6 is an ASCII digit (app `handleReceivedData_B35` switches on
  // the char), NOT a bitmask. '1'(0x31)→3 decimals, '2'(0x32)→2, '4'(0x34)→1, else→0.
  const point = bytes[6] === 0x31 ? 3 : bytes[6] === 0x32 ? 2 : bytes[6] === 0x34 ? 1 : 0;

  // Four ASCII value digits. The source's OL sentinel is the outer chars being '?'.
  let digits = String.fromCharCode(bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!);
  const overload = digits.startsWith('?') && digits.endsWith('?');
  if (overload) digits = ' OL ';

  text +=
    point !== 0
      ? digits.slice(0, digits.length - point) + '.' + digits.slice(digits.length - point)
      : digits;
  const displayText = text.trim();

  // Mode bitfield (byte 7).
  const hold = isBitSet(bytes[7]!, 1);
  const rel = isBitSet(bytes[7]!, 2);
  const acdc: Reading['acdc'] = isBitSet(bytes[7]!, 3) ? 'AC' : isBitSet(bytes[7]!, 4) ? 'DC' : '';
  const auto = isBitSet(bytes[7]!, 5);

  // Min/Max + battery (byte 8).
  const max = isBitSet(bytes[8]!, 5);
  const min = isBitSet(bytes[8]!, 4);
  const lowBattery = isBitSet(bytes[8]!, 3);

  // Scale prefix (byte 9) + unit (byte 10). Diode/continuity also live in byte 9.
  const diode = isBitSet(bytes[9]!, 2);
  const cont = isBitSet(bytes[9]!, 3);

  // Assembled in the source's exact order so prefixes land before the base unit. The nano ("n")
  // prefix lives in byte 8 bit 1 (the vendor app's BIT_NANO), an annunciator independent of the
  // farad bit — NOT byte10 bit2 gated on byte9 (the earlier C#-port assumption was wrong).
  let displayUnit = '';
  if (isBitSet(bytes[10]!, 1)) displayUnit += '°C';
  if (isBitSet(bytes[10]!, 0)) displayUnit += '°F';
  if (isBitSet(bytes[8]!, 1)) displayUnit += 'n';
  if (isBitSet(bytes[9]!, 6)) displayUnit += 'm';
  if (isBitSet(bytes[9]!, 7)) displayUnit += 'µ';
  if (isBitSet(bytes[9]!, 4)) displayUnit += 'M';
  if (isBitSet(bytes[9]!, 5)) displayUnit += 'k';
  if (isBitSet(bytes[10]!, 7)) displayUnit += 'V';
  if (isBitSet(bytes[10]!, 2)) displayUnit += 'F';
  if (isBitSet(bytes[9]!, 1)) displayUnit += '%';
  if (isBitSet(bytes[10]!, 5)) displayUnit += 'Ω';
  if (isBitSet(bytes[10]!, 3)) displayUnit += 'Hz';
  if (isBitSet(bytes[10]!, 6)) displayUnit += 'A';

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
      max,
      min,
      hold,
      rel,
      auto,
      lowBattery,
      hvWarning: false, // not surfaced in the owon-old frame
      peakMax: false,
      peakMin: false,
    },
  };
}

/**
 * Sniffer that distinguishes an owon-old frame from the other 0xFFF0 families (bdm /
 * owon-plus / voltcraft). owon-old is the only one of them that is plain ASCII and
 * CR/LF-terminated, which makes it cheap and unambiguous to recognise:
 *
 *   1. exactly 14 bytes,
 *   2. byte 0 is an ASCII sign '+' or '-',
 *   3. byte 5 is an ASCII space,
 *   4. the frame ends with CR LF,
 *   5. the value field (bytes 1..4) is either four ASCII digits '0'..'9', or the source's OL
 *      sentinel — bytes 1 and 4 both '?' (the inner two bytes are then don't-cares, e.g. "?0:?").
 *
 * vs. owon-plus (its closest relative): owon-plus frames are *binary* little-endian words —
 * byte 0 is a low byte of the symbols field (rarely 0x2B/0x2D), there is no 0x20 at byte 5,
 * and they are not CR/LF terminated. vs. bdm: bdm frames are 11 bytes, XOR-scrambled, and
 * start with the constant 0x1B 0x84 header (never an ASCII sign). So the ASCII-sign + space +
 * CRLF triple is owon-old-exclusive within the 0xFFF0 collision set.
 */
export function looksLikeOwonOldFrame(bytes: Uint8Array): boolean {
  if (bytes.length !== FRAME_LEN) return false;
  if (bytes[0] !== SIGN_PLUS && bytes[0] !== SIGN_MINUS) return false;
  if (bytes[5] !== SPACE) return false;
  if (bytes[12] !== CR || bytes[13] !== LF) return false;
  // The OL sentinel: bytes 1 and 4 both '?' (inner bytes are don't-cares in the source check).
  const isOL = bytes[1] === 0x3f && bytes[4] === 0x3f;
  if (!isOL) {
    for (let i = 1; i <= 4; i++) {
      if (bytes[i]! < 0x30 || bytes[i]! > 0x39) return false; // not an ASCII digit
    }
  }
  return true;
}

// Framer: owon-old frames are fixed 14 bytes ending in CR LF, one per notification. We sync on
// the leading ASCII sign and slice fixed frames, tolerating split/coalesced notifications like
// the other drivers' framers even though in practice one notification == one frame.
class OwonOldFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < FRAME_LEN) break;
      // Validate the CR LF terminator; if it's wrong we lost sync — drop one byte and retry.
      if (this.buf[12] !== CR || this.buf[13] !== LF) {
        this.buf.shift();
        continue;
      }
      out.push({ kind: 'measurement', bytes: Uint8Array.from(this.buf.slice(0, FRAME_LEN)) });
      this.buf.splice(0, FRAME_LEN);
    }
    return out;
  }

  reset(): void {
    this.buf.length = 0;
  }

  // Discard leading bytes until the buffer starts with an ASCII sign ('+' / '-').
  private sync(): void {
    while (this.buf.length >= 1 && this.buf[0] !== SIGN_PLUS && this.buf[0] !== SIGN_MINUS) {
      this.buf.shift();
    }
  }
}

const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF4_NOTIFY = '0000fff4-0000-1000-8000-00805f9b34fb';
const FFF3_WRITE = '0000fff3-0000-1000-8000-00805f9b34fb';

export const owonOld: Driver = {
  id: 'owon-old',
  label: 'Owon B35T (legacy)',
  verification: 'app-verified',
  // OWON legacy meters advertise inconsistent names; discovery leans on the 0xFFF0 service
  // filter (shared with bdm/owon-plus/voltcraft — the orchestrator disambiguates via
  // looksLikeOwonOldFrame once frames arrive), with name prefixes as hints.
  namePrefixes: ['BDM', 'OWON', 'B35'],
  gatt: { service: FFF0_SERVICE, notify: FFF4_NOTIFY, write: [FFF3_WRITE] },

  // Returns true on the shared 0xFFF0 service (collision resolved by the orchestrator) or a
  // known name prefix.
  match: ctx =>
    (ctx.services?.includes(FFF0_SERVICE) ?? false) ||
    (ctx.name?.startsWith('BDM') ?? false) ||
    (ctx.name?.startsWith('OWON') ?? false) ||
    (ctx.name?.startsWith('B35') ?? false),

  createFramer: () => new OwonOldFramer(),

  // No handshake: like the rest of the FFF0 family, the meter streams notifications once
  // subscribed.
  async handshake() {
    /* nothing to do */
  },

  // No request/response keep-alive in this family.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeOwonOld(bytes, ts),

  sniff: looksLikeOwonOldFrame,
};
