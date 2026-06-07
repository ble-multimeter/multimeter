// Voltcraft driver — the Voltcraft VC800/VC900 BLE multimeter family (App DevType 5 in the
// source Windows app; GATT service 0xFFF0, shared with bdm/owon). Reverse-engineered by the
// upstream project with help from user 'FireBird3314'.
//
// Ported from webspiderteam/Bluetooth-DMM-For-Windows `Utilities.cs` `VoltcraftDecode` (the
// function dispatched for `isBDM == 5` in `ParseGattValue`). Verified against the synthetic
// frames in `TestData(dev_type == 9, …)` — but NOT bench-tested on physical hardware, so
// `verification` is 'ported-unverified' (PLAN §6 "Verification honesty").
//
// Frame format — 15 bytes, no scrambling, no AB-CD sync, no checksum (the meter streams raw
// notifications). One notification == one frame. Layout (FireBird3314's annotations):
//   * bytes[0..1]  little-endian "symbols" word for the PRIMARY display:
//       bits 0..2  = decimal-point position (0..4 places; 6 = "UL", 7 = "OL")
//       bits 3..5  = unit prefix index (p n µ m _ k M G)
//       bits 6..10 = function/display-mode code (see FUNCTION_UNIT)
//       bit  12    = secondary display active
//   * byte [2]     = 0xF0 marker
//   * bytes[3..4]  = little-endian primary count (raw measurement, 0..65535)
//   * byte [5]     bit7 = primary negative
//   * bytes[6..7]  = little-endian "symbols" word for the SECONDARY display (same layout)
//   * byte [8]     = 0xF0 marker
//   * bytes[9..10] = little-endian secondary count
//   * byte [11]    bit7 = secondary negative
//   * bytes[12..13] = little-endian "mode" flags word (HOLD/REL/AUTO/LOWBATT/MIN/MAX)
//   * byte [14]    = power-measurement flags (LoZ / PF / AC / DC / USB power) — not surfaced
//
// We only model the PRIMARY display in the Reading (the engine has no secondary-display field);
// the secondary display is parsed/skipped exactly as the source does so framing stays correct.

import { unitInfo, type Reading } from '../types';
import type { Driver, DriverFramer, ParsedFrame } from './types';

const FRAME_LEN = 15;
// The source accepts any frame with `data.Length > 14`; we slice fixed 15-byte frames.
const F0_MARK = 0xf0; // bytes[2] and bytes[8] are constant 0xF0 markers — used to sync the stream.

// Unit prefix table (source `pre`): scale index 0..7. Index 4 ("") is the unprefixed unit.
const PREFIX = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G'] as const;

// Decimal-point sentinel values (source): bits 0..2 of the symbols word.
const POINT_UL = 6; // underload  → " U.L "
const POINT_OL = 7; // overload   → " O.L "

// Function/display-mode code (bits 6..10) → base unit string. Mirrors the source's chain of
// `((function == n) ? "X" : "")` concatenations. Codes with no unit (diode/continuity/NCV/hFE)
// map to '' and are distinguished via `functionFor`.
const FUNCTION_UNIT: Record<number, string> = {
  0: 'V', // Voltage DC
  1: 'V', // Voltage AC
  2: 'A', // Current DC
  3: 'A', // Current AC
  4: 'Ω', // Resistance
  5: 'F', // Capacitance
  6: 'Hz', // Frequency
  7: '%', // Duty cycle
  8: '°C', // Temperature C
  9: '°F', // Temperature F
  10: 'V', // Diode (volts)
  11: 'Ω', // Continuity (ohms)
  14: 'W', // Power [W]
  15: 'VA', // Power [VA]
  16: 'PF', // Power factor
  18: 'Ah', // Energy [Ah]
  19: '', // Time [hh:mm:ss] (no unit on primary)
  20: 'Wh', // Energy [Wh]
  21: 'V', // Voltage [V]
  22: 'A', // Current [A]
};

// AC / DC classification by function code (source: AC for {1,3}, DC for {0,2}).
function acdcFor(fn: number): Reading['acdc'] {
  if (fn === 1 || fn === 3) return 'AC';
  if (fn === 0 || fn === 2) return 'DC';
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
// (mV↔V, kΩ↔MΩ) stay one chart segment while a real mode change splits (PLAN §3.4). Same
// contract as bdm.ts `functionFor`.
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
    case 'W':
      return 'W';
    case 'VA':
      return 'VA';
    case 'PF':
      return 'PF';
    case 'Ah':
      return 'Ah';
    case 'Wh':
      return 'Wh';
    default:
      return baseUnit || '?';
  }
}

const NUMERIC = /^-?\d*\.?\d+$/;

// Format the raw count into the LCD string the source builds: zero-pad to 5 digits, then insert
// a decimal point `point` places from the right (point 0 → no point). Source uses
// `measurement.ToString("00000").Insert(len - point, ".")`.
function formatCount(count: number, point: number, negative: boolean): string {
  const padded = count.toString().padStart(5, '0');
  const withPoint =
    point > 0
      ? padded.slice(0, padded.length - point) + '.' + padded.slice(padded.length - point)
      : padded;
  return (negative ? '-' : '') + withPoint;
}

/**
 * Decode one 15-byte Voltcraft frame into a Reading. Pure + unit-tested. Degrades gracefully:
 * a short/garbled frame yields a blank reading; an unknown function code shows a '?' unit
 * rather than throwing. Only the primary display is surfaced.
 */
export function decodeVoltcraft(bytes: Uint8Array, ts = 0): Reading {
  if (bytes.length < FRAME_LEN) return blank(ts);

  // Primary "symbols" word (little-endian) → function / prefix / decimal-point fields.
  const symbols = (bytes[1] << 8) | bytes[0];
  const fn = (symbols >> 6) & 0x1f;
  const scale = (symbols >> 3) & 0x07;
  const point = symbols & 0x07;

  const negative = (bytes[5] & 0x80) > 0;
  const count = (bytes[4] << 8) | bytes[3];

  // Overload / underload are signalled by the decimal-point field, not by a digit pattern.
  const overload = point === POINT_OL;
  const underload = point === POINT_UL;

  // Display text. The source emits " O.L " / " U.L " (with spaces) for over/under-load; we trim
  // to "O.L"/"U.L" so displayText stays a tidy LCD string like the other drivers.
  let displayText: string;
  if (overload) displayText = 'O.L';
  else if (underload) displayText = 'U.L';
  else displayText = formatCount(count, point, negative);

  const diode = fn === 10;
  const cont = fn === 11;
  const acdc = acdcFor(fn);

  // Unit = prefix + base. Diode/continuity/NCV/hFE carry no base unit (their function is
  // expressed via `functionFor`). hFE (fn 12) and NCV (fn 13) override the display below.
  const baseUnitRaw = FUNCTION_UNIT[fn] ?? '';
  let displayUnit = baseUnitRaw === '' ? '' : PREFIX[scale] + baseUnitRaw;

  // hFE (fn 12) shows a bare gain; NCV (fn 13) shows an "EF" / "-" strength bar — neither is a
  // numeric SI quantity, so they get no unit (mirrors the source's MyGattCDataFunc handling).
  if (fn === 12) {
    displayUnit = '';
  } else if (fn === 13) {
    displayText = count > 0 ? '-'.repeat(count) : 'EF';
    displayUnit = '';
  }

  const numeric = !overload && !underload && NUMERIC.test(displayText);
  const displayValue = numeric ? Number(displayText) : null;

  const { base: baseUnit, exp } = unitInfo(displayUnit);
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  // Mode flags word (little-endian): the source reads it MSB-first as a 16-bit binary string and
  // indexes mode[0..5]. mode[0] is the top bit of the high byte (bytes[13]). Translating those
  // string indices to bit tests: mode[0]=bit15, mode[1]=bit14, … mode[5]=bit10.
  const mode = (bytes[13] << 8) | bytes[12];
  const bit = (n: number): boolean => ((mode >> n) & 1) === 1;
  const hold = bit(15); // mode[0]
  const rel = bit(14); // mode[1]
  const auto = bit(13); // mode[2]
  const lowBattery = bit(12); // mode[3]
  const min = bit(11); // mode[4]
  const max = bit(10); // mode[5]

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
    bargraph: 0, // no analog bargraph in the Voltcraft frame
    flags: {
      max,
      min,
      hold,
      rel,
      auto,
      lowBattery,
      hvWarning: false, // not surfaced in the Voltcraft frame
      peakMax: false,
      peakMin: false,
    },
  };
}

/**
 * Sniffer that distinguishes a Voltcraft frame from the other families sharing GATT 0xFFF0
 * (bdm = 11 bytes, owon = 6 bytes). The discriminator is LENGTH + the two fixed 0xF0 markers:
 * a Voltcraft frame is 15 bytes (the source requires `data.Length > 14`) and carries 0xF0 at
 * bytes[2] and bytes[8] (the primary/secondary "F0" separators). bdm's 11-byte frame and the
 * shorter owon frames can't satisfy the length test, and the 0xF0 markers reject coincidental
 * 15-byte payloads. The orchestrator uses this to resolve the 0xFFF0 collision.
 */
export function looksLikeVoltcraftFrame(bytes: Uint8Array): boolean {
  return bytes.length >= FRAME_LEN && bytes[2] === F0_MARK && bytes[8] === F0_MARK;
}

// Framer: Voltcraft frames carry no sync word or checksum, but bytes[2] and bytes[8] are the
// constant 0xF0 markers, so we sync on a 15-byte window whose markers line up and slice fixed
// 15-byte frames. Tolerates split/coalesced notifications like the other drivers, even though in
// practice one notification == one frame.
class VoltcraftFramer implements DriverFramer {
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

  // Advance until the buffer head is a plausible frame start: bytes[2] and bytes[8] are 0xF0.
  // We can only confirm once ≥9 bytes are buffered; below that, keep what we have.
  private sync(): void {
    while (this.buf.length >= 9) {
      if (this.buf[2] === F0_MARK && this.buf[8] === F0_MARK) break;
      this.buf.shift();
    }
  }
}

const FFF0_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF4_NOTIFY = '0000fff4-0000-1000-8000-00805f9b34fb';
const FFF3_WRITE = '0000fff3-0000-1000-8000-00805f9b34fb';

export const voltcraft: Driver = {
  id: 'voltcraft',
  label: 'Voltcraft VC800/VC900',
  verification: 'ported-unverified',
  // These meters advertise inconsistent names; discovery leans on the service-UUID filter
  // (transport offers 0xFFF0). 0xFFF0 is SHARED with bdm/owon, so `match` returns true on the
  // service and the orchestrator disambiguates by sniffing the first frame
  // (`looksLikeVoltcraftFrame`).
  namePrefixes: ['VC', 'Voltcraft'],
  gatt: { service: FFF0_SERVICE, notify: FFF4_NOTIFY, write: [FFF3_WRITE] },

  match: (ctx) =>
    (ctx.services?.includes(FFF0_SERVICE) ?? false) ||
    (ctx.name?.startsWith('VC') ?? false) ||
    (ctx.name?.startsWith('Voltcraft') ?? false),

  createFramer: () => new VoltcraftFramer(),

  // No handshake: subscribing to notifications is enough — the meter streams immediately.
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
