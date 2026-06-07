// RecorderSession — the framework-agnostic recording engine. Turns a fed Reading stream into
// the three things the chart/stats/recording need from one history buffer (PLAN §3.3): a
// bounded current-segment buffer (chart + live stats, always while connected) plus an explicit
// recording that layers full-resolution IndexedDB persistence on top. Range changes stay in one
// segment; a quantity change (mode / °C↔°F / AC↔DC) starts a new one and resets the chart + live
// stats window (§3.4).
//
// This is the logic that previously lived inside the React useRecorder hook; it's Bluetooth- and
// framework-agnostic (it just consumes Readings), so React and Vue bindings are thin adapters
// that feed push() and mirror getSnapshot(). It is NOT coupled to a transport — any Reading
// source works.

import {
  quantityKey,
  computeStats,
  type Reading,
  type Sample,
  type Session,
  type Stats,
} from '@mbtech-nl/multimeter-protocol';
import * as storage from './storage';
import { newId } from './ids';

// Cap the in-memory current-segment buffer so an idle multi-hour session can't grow without
// bound. Full resolution still goes to IndexedDB while recording, so nothing the user chose to
// *keep* is lost — only the un-recorded live scrollback is capped.
const LIVE_CAP = 20_000;
const FLUSH_MS = 1_000; // batch persistence: one IDB write per second of recording

export type RecState = 'idle' | 'recording' | 'paused';

export interface SegmentInfo {
  seg: number;
  function: string;
  acdc: string;
  unit: string; // baseUnit, for the chart axis label
}

export interface RecorderSnapshot {
  samples: Sample[]; // current segment only — what the chart plots
  truncated: boolean; // live buffer hit LIVE_CAP and dropped old points
  segment: SegmentInfo | null;
  stats: Stats; // over the live-stats window (resets on segment change / resetStats)
  statsDurationMs: number; // time span of that window
  recState: RecState;
  recCount: number; // samples persisted in the active recording
  csvTarget: { id: string; name: string } | null; // active or most-recent recording
}

export class RecorderSession {
  private listeners = new Set<() => void>();
  private snap: RecorderSnapshot;

  // Live buffer + segment bookkeeping.
  private samples: Sample[] = [];
  private truncated = false;
  private segment: SegmentInfo | null = null;
  private statsStartT = 0; // live-stats window start
  private lastTs: number | null = null; // dedup (StrictMode / repeated feeds)
  private prevKey: string | null = null;
  private seg = 0;

  // Recording-only state.
  private recState: RecState = 'idle';
  private recCount = 0;
  private csvTarget: { id: string; name: string } | null = null;
  private session: Session | null = null;
  private seq = 0;
  private pending: Reading[] = [];
  private segments: SegmentInfo[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.snap = this.build();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): RecorderSnapshot => this.snap;

  private build(): RecorderSnapshot {
    const window = this.samples.filter((s) => s.t >= this.statsStartT);
    const stats = computeStats(window.map((s) => s.v));
    const statsDurationMs = window.length > 1 ? window[window.length - 1].t - window[0].t : 0;
    return {
      samples: this.samples,
      truncated: this.truncated,
      segment: this.segment,
      stats,
      statsDurationMs,
      recState: this.recState,
      recCount: this.recCount,
      csvTarget: this.csvTarget,
    };
  }

  private emit(): void {
    this.snap = this.build();
    for (const l of this.listeners) l();
  }

  /** Feed one live reading. The single place readings enter the system. */
  push = (reading: Reading | null): void => {
    if (!reading) return;
    if (this.lastTs === reading.ts) return; // same frame, repeated feed — ignore
    this.lastTs = reading.ts;

    const key = quantityKey(reading);
    const isNewSegment = this.prevKey !== null && key !== this.prevKey;
    this.prevKey = key;

    if (isNewSegment) {
      this.seg += 1;
      this.samples = []; // chart restarts on the new quantity (§3.4)
      this.truncated = false;
      this.statsStartT = reading.ts; // live stats window resets to the new segment
    }

    const info: SegmentInfo = {
      seg: this.seg,
      function: reading.function,
      acdc: reading.acdc,
      unit: reading.baseUnit,
    };
    this.segment = info;

    const sample: Sample = { t: reading.ts, v: reading.baseValue, seg: this.seg };
    const next =
      this.samples.length >= LIVE_CAP
        ? this.samples.slice(this.samples.length - LIVE_CAP + 1)
        : this.samples.slice();
    next.push(sample);
    if (next.length >= LIVE_CAP) this.truncated = true;
    this.samples = next;

    // Persistence: only while actively recording (paused = gap in the recording).
    if (this.recState === 'recording') {
      if (isNewSegment || this.segments.length === 0) this.segments.push(info);
      this.pending.push(reading);
      this.recCount += 1;
    }

    this.emit();
  };

  resetStats = (): void => {
    this.statsStartT = this.samples.length ? this.samples[this.samples.length - 1].t : 0;
    this.emit();
  };

  record = (name: string): void => {
    if (this.recState !== 'idle') return;
    const session: Session = {
      id: newId(),
      name: name.trim() || `Recording ${new Date().toLocaleString()}`,
      startedAt: Date.now(),
      endedAt: null,
      sampleCount: 0,
      segments: [],
    };
    this.session = session;
    this.seq = 0;
    this.pending = [];
    this.segments = [];
    this.recCount = 0;
    this.csvTarget = { id: session.id, name: session.name }; // enables CSV export now
    void storage.createSession(session);
    this.recState = 'recording';
    this.startFlush();
    this.emit();
  };

  pause = (): void => {
    if (this.recState !== 'recording') return;
    this.recState = 'paused';
    this.stopFlush();
    void this.flush();
    this.emit();
  };

  resume = (): void => {
    if (this.recState !== 'paused') return;
    this.recState = 'recording';
    this.startFlush();
    this.emit();
  };

  stop = (): void => {
    if (this.recState === 'idle') return;
    this.recState = 'idle';
    this.stopFlush();
    void this.flush(true).then(() => {
      this.session = null;
    });
    this.emit();
  };

  /** Release the flush timer + listeners (call from the binding's unmount cleanup). */
  dispose = (): void => {
    this.stopFlush();
    this.listeners.clear();
  };

  // --- persistence ---
  private startFlush(): void {
    if (!this.flushTimer) this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
  }
  private stopFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // Flush the unwritten batch to IndexedDB and keep the session row current. Called on a timer
  // and on pause/stop, so a crash loses at most ~FLUSH_MS of samples.
  private async flush(final = false): Promise<void> {
    const s = this.session;
    if (!s) return;
    const batch = this.pending;
    if (batch.length > 0) {
      this.pending = [];
      const startSeq = this.seq;
      this.seq += batch.length;
      await storage.appendSamples(s.id, startSeq, batch);
    }
    const updated: Session = {
      ...s,
      sampleCount: this.seq,
      segments: this.segments.map((g) => ({
        seg: g.seg,
        function: g.function,
        acdc: g.acdc,
        unit: g.unit,
      })),
      endedAt: final ? Date.now() : s.endedAt,
    };
    this.session = updated;
    await storage.updateSession(updated);
  }
}
