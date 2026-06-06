// Downsample a chart series to ~maxPoints for rendering (PLAN §3.3). This is a
// RENDER concern only — CSV export always reads full-resolution Readings from IndexedDB
// and must never be bounded by this. Pure, tested.
//
// Strategy: min/max bucketing. Split the series into buckets and, per bucket, keep the
// lowest- and highest-value sample. Unlike LTTB or naive nth-sample picking, this never
// drops a transient spike — which is exactly the "intermittent fault that flickers for
// half a second" case the tool exists for (PLAN §1). Buckets that are entirely null
// (OL / non-numeric) emit a single null so the chart still draws a gap there.

import type { Sample } from '../ble/types';

export function decimate(samples: Sample[], maxPoints: number): Sample[] {
  const cap = Math.max(4, maxPoints);
  if (samples.length <= cap) return samples.slice();

  const buckets = Math.floor(cap / 2); // each bucket emits up to 2 points
  const n = samples.length;
  const out: Sample[] = [];

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.floor(((b + 1) * n) / buckets);

    let lo: Sample | null = null;
    let hi: Sample | null = null;
    let gap: Sample | null = null;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      if (s.v === null) {
        gap ??= s;
        continue;
      }
      if (lo === null || s.v < (lo.v as number)) lo = s;
      if (hi === null || s.v > (hi.v as number)) hi = s;
    }

    if (lo === null) {
      // Bucket was all gaps (or empty) — preserve the gap.
      if (gap) out.push(gap);
      continue;
    }
    // Emit extrema in time order so x stays monotonic.
    if (lo.t <= (hi as Sample).t) {
      out.push(lo);
      if (hi !== lo) out.push(hi as Sample);
    } else {
      out.push(hi as Sample);
      out.push(lo);
    }
  }

  // Pin exact endpoints so the curve starts/ends where the data does.
  if (out.length === 0 || out[0].t !== samples[0].t) out.unshift(samples[0]);
  const last = samples[n - 1];
  if (out[out.length - 1].t !== last.t) out.push(last);

  return out;
}
