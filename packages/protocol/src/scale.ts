// Analog-gauge scaling for a Reading — the math behind the meter card's dial view. Pure + tested,
// no DOM. The dial is an at-a-glance companion to the digits, so the priority is "honor the range
// and stay stable", not lab-grade deflection.
//
// Range-honoring without a per-driver range table: a DMM's decimal point moves with the range
// ("4.523" on the 6 V range, "45.23" on 60 V), so the integer-digit count already encodes the
// decade. We scale to that decade. Caveat: 6000-count ranges read to ~60 % of full at their max
// (6 V sits at the "6" of a 0–10 sweep) — fine for a glance; the digits carry the exact value. A
// per-driver range table or the meter's own `bargraph` could make it exact later.

import type { Reading } from './types';

/** Gauge full-scale for a reading: the decade above its integer part ("0"→1, "4"→10, "45"→100). */
export function gaugeFullScale(r: Reading): number {
  const v = r.displayValue;
  if (v == null || !Number.isFinite(v)) return 1;
  const intDigits = Math.floor(Math.abs(v)).toString(); // "4", "45", "0", …
  return intDigits === '0' ? 1 : 10 ** intDigits.length;
}

/**
 * Needle position in [0, 1] for a reading, or null when there's nothing to point at (NCV / blank /
 * non-numeric). Overload pins the needle to full-scale (the meter is past its range).
 */
export function gaugeFraction(r: Reading): number | null {
  if (r.overload) return 1;
  const v = r.displayValue;
  if (v == null || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, Math.abs(v) / gaugeFullScale(r)));
}
