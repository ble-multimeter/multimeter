// Pure decoder: a validated 19-byte measurement frame → Reading (PROTOCOL §3-4).
// No BLE, no React — runs in Node tests against captured fixtures. Never throws:
// unknown function/range codes fall back to the raw LCD string + "?" unit so the
// hero readout always mirrors the meter, even before the tables are complete.

import { FUNCTIONS, RANGE_UNITS, ACDC_FUNCTIONS, unitInfo, type Reading } from './types';

const ascii = new TextDecoder('ascii');

// Overload is structural, not a fixed string: the dot floats with the range
// ("OL.", "O.L", ".OL", "OL", "-OL"). Trim, drop the dot, allow a leading '-'.
const OVERLOAD = /^-?OL$/;

export function decode(bytes: Uint8Array, ts = 0): Reading {
  // Guard, don't trust: the framing layer only hands us validated 19-byte frames,
  // but if something slips through we degrade rather than throw.
  if (bytes.length !== 19 || bytes[0] !== 0xab || bytes[1] !== 0xcd) {
    return blank(ts);
  }

  const fnIndex = bytes[3] & 0x7f; // bit7 is unused on the UT60BT; mask it off
  const fnName = FUNCTIONS[fnIndex] ?? `#${fnIndex}`;
  const rangeIndex = bytes[4] - 0x30;

  const displayText = ascii.decode(bytes.subarray(5, 12)).trim();

  const ranges = RANGE_UNITS[fnName];
  const displayUnit = ranges ? (ranges[rangeIndex] ?? ranges[0]) : '?';
  const { base: baseUnit, exp } = unitInfo(displayUnit);

  const overload = OVERLOAD.test(displayText.replace('.', ''));
  let displayValue: number | null = null;
  if (!overload && displayText !== '') {
    const n = Number(displayText); // Number('') is 0, so the guard above matters
    displayValue = Number.isNaN(n) ? null : n;
  }
  const baseValue = displayValue === null ? null : displayValue * 10 ** exp;

  const a = bytes[14];
  const b = bytes[15];
  const c = bytes[16];

  return {
    ts,
    function: fnName,
    displayText,
    displayValue,
    displayUnit,
    baseValue,
    baseUnit,
    overload,
    acdc: ACDC_FUNCTIONS.has(fnName) ? (c & 0x08 ? 'AC' : 'DC') : '',
    bargraph: bytes[12] * 10 + bytes[13],
    flags: {
      max: !!(a & 0x08),
      min: !!(a & 0x04),
      hold: !!(a & 0x02),
      rel: !!(a & 0x01),
      auto: !(b & 0x04), // flags B bit2 = autorange-OFF; auto = bit clear
      lowBattery: !!(b & 0x02),
      hvWarning: !!(b & 0x01),
      peakMax: !!(c & 0x04),
      peakMin: !!(c & 0x02),
    },
  };
}

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
      max: false, min: false, hold: false, rel: false, auto: false,
      lowBattery: false, hvWarning: false, peakMax: false, peakMin: false,
    },
  };
}
