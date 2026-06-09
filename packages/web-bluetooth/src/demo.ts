// Demo mode: synthesize a believable measurement stream so the UI can be driven (and
// screenshotted) without a real meter. Activated with `?demo` on the URL — MeterSession then
// skips Web Bluetooth entirely and feeds these Readings on a timer. Pure + side-effect-free
// here; the timer lives in the session. Not part of the normal connect path.
//
// Phase 7: a demo meter follows a *profile* (a DCV source, a DCA source, …) so several demo
// meters can synthesize different quantities at once — the V source + I source behind the
// `?demo=power` two-device scenario. `demoReading(tSec, ts)` keeps the old single-DCV default.

import { ACDC_FUNCTIONS, RANGE_UNITS, unitInfo, type Reading } from '@ble-multimeter/protocol';

// What flavour of demo the URL asks for. `single` = one DCV meter (simple screenshots);
// `power` = a V source + an I source + a P=V×I derived channel (the headline scenario).
export type DemoKind = 'none' | 'single' | 'power';

export function demoKind(): DemoKind {
  if (typeof window === 'undefined') return 'none';
  const params = new URLSearchParams(window.location.search);
  if (!params.has('demo')) return 'none';
  return params.get('demo') === 'power' ? 'power' : 'single';
}

export function isDemoMode(): boolean {
  return demoKind() !== 'none';
}

// A demo source: a named measurement function + a deterministic value curve. The curve is
// shape-deterministic in `tSec` (seconds since the stream started) so screenshots/GIFs loop
// cleanly; a touch of `Math.random` jitter keeps the trace alive without breaking the shape.
export interface DemoProfile {
  id: string; // stable id used when wiring up the power scenario
  role: string; // human role label ("V source", "I source") for the card + derived builder
  deviceName: string; // what the card's connection chip shows
  fn: string; // measurement function code (must exist in RANGE_UNITS)
  value: (tSec: number) => number; // the displayed value over time
  fullScale: number; // nominal range full-scale, for the analog-bar count
  decimals: number; // displayText precision (matches the meter's count)
}

// A gently wandering DC voltage — the kind of trace you'd see probing a lightly loaded supply.
// Slow drift + a small ripple + a touch of noise (PLAN demo curve, now factored into a profile).
function wanderVolts(tSec: number): number {
  const drift = 0.35 * Math.sin(tSec / 8); // ~50s slow swing
  const ripple = 0.08 * Math.sin(tSec / 1.3); // faster wobble
  const noise = (Math.random() - 0.5) * 0.008; // ±4 mV jitter
  return 4.5 + drift + ripple + noise;
}

// A wandering DC current on a *different* period than the voltage, so the derived P=V×I is
// interesting (the two don't move in lockstep). ~1.5 A nominal, ~37s/~2.1s periods.
function wanderAmps(tSec: number): number {
  const drift = 0.45 * Math.sin(tSec / 6 + 1.1);
  const ripple = 0.05 * Math.sin(tSec / 0.9);
  const noise = (Math.random() - 0.5) * 0.004;
  return 1.5 + drift + ripple + noise;
}

export const DEMO_PROFILES: Record<'volts' | 'amps', DemoProfile> = {
  volts: {
    id: 'demo-v',
    role: 'V source',
    deviceName: 'UT60BT (demo V)',
    fn: 'DCV',
    value: wanderVolts,
    fullScale: 6, // 6 V range
    decimals: 3,
  },
  amps: {
    id: 'demo-a',
    role: 'I source',
    deviceName: 'UT60BT (demo A)',
    fn: 'DCA',
    value: wanderAmps,
    fullScale: 6, // 6 A range
    decimals: 3,
  },
};

// The legacy single-DCV demo, kept as the default so a bare `?demo` is byte-for-byte unchanged
// (same device name "UT60BT (demo)"). The named `volts` profile carries the multi-meter label
// ("UT60BT (demo V)") so the power scenario's two cards read distinctly.
export const DEFAULT_DEMO_PROFILE: DemoProfile = {
  ...DEMO_PROFILES.volts,
  deviceName: 'UT60BT (demo)',
};

// Build a full Reading for `profile` at `tSec`, matching what decode() would produce for the
// equivalent frame (no metric prefix on the V/A ranges, so baseValue == displayValue).
export function demoReadingFor(profile: DemoProfile, tSec: number, ts: number): Reading {
  const fn = profile.fn;
  const value = profile.value(tSec);
  const displayUnit = RANGE_UNITS[fn]![0]!; // 'V' / 'A'
  const { base: baseUnit, exp } = unitInfo(displayUnit);
  return {
    ts,
    function: fn,
    displayText: value.toFixed(profile.decimals),
    displayValue: value,
    displayUnit,
    baseValue: value * 10 ** exp,
    baseUnit,
    overload: false,
    acdc: ACDC_FUNCTIONS.has(fn) ? 'DC' : '',
    bargraph: Math.round((value / profile.fullScale) * 60),
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

// Back-compat helper: the original single-DCV demo reading.
export function demoReading(tSec: number, ts: number): Reading {
  return demoReadingFor(DEFAULT_DEMO_PROFILE, tSec, ts);
}

export function demoVolts(tSec: number): number {
  return wanderVolts(tSec);
}
