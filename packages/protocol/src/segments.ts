// Segment derivation (PLAN §3.4): readings split into contiguous same-quantity runs. A range
// change (kΩ↔MΩ) keeps one segment because baseValue is normalized; a function / °C↔°F / AC↔DC
// change starts the next (it changes quantityKey). One rule, three shapes — used by the CSV
// `segment` column, the recorder's pin-session metadata, and the read-only session viewer.
// (The live RecorderSession derives segments incrementally as frames arrive; it shares the same
// quantityKey rule but can't batch over a full array.)

import { quantityKey, toSample } from './types';
import type { ChannelInfo, Reading, Sample } from './types';

// The per-channel segment metadata shape (one entry per contiguous same-quantity run).
export type SegmentMeta = ChannelInfo['segments'];

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

/** Collapsed per-segment metadata for a channel (one entry per contiguous run). */
export function deriveSegments(readings: Reading[]): SegmentMeta {
  const out: SegmentMeta = [];
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
  info: SegmentMeta[number];
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
    out[out.length - 1]!.samples.push(toSample(r, seg));
  }
  return out;
}
