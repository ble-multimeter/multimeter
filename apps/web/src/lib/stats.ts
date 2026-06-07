// Summary statistics over a numeric series (PLAN §3.2). Pure, no React/BLE — tested in
// Node. Nulls (OL / NCV / non-numeric) are *counted* (so the UI can show "N samples,
// M overload") but excluded from the math, mirroring how the chart draws them as gaps.

export interface Stats {
  count: number; // numeric samples included in the math
  nullCount: number; // OL / non-numeric samples skipped
  min: number | null;
  max: number | null;
  avg: number | null;
  p2p: number | null; // peak-to-peak = max − min
  stddev: number | null; // population standard deviation
  last: number | null; // most recent numeric value
}

const EMPTY: Stats = {
  count: 0,
  nullCount: 0,
  min: null,
  max: null,
  avg: null,
  p2p: null,
  stddev: null,
  last: null,
};

export function computeStats(values: (number | null)[]): Stats {
  let count = 0;
  let nullCount = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let last: number | null = null;

  for (const v of values) {
    if (v === null || Number.isNaN(v)) {
      nullCount++;
      continue;
    }
    count++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
    last = v;
  }

  if (count === 0) return { ...EMPTY, nullCount };

  const avg = sum / count;
  // Population variance via E[x²] − E[x]²; clamp tiny negatives from float error.
  const variance = Math.max(0, sumSq / count - avg * avg);

  return {
    count,
    nullCount,
    min,
    max,
    avg,
    p2p: max - min,
    stddev: Math.sqrt(variance),
    last,
  };
}
