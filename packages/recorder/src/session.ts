// RecorderSession — the framework-agnostic, multi-channel recording engine (Phase 7,
// plan-7.md §2/§3). Turns N fed Reading streams (meter + derived channels) into what the
// multi-series chart / per-channel stats / shared recording need, from one history buffer per
// channel (PLAN §3.3): a bounded current-segment buffer (chart + live stats, always while
// connected) plus an explicit recording that layers full-resolution per-channel IndexedDB
// persistence on top. Range changes stay in one segment; a quantity change (mode / °C↔°F / AC↔DC)
// starts a new one and resets that channel's chart + live stats window (§3.4).
//
// One shared record/pause/stop spans every channel into a single Session; the sample counter is
// the total across channels. Single meter is just one channel — no separate single-stream path.
// Bluetooth- and framework-agnostic: it just consumes Readings tagged with a channelId.

import {
  quantityKey,
  computeStats,
  type ChannelInfo,
  type Reading,
  type Sample,
  type Session,
  type Stats,
} from '@ble-multimeter/protocol';
import * as storage from './storage';
import { newId } from './ids';

// Cap each channel's in-memory current-segment buffer so an idle multi-hour session can't grow
// without bound. Full resolution still goes to IndexedDB while recording, so nothing the user chose
// to *keep* is lost — only the un-recorded live scrollback is capped.
const LIVE_CAP = 20_000;
const FLUSH_MS = 1_000; // batch persistence: one IDB write per second of recording

export type RecState = 'idle' | 'recording' | 'paused';

export interface SegmentInfo {
  seg: number;
  function: string;
  acdc: string;
  unit: string; // baseUnit, for the chart axis label
}

// What a channel must declare so the recorder can persist its metadata (label/kind/derived refs).
// The recorder doesn't synthesize readings — the coordinator does — so this is just descriptive.
export interface ChannelSpec {
  id: string;
  label: string;
  kind: 'meter' | 'derived';
  role?: string | undefined;
  op?: ChannelInfo['op'];
  a?: string | undefined;
  b?: string | undefined;
}

// The live view of one channel: its current-segment samples (chart), segment info, and windowed
// stats. Mirrors the old single-channel snapshot, now per channel.
export interface ChannelView {
  id: string;
  label: string;
  kind: 'meter' | 'derived';
  samples: Sample[]; // current segment only — what the chart plots for this channel
  truncated: boolean;
  segment: SegmentInfo | null;
  stats: Stats;
  statsDurationMs: number;
}

export interface RecorderSnapshot {
  channels: ChannelView[]; // one per registered channel, in registration order
  recState: RecState;
  recCount: number; // total samples persisted across channels in the active recording
  csvTarget: { id: string; name: string } | null; // active or most-recent recording
}

// Per-channel mutable bookkeeping (live buffer + recording seq).
interface ChannelState {
  spec: ChannelSpec;
  samples: Sample[];
  truncated: boolean;
  segment: SegmentInfo | null;
  statsStartT: number;
  lastTs: number | null; // dedup per channel (StrictMode / repeated feeds)
  prevKey: string | null;
  seg: number;
  segments: SegmentInfo[]; // all segments seen while recording (for the session row)
  // recording-only:
  seq: number; // next persistence seq for this channel
  pending: Reading[]; // unflushed batch
  lastFn: string; // last-seen function (for ChannelInfo)
  lastUnit: string; // last-seen baseUnit
}

export class RecorderSession {
  private listeners = new Set<() => void>();
  private snap: RecorderSnapshot;

  // Ordered channels + a lookup by id.
  private order: string[] = [];
  private chans = new Map<string, ChannelState>();

  // Recording-only shared state.
  private recState: RecState = 'idle';
  private csvTarget: { id: string; name: string } | null = null;
  private session: Session | null = null;
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

  private newChannelState(spec: ChannelSpec): ChannelState {
    return {
      spec,
      samples: [],
      truncated: false,
      segment: null,
      statsStartT: 0,
      lastTs: null,
      prevKey: null,
      seg: 0,
      segments: [],
      seq: 0,
      pending: [],
      lastFn: '',
      lastUnit: '',
    };
  }

  // Register the channels the recorder should track. Called whenever the channel set changes
  // (add/remove meter or derived). New channels start fresh; existing ones keep their buffers. A
  // dropped channel is normally forgotten — BUT if it captured samples during an active recording,
  // we keep its recording bookkeeping (out of `order`, so it leaves the chart/cards) so flush/stop
  // still persists it and lists it in the session; otherwise its already-written IDB samples would
  // be orphaned and silently absent from the export/viewer. Order follows the spec list.
  setChannels = (specs: ChannelSpec[]): void => {
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.id);
      const existing = this.chans.get(spec.id);
      if (existing)
        existing.spec = spec; // refresh label/role
      else this.chans.set(spec.id, this.newChannelState(spec));
    }
    for (const id of [...this.chans.keys()]) {
      if (seen.has(id)) continue;
      const c = this.chans.get(id)!;
      const hasRecordingData = this.recState !== 'idle' && (c.seq > 0 || c.pending.length > 0);
      if (!hasRecordingData) this.chans.delete(id); // else retain for flush; dropped from `order`
    }
    this.order = specs.map(s => s.id);
    this.emit();
  };

  private build(): RecorderSnapshot {
    const channels: ChannelView[] = this.order
      .map(id => this.chans.get(id))
      .filter((c): c is ChannelState => c !== undefined)
      .map(c => {
        const window = c.samples.filter(s => s.t >= c.statsStartT);
        const stats = computeStats(window.map(s => s.v));
        const statsDurationMs = window.length > 1 ? window[window.length - 1]!.t - window[0]!.t : 0;
        return {
          id: c.spec.id,
          label: c.spec.label,
          kind: c.spec.kind,
          samples: c.samples,
          truncated: c.truncated,
          segment: c.segment,
          stats,
          statsDurationMs,
        };
      });
    return {
      channels,
      recState: this.recState,
      recCount: this.totalRecCount(),
      csvTarget: this.csvTarget,
    };
  }

  private totalRecCount(): number {
    let n = 0;
    for (const c of this.chans.values()) n += c.seq + c.pending.length;
    return n;
  }

  private emit(): void {
    this.snap = this.build();
    for (const l of this.listeners) l();
  }

  /** Feed one channel's live reading. The single place readings enter the system. */
  push = (channelId: string, reading: Reading | null): void => {
    if (!reading) return;
    const c = this.chans.get(channelId);
    if (!c) return; // channel not registered — ignore
    if (c.lastTs === reading.ts) return; // same frame, repeated feed — dedup per channel
    c.lastTs = reading.ts;

    const key = quantityKey(reading);
    const isNewSegment = c.prevKey !== null && key !== c.prevKey;
    c.prevKey = key;

    if (isNewSegment) {
      c.seg += 1;
      c.samples = []; // chart restarts on the new quantity (§3.4)
      c.truncated = false;
      c.statsStartT = reading.ts; // live stats window resets to the new segment
    }

    const info: SegmentInfo = {
      seg: c.seg,
      function: reading.function,
      acdc: reading.acdc,
      unit: reading.baseUnit,
    };
    c.segment = info;
    c.lastFn = reading.function;
    c.lastUnit = reading.baseUnit;

    const sample: Sample = { t: reading.ts, v: reading.baseValue, seg: c.seg };
    const next =
      c.samples.length >= LIVE_CAP
        ? c.samples.slice(c.samples.length - LIVE_CAP + 1)
        : c.samples.slice();
    next.push(sample);
    if (next.length >= LIVE_CAP) c.truncated = true;
    c.samples = next;

    // Persistence: only while actively recording (paused = gap in the recording).
    if (this.recState === 'recording') {
      if (isNewSegment || c.segments.length === 0) c.segments.push(info);
      c.pending.push(reading);
    }

    this.emit();
  };

  /** Reset every channel's live-stats window to its latest sample. */
  resetStats = (): void => {
    for (const c of this.chans.values()) {
      c.statsStartT = c.samples.length ? c.samples[c.samples.length - 1]!.t : 0;
    }
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
      channels: [],
    };
    this.session = session;
    // Reset every channel's recording bookkeeping (the live buffers stay). Seed function/unit from
    // the current segment so a channel that's live at Record but stalls before its next push is
    // still listed with a real function/unit (not blank), consistent with seeding `segments`.
    for (const c of this.chans.values()) {
      c.seq = 0;
      c.pending = [];
      c.segments = c.segment ? [c.segment] : [];
      c.lastFn = c.segment?.function ?? '';
      c.lastUnit = c.segment?.unit ?? '';
    }
    this.csvTarget = { id: session.id, name: session.name }; // enables CSV export now
    void storage.createSession(session);
    this.recState = 'recording';
    this.startFlush();
    this.emit();
  };

  // pause/stop return the in-flight persistence promise so a caller (or test) that needs to know
  // the durable write finished can await it; void callers (the UI) can ignore it as before.
  pause = (): Promise<void> => {
    if (this.recState !== 'recording') return Promise.resolve();
    this.recState = 'paused';
    this.stopFlush();
    const done = this.flush();
    this.emit();
    return done;
  };

  resume = (): void => {
    if (this.recState !== 'paused') return;
    this.recState = 'recording';
    this.startFlush();
    this.emit();
  };

  stop = (): Promise<void> => {
    if (this.recState === 'idle') return Promise.resolve();
    this.recState = 'idle';
    this.stopFlush();
    const done = this.flush(true).then(() => {
      this.session = null;
    });
    this.emit();
    return done;
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

  // Build the ChannelInfo for one channel from its spec + recording bookkeeping.
  private channelInfo(c: ChannelState): ChannelInfo {
    const { spec } = c;
    return {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      role: spec.role,
      op: spec.op,
      a: spec.a,
      b: spec.b,
      function: c.lastFn,
      unit: c.lastUnit,
      segments: c.segments.map(g => ({
        seg: g.seg,
        function: g.function,
        acdc: g.acdc,
        unit: g.unit,
      })),
    };
  }

  // Flush every channel's unwritten batch to IndexedDB and keep the session row current. Called on
  // a timer and on pause/stop, so a crash loses at most ~FLUSH_MS of samples.
  private async flush(final = false): Promise<void> {
    const s = this.session;
    if (!s) return;
    let total = 0;
    const channelInfos: ChannelInfo[] = [];
    // Live channels first (in display order), then any retained-but-removed channels still holding
    // recording data (setChannels keeps them so their persisted samples aren't orphaned).
    const ids = [...this.order];
    for (const id of this.chans.keys()) if (!ids.includes(id)) ids.push(id);
    for (const id of ids) {
      const c = this.chans.get(id);
      if (!c) continue;
      const batch = c.pending;
      if (batch.length > 0) {
        c.pending = [];
        const startSeq = c.seq;
        c.seq += batch.length;
        await storage.appendSamples(s.id, c.spec.id, startSeq, batch);
      }
      total += c.seq;
      // Only record channels that actually captured something (so an idle channel isn't listed).
      if (c.seq > 0) channelInfos.push(this.channelInfo(c));
    }
    const updated: Session = {
      ...s,
      sampleCount: total,
      channels: channelInfos,
      endedAt: final ? Date.now() : s.endedAt,
    };
    this.session = updated;
    await storage.updateSession(updated);
  }
}
