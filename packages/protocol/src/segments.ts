// Segment derivation (PLAN §3.4): readings split into contiguous same-quantity runs. A range
// change (kΩ↔MΩ) keeps one segment because baseValue is normalized; a function / °C↔°F / AC↔DC
// change starts the next (it changes quantityKey). One rule, three shapes — used by the CSV
// `segment` column, the recorder's pin-session metadata, and the read-only session viewer.
// (The live RecorderSession derives segments incrementally as frames arrive; it shares the same
// quantityKey rule but can't batch over a full array.)

import { quantityKey, toSample } from './types';
import type { Reading, Sample, Session } from './types';

/** The 0-based segment index for each reading (parallel to `readings`). */
export function segmentIndices(readings: Reading[]): number[] {
  const out: number[] = [];
  let key: string | null = null;
  let seg = -1;
  for (const r of readings) {
    const k = quantityKey(r);
    if (k !== key) {
      key = k;
      seg++;
    }
    out.push(seg);
  }
  return out;
}

/** Collapsed per-segment metadata for a Session (one entry per contiguous run). */
export function deriveSegments(readings: Reading[]): Session['segments'] {
  const out: Session['segments'] = [];
  let key: string | null = null;
  let seg = -1;
  for (const r of readings) {
    const k = quantityKey(r);
    if (k !== key) {
      key = k;
      seg++;
      out.push({ seg, function: r.function, acdc: r.acdc, unit: r.baseUnit });
    }
  }
  return out;
}

export interface ReadingSegment {
  info: Session['segments'][number];
  samples: Sample[];
}

/** Split readings into per-segment groups, each with its charted Samples (session viewer). */
export function splitSegments(readings: Reading[]): ReadingSegment[] {
  const out: ReadingSegment[] = [];
  let key: string | null = null;
  let seg = -1;
  for (const r of readings) {
    const k = quantityKey(r);
    if (k !== key) {
      key = k;
      seg++;
      out.push({
        info: { seg, function: r.function, acdc: r.acdc, unit: r.baseUnit },
        samples: [],
      });
    }
    out[out.length - 1].samples.push(toSample(r, seg));
  }
  return out;
}
