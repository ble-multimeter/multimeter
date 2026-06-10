// Voltcraft driver — the Voltcraft VC900-series (a.k.a. R10W / VC915/VC925) BLE multimeter. These
// are OWON "iMeter" rebadges (Conrad house brand); the official "Voltcraft series800" app is an
// OWON-built Flutter binary (`com.voltcraft.series800` / in-app `com.owon.imeter`). GATT service
// 0xFFF0, shared with bdm/owon-plus/owon-old.
//
// LIVE-VERIFIED PROTOCOL. The frame layout below was confirmed byte-for-byte against the official
// Voltcraft app using a BLE emulator as a decode oracle: arbitrary 15-byte frames were streamed to
// the app and the on-screen value/unit/decimals/sign/over-range/annunciators were read back (a
// "bit-sweep" pinned every state bit). This is an APP-verified bench test, not yet a physical-meter
// test, so `verification` is 'app-verified'. See docs/protocols/voltcraft.md.
//
// This SUPERSEDES the earlier port from `webspiderteam/Bluetooth-DMM-For-Windows` `VoltcraftDecode`
// (FireBird3314's annotations), which decoded a *different* (third-party Windows-app) protocol and
// was wrong in several ways: it read LE-16 words off a `0xF0`-marked dual-display layout, used an
// even-keyed / power-extended function table, and read the flag word MSB-first. The corrections,
// all confirmed live:
//   * the frame is five 24-bit LITTLE-endian words at byte offsets 0/3/6/9/12 — no markers, no
//     checksum (the old `0xF0` markers at bytes[2]/[8] do not exist);
//   * the state word is a straight LSB-numbered bitmask with HOLD=bit0 (was read MSB-first, the
//     headline bug — same class of error fixed in owon-plus);
//   * the gear/function table is CONSECUTIVE codes 0..13 (0=V DC … 13=NCV);
//   * the dp field IS the decimal-place count (value = count / 10**decimals);
//   * OL/UL/HI come from the value word's over-range selector; sign from value-word bit23.
//
// The VC800 / R2W meters use a SEPARATE 6-byte protocol and are NOT handled by this driver (future
// work) — this driver decodes only the R10W 15-byte frame.
//
// R10W FRAME — 15 bytes, NO marker bytes, NO checksum, free-streamed on FFF4 (one notification ==
// one frame). Each field is a 24-bit LITTLE-endian word `b[i] | b[i+1]<<8 | b[i+2]<<16`:
//   bytes[0..2]   PRIMARY gear/symbols word
//   bytes[3..5]   PRIMARY value word
//   bytes[6..8]   SECONDARY gear/symbols word (only present when primary bit12 is set)
//   bytes[9..11]  SECONDARY value word
//   bytes[12..14] STATE / annunciator bitmask word
// We surface only the PRIMARY display (the engine has no secondary-display field). The secondary
// block (bytes[6..11]) is ignored; the real meter sends it zero with bit12 cleared.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

const FRAME_LEN = 15;

// SI-prefix table, gear-word bits 3..5 (`PREFIX[scale]`). Index 4 ("") is the unprefixed unit.
// All eight codes are expressible (confirmed live). Mirrors owon-plus's `PREFIXES`.
const PREFIX = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G'] as const;

// Function / gear table — gear-word bits 6..10, CONSECUTIVE codes 0..13 (confirmed live). Maps the
// gear code to its base unit; AC/DC and the diode/cont/hFE/NCV specials are derived below.
const FUNCTION_UNIT: Record<number, string> = {
  0: 'V', // V DC
  1: 'V', // V AC
  2: 'A', // A DC
  3: 'A', // A AC
  4: 'Ω', // resistance
  5: 'F', // capacitance
  6: 'Hz', // frequency
  7: '%', // duty cycle
  8: '°C', // temperature (Celsius)
  9: '°F', // temperature (Fahrenheit)
  10: 'V', // diode (volts)
  11: 'Ω', // continuity (ohms)
  12: '', // hFE (bare transistor gain)
  13: '', // NCV (strength bar)
};

const MAX_FUNCTION = 13; // highest valid gear code; >13 (NCV) is treated as not-voltcraft

// Value-word over-range selector (bits 20..22). 0 = normal numeric.
const OVERRANGE_OL = 1; // "OL" over-load
const OVERRANGE_UL = 2; // "UL" under-load
const OVERRANGE_HI = 3; // "HI"

// State-word annunciator bit positions (LSB index into the 24-bit LE state word, bytes 12..14).
// Confirmed by live bit-sweep: a straight LSB-numbered bitmask starting at bit0 (HOLD). Only the
// bits the Reading surfaces are named here; the full set is HOLD=0, REL=1, AUTO=2, Bat=3, MIN=4,
// MAX=5, AVG=6, RMR=7, Loz=8, LPF=9, Peak=10, Cosφ=12, AC=13, DC=14, USB=15, Err=16, INRUSH=17,
// OSC=18 (see docs/protocols/voltcraft.md).
const FLAG_HOLD = 0;
const FLAG_REL = 1;
const FLAG_AUTO = 2;
const FLAG_BAT = 3;
const FLAG_MIN = 4;
const FLAG_MAX = 5;

// AC / DC classification by gear code (V/A only). The gear code is authoritative for the function,
// so it also drives acdc; the AC/DC state bits (13/14) are redundant and not used here.
function acdcFor(gear: number): Reading['acdc'] {
  if (gear === 1 || gear === 3) return 'AC';
  if (gear === 0 || gear === 2) return 'DC';
  return '';
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

// Map a displayed unit + AC/DC + mode to a range-independent function key, so range changes
// (mV↔V, kΩ↔MΩ) stay one chart segment while a real mode change splits (PLAN §3.4). Same contract
// as bdm.ts / owon-plus.ts `functionFor`.
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

// Read a 24-bit little-endian word at byte offset `i`.
function le24(bytes: Uint8Array, i: number): number {
  return bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16);
}

// The gear code decoded straight from the raw frame (no length check). Shared by decode + sniffer.
function gearOf(bytes: Uint8Array): number {
  return (le24(bytes, 0) >> 6) & 0x1f;
}

// Format `count` with a fixed number of decimal places (value = count / 10**decimals), prepending
// '-' when negative. E.g. count 4200, decimals 3 → "4.200"; count 42, decimals 1 → "4.2".
function formatCount(count: number, decimals: number, negative: boolean): string {
  const value = count / 10 ** decimals;
  const text = value.toFixed(decimals);
  return negative && value !== 0 ? `-${text}` : text;
}

/**
 * Decode one 15-byte R10W (VC900-series) frame into a Reading. Pure + unit-tested. Degrades
 * gracefully: a short/garbled frame yields a blank reading; an unknown gear code shows a '?' unit
 * rather than throwing. Only the primary display is surfaced.
 */
export function decodeVoltcraft(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < FRAME_LEN) return blank(ts);

  // Gear word (bytes 0..2, 24-bit LE) → decimals / prefix / gear-function fields.
  const gearWord = le24(bytes, 0);
  const decimals = gearWord & 0x07;
  const scale = (gearWord >> 3) & 0x07;
  const gear = (gearWord >> 6) & 0x1f;

  // Value word (bytes 3..5, 24-bit LE): magnitude, over-range selector, sign (bit23 == bit7 of b5).
  const valueWord = le24(bytes, 3);
  const count = valueWord & 0x7ffff;
  const overrange = (valueWord >> 20) & 0x07;
  const negative = (bytes[5]! & 0x80) > 0;

  const overload = overrange === OVERRANGE_OL;
  const underload = overrange === OVERRANGE_UL;
  const hi = overrange === OVERRANGE_HI;

  const diode = gear === 10;
  const cont = gear === 11;
  const acdc = acdcFor(gear);

  // Unit = SI prefix + base. Diode/continuity carry their natural unit (V/Ω) but report DIODE/CONT
  // as the function key; hFE/NCV carry no base unit.
  const baseUnitRaw = FUNCTION_UNIT[gear] ?? '';
  let displayUnit = baseUnitRaw === '' ? '' : PREFIX[scale]! + baseUnitRaw;

  // Display text: over-range sentinels win, otherwise the formatted count.
  let displayText: string;
  if (overload) displayText = 'OL';
  else if (underload) displayText = 'UL';
  else if (hi) displayText = 'HI';
  else displayText = formatCount(count, decimals, negative);

  // hFE (gear 12) shows a bare gain; NCV (gear 13) shows an "EF" / dash strength bar — neither is a
  // numeric SI quantity, so they get no unit.
  if (gear === 12) {
    displayUnit = '';
  } else if (gear === 13) {
    displayText = count > 0 ? '-'.repeat(count) : 'EF';
    displayUnit = '';
  }

  const numeric = !overload && !underload && !hi && gear !== 13 && NUMERIC.test(displayText);
  const displayValue = numeric ? Number(displayText) : null;

  const { base: baseUnit, exp } = unitInfo(displayUnit);
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  // State word (bytes 12..14, 24-bit LE) — a straight LSB-numbered annunciator bitmask. HOLD=bit0.
  const state = le24(bytes, 12);
  const bit = (n: number): boolean => ((state >> n) & 1) === 1;
  const hold = bit(FLAG_HOLD);
  const rel = bit(FLAG_REL);
  const auto = bit(FLAG_AUTO);
  const lowBattery = bit(FLAG_BAT);
  const min = bit(FLAG_MIN);
  const max = bit(FLAG_MAX);

  let func: string;
  if (gear === 13) func = 'NCV';
  else if (gear === 12) func = 'HFE';
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
    bargraph: 0, // no analog bargraph count in the R10W frame
    flags: {
      max,
      min,
      hold,
      rel,
      auto,
      lowBattery,
      hvWarning: false, // not surfaced in the R10W frame
      peakMax: false, // Peak is a single annunciator bit (bit10), not split max/min
      peakMin: false,
    },
  };
}

/**
 * Frame sniffer for auto-detect: does this raw notification plausibly match THE voltcraft R10W
 * format (vs bdm/owon-plus/owon-old, which also live on FFF0)?
 *
 * Distinguishing rule:
 *   * length >= 15 — voltcraft R10W is the only FFF0 family with 15-byte frames (bdm 11,
 *     owon-plus 6, owon-old 14).
 *   * gear code (gear-word bits 6..10) is a valid 0..13 — rejects stray 15-byte runs whose gear
 *     field would be 14..31 (unused). There are no marker/checksum bytes to test.
 */
export function looksLikeVoltcraftFrame(bytes: Uint8Array): boolean {
  if (bytes.length < FRAME_LEN) return false;
  return gearOf(bytes) <= MAX_FUNCTION;
}

// Framer: R10W frames carry no sync word, no header and no checksum — there is nothing to resync
// against. In practice one BLE notification == one atomic 15-byte frame, so we buffer bytes and
// slice fixed 15-byte frames. This reassembles a frame split across two notifications and splits
// two frames coalesced into one. (Without a marker we deliberately do NOT attempt byte-level
// resync: a wrong alignment would still yield a "valid-looking" frame, so we trust the meter's
// framing instead — same approach as owon-plus.)
class VoltcraftFramer implements DriverFramer {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);
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

export const voltcraft: Driver = {
  id: 'voltcraft',
  label: 'Voltcraft VC900 (R10W)',
  verification: 'app-verified',
  // These meters advertise inconsistent names; discovery leans on the service-UUID filter
  // (transport offers 0xFFF0). 0xFFF0 is SHARED with bdm/owon, so `match` returns true on the
  // service and the orchestrator disambiguates by sniffing the first frame
  // (`looksLikeVoltcraftFrame`).
  namePrefixes: ['VC', 'Voltcraft'],
  gatt: { service: FFF0_SERVICE, notify: FFF4_NOTIFY, write: [FFF3_WRITE] },

  match: ctx =>
    (ctx.services?.includes(FFF0_SERVICE) ?? false) ||
    (ctx.name?.startsWith('VC') ?? false) ||
    (ctx.name?.startsWith('Voltcraft') ?? false),

  createFramer: () => new VoltcraftFramer(),

  // No handshake: subscribing to notifications is enough — the meter free-streams immediately.
  // (The app's FFF1 MD5 "anti-counterfeit" exchange is an app→meter gate, not needed to receive.)
  async handshake() {
    /* nothing to do */
  },

  // No request/response keep-alive in this family.
  onRequest() {
    /* nothing to do */
  },

  decode: (bytes, ts) => decodeVoltcraft(bytes, ts),

  sniff: looksLikeVoltcraftFrame,
};
