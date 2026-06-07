// Owon "plus" driver — the modern Owon BLE multimeter family (B35T+/B41T+/OW18E/CM2100B and
// rebadges). DevType 2 (`isBDM == 2`) in the source Windows app's GATT table, GATT service 0xFFF0.
//
// Ported from webspiderteam/Bluetooth-DMM-For-Windows `Utilities.cs` `owonPlusTypeDecode` (the
// function dispatched for `isBDM == 2` / `TestDevice == 6`), cross-referenced with the inline
// protocol notes (the `BM35_BLE_*` UUIDs and the MODE_* function table). NOT bench-tested on
// physical hardware, so `verification` is 'ported-unverified' (PLAN §6 "Verification honesty").
//
// Frame format — IMPORTANT, this is what separates owon-plus from its FFF0 siblings:
//   * 6 raw little-endian bytes, one notification == one frame.
//   * NO XOR descramble (unlike bdm/owon-old's `b35tDecodeOld` — owonPlusTypeDecode reads the raw
//     bytes directly), NO constant sync header, NO checksum.
//   * Layout:
//       symbols      = data[1] << 8 | data[0]   (LE u16)  → function/scale/point packed bitfield
//                        function = (symbols >> 6) & 0x0f  (MODE_* 0..13)
//                        scale    = (symbols >> 3) & 0x07  (SI prefix index: p n µ m _ k M G)
//                        point    = symbols & 0x07         (decimal point pos; 6 = "U.L", 7 = "O.L")
//       mode         = data[3] << 8 | data[2]   (LE u16)  → flag bits (HOLD..VBAR)
//       measurement  = data[5] << 8 | data[4]   (LE u16)  → 4-digit value, bit15 = negative sign
//
//   How this differs from the other FFF0 families (used by `looksLikeOwonPlusFrame`):
//       * bdm        — 11 bytes, constant 0x1B 0x84 header, XOR-scrambled.
//       * owon-old   — 14 bytes, ASCII digits, terminated by CR/LF (0x0D 0x0A).
//       * voltcraft  — 15 bytes (dual display; reads data[12]/data[13] for the mode word).
//     owon-plus is the only one that is exactly 6 bytes, so length is the primary discriminator;
//     we additionally require a valid function nibble (0..13) to reject stray/garbled 6-byte runs.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

const FRAME_LEN = 6;

// SI prefix per `scale` (source literal `pre[]`). Index 4 ("") is the unscaled base.
const PREFIXES = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G'] as const;

// Highest valid function code (MODE_NCV == 13). 14/15 are unused → treated as not-owon-plus.
const MAX_FUNCTION = 13;

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

// The function nibble decoded straight from the raw frame, with no length check. Shared by
// decode and the frame sniffer.
function functionOf(bytes: Uint8Array): number {
  const symbols = (bytes[1] << 8) | bytes[0];
  return (symbols >> 6) & 0x0f;
}

/**
 * Decode one 6-byte owon-plus frame into a Reading. Pure + unit-tested. Degrades gracefully:
 * a short/garbled frame yields a blank reading rather than throwing.
 */
export function decodeOwonPlus(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < FRAME_LEN) return blank(ts);

  const symbols = (bytes[1] << 8) | bytes[0];
  const fn = (symbols >> 6) & 0x0f;
  const scale = (symbols >> 3) & 0x07;
  const point = symbols & 0x07;

  // Measurement: low 15 bits are the magnitude, bit15 is the negative sign. The source builds
  //   value   = (raw == (raw & 0x7fff)) ? raw : -1 * (raw & 0x7fff)
  //   tempData = value.ToString("0000")            // ≥4 *digits*, sign prepended separately
  //   tempData.Insert(tempData.Length - point, ".")
  // Ported faithfully, including the quirk that a "negative zero" (raw == 0x8000) renders as
  // "0000" with NO sign (because -1*0 == 0). The source also prepends "-" when data[0] == 45
  // (ASCII '-'); that branch effectively never fires for a real symbols low byte.
  const raw = (bytes[5] << 8) | bytes[4];
  let displayText: string;
  if (point === 6) {
    displayText = 'U.L';
  } else if (point === 7) {
    displayText = 'O.L';
  } else {
    const value = raw === (raw & 0x7fff) ? raw : -1 * (raw & 0x7fff);
    // C# ToString("0000"): pad the digit count to 4, sign (if any) sits in front of the digits.
    const neg = value < 0;
    let tempData = Math.abs(value).toString().padStart(4, '0');
    if (neg) tempData = `-${tempData}`;
    // Insert the decimal point `point` chars from the end (counting from the full string incl.
    // sign, exactly like C# String.Insert(Length - point, ...)).
    tempData =
      point > 0
        ? `${tempData.slice(0, tempData.length - point)}.${tempData.slice(tempData.length - point)}`
        : tempData;
    displayText = (bytes[0] === 45 ? '-' : '') + tempData;
  }

  // Unit symbol: SI prefix + base unit selected by the function code (source `MyGattCDataSymbol`).
  let displayUnit = PREFIXES[scale];
  if (fn === 8) displayUnit += '°C';
  else if (fn === 9) displayUnit += '°F';
  else if (fn === 0 || fn === 1 || fn === 10) displayUnit += 'V';
  else if (fn === 5) displayUnit += 'F';
  else if (fn === 7) displayUnit += '%';
  else if (fn === 4 || fn === 11) displayUnit += 'Ω';
  else if (fn === 6) displayUnit += 'Hz';
  else if (fn === 2 || fn === 3) displayUnit += 'A';

  const acdc: Reading['acdc'] = fn === 1 || fn === 3 ? 'AC' : fn === 0 || fn === 2 ? 'DC' : '';
  const diode = fn === 10;
  const cont = fn === 11;

  // Mode flags. The source renders `data[3]<<8|data[2]` as a 16-char binary string (MSB first)
  // and indexes it positionally: mode[0]=HOLD, [1]=REL, [2]=AUTO, [3]=Bat, [4]=MIN, [5]=MAX.
  // So string index i corresponds to the numeric bit (15 - i) of the word — NOT the LSB-first
  // numbering in the inline `enum` comment (which is the original Android source's, and which the
  // dispatched C# does not follow). We mirror the C# string-index behaviour, which is authoritative.
  const mode = ((bytes[3] << 8) | bytes[2]) & 0xffff;
  const strBit = (i: number): boolean => ((mode >> (15 - i)) & 1) === 1;
  const hold = strBit(0);
  const rel = strBit(1);
  const auto = strBit(2);
  const lowBattery = strBit(3);
  const min = strBit(4);
  const max = strBit(5);
  // Peak min/max are not surfaced by the dispatched owonPlusTypeDecode; left false.
  const peakMin = false;
  const peakMax = false;

  // hFE (fn 12) and NCV (fn 13) are special displays. NCV shows a strength bar of dashes (or "EF"
  // when no field), with no numeric value. hFE keeps the numeric text but carries no SI unit.
  if (fn === 13) {
    displayText = raw > 0 ? '-'.repeat(raw) : 'EF';
    displayUnit = '';
  } else if (fn === 12) {
    displayUnit = '';
  }

  const overload = point === 6 || point === 7; // "U.L" / "O.L"
  const numeric = !overload && fn !== 13 && NUMERIC.test(displayText);
  const displayValue = numeric ? Number(displayText) : null;

  const { base: baseUnit, exp } = unitInfo(displayUnit);
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  let func: string;
  if (fn === 13) func = 'NCV';
  else if (fn === 12) func = 'HFE';
  else func = functionFor(baseUnit, acdc, diode, cont);

  return {
    ts,
    function: func,
    displayText,
    displayValue,
    displayUnit,
    baseValue,
    baseUnit,
    overload,
    acdc,
    bargraph: 0, // VBAR (mode bit 13) is a presence flag only; no analog count in this frame
    flags: {
      max,
      min,
      hold,
      rel,
      auto,
      lowBattery,
      hvWarning: false, // not surfaced in the owon-plus frame
      peakMax,
      peakMin,
    },
  };
}

/**
 * Frame sniffer for auto-detect: does this raw notification plausibly match THE owon-plus
 * format (as opposed to bdm/owon-old/voltcraft, which also live on FFF0)?
 *
 * Distinguishing rule:
 *   * length === 6  — owon-plus is the only FFF0 family with 6-byte frames
 *                     (bdm 11, owon-old 14, voltcraft 15).
 *   * function nibble (bits 6..9 of the LE u16 data[0..1]) is a valid MODE_* code 0..13
 *     — rejects random 6-byte runs whose function field would be 14/15 (unused).
 */
export function looksLikeOwonPlusFrame(bytes: Uint8Array): boolean {
  if (bytes.length !== FRAME_LEN) return false;
  return functionOf(bytes) <= MAX_FUNCTION;
}

// Framer: owon-plus frames carry no sync word, no header and no checksum — there is nothing to
// resync against. In practice one BLE notification == one atomic 6-byte frame, so we simply
// buffer bytes and slice fixed 6-byte frames. This reassembles a frame split across two
// notifications and splits two frames coalesced into one. (Without a marker we deliberately do
// NOT attempt byte-level resync: a wrong alignment would still yield a "valid-looking" frame and
// emit garbage, so we trust the meter's framing instead.)
class OwonPlusFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]);
    const out: ParsedFrame[] = [];
    while (this.buf.length >= FRAME_LEN) {
      out.push({ kind: 'measurement', bytes: Uint8Array.from(this.buf.slice(0, FRAME_LEN)) });
      this.buf.splice(0, FRAME_LEN);
    }
    return out;
  }

  reset(): void {
    this.buf.length = 0;
  }
}

const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF4_NOTIFY = '0000fff4-0000-1000-8000-00805f9b34fb';
const FFF3_WRITE = '0000fff3-0000-1000-8000-00805f9b34fb';

export const owonPlus: Driver = {
  id: 'owon-plus',
  label: 'Owon (B35T+/B41T+/OW18E/CM2100B)',
  verification: 'ported-unverified',
  // These meters commonly advertise names like "BDM"/"OWON"; FFF0 is shared with bdm/owon-old/
  // voltcraft, so `match` only claims the service and the orchestrator disambiguates by frame
  // shape via `looksLikeOwonPlusFrame`.
  namePrefixes: ['OWON', 'BDM'],
  gatt: { service: FFF0_SERVICE, notify: FFF4_NOTIFY, write: [FFF3_WRITE] },

  // FFF0 is shared; return true when the service (or a known name prefix) is present and let the
  // orchestrator resolve the collision using the frame sniffer.
  match: (ctx) =>
    (ctx.services?.includes(FFF0_SERVICE) ?? false) ||
    (ctx.name?.startsWith('OWON') ?? false) ||
    (ctx.name?.startsWith('BDM') ?? false),

  createFramer: () => new OwonPlusFramer(),

  // No handshake: subscribing to notifications is enough — the meter streams immediately.
  async handshake() {
    /* nothing to do */
  },

  // No request/response keep-alive in this family.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeOwonPlus(bytes, ts),

  // The source documents interactive commands (write a uint16 to FFF3, e.g. 0x0003 = Backlight),
  // but the on-wire byte order is unverified, so we omit `controls` rather than ship a guess.

  sniff: looksLikeOwonPlusFrame,
};
