// Demo mode: synthesize a believable measurement stream so the UI can be driven (and
// screenshotted) without a real meter. Activated with `?demo` on the URL — useMeter then
// skips Web Bluetooth entirely and feeds these Readings on a timer. Pure + side-effect-free
// here; the timer lives in the hook. Not part of the normal connect path.

import { ACDC_FUNCTIONS, RANGE_UNITS, unitInfo, type Reading } from '@ble-multimeter/protocol';

export function isDemoMode(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo');
}

// A gently wandering DC voltage — the kind of trace you'd see probing a lightly loaded
// supply. Slow drift + a small ripple + a touch of noise, so the chart looks alive and the
// min/max/avg stats are meaningful. `tSec` is seconds since the stream started; deterministic
// in shape so successive frames form a smooth, loopable curve (good for GIFs).
export function demoVolts(tSec: number): number {
  const drift = 0.35 * Math.sin(tSec / 8); // ~50s slow swing
  const ripple = 0.08 * Math.sin(tSec / 1.3); // faster wobble
  const noise = (Math.random() - 0.5) * 0.008; // ±4 mV jitter
  return 4.5 + drift + ripple + noise;
}

// Build a full Reading for a DCV measurement of `volts`, matching what decode() would
// produce for the equivalent frame (DCV → "V", no metric prefix, so baseValue == value).
export function demoReading(tSec: number, ts: number): Reading {
  const fn = 'DCV';
  const value = demoVolts(tSec);
  const displayUnit = RANGE_UNITS[fn][0]; // 'V'
  const { base: baseUnit, exp } = unitInfo(displayUnit);
  return {
    ts,
    function: fn,
    displayText: value.toFixed(3), // 6000-count display on the 6 V range → 3 decimals
    displayValue: value,
    displayUnit,
    baseValue: value * 10 ** exp,
    baseUnit,
    overload: false,
    acdc: ACDC_FUNCTIONS.has(fn) ? 'DC' : '',
    bargraph: Math.round((value / 6) * 60), // analog bar ~ value over the 6 V range
    flags: {
      max: false,
      min: false,
      hold: false,
      rel: false,
      auto: true, // autoranging
      lowBattery: false,
      hvWarning: false,
      peakMax: false,
      peakMin: false,
    },
  };
}
