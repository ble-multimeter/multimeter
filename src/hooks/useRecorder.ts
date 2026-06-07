// Turns the live Reading stream into the three things the chart/stats/recording all need
// from one history buffer (PLAN §3.3, and the reason Phases 2+3 merged): a bounded
// in-memory current-segment buffer that feeds the chart and live stats *always* while
// connected, plus an explicit recording that layers full-resolution IndexedDB persistence
// on top. Range changes stay in one segment; a quantity change (mode / °C↔°F / AC↔DC)
// starts a new one and resets the chart + live stats window (§3.4).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { quantityKey, type Reading, type Sample, type Session } from '../ble/types';
import { computeStats, type Stats } from '../lib/stats';
import * as storage from '../lib/storage';

// Cap the in-memory current-segment buffer so an idle multi-hour session can't grow
// without bound. Full resolution still goes to IndexedDB while recording, so nothing the
// user chose to *keep* is lost — only the un-recorded live scrollback is capped.
const LIVE_CAP = 20_000;
const FLUSH_MS = 1_000; // batch persistence: one IDB write per second of recording

export type RecState = 'idle' | 'recording' | 'paused';

export interface SegmentInfo {
  seg: number;
  function: string;
  acdc: string;
  unit: string; // baseUnit, for the chart axis label
}

export interface Recorder {
  samples: Sample[]; // current segment only — what the chart plots
  truncated: boolean; // live buffer hit LIVE_CAP and dropped old points
  segment: SegmentInfo | null;
  stats: Stats; // over the live-stats window (resets on segment change / resetStats)
  statsDurationMs: number; // time span of that window
  resetStats: () => void;
  recState: RecState;
  recCount: number; // samples persisted in the active recording
  csvTarget: { id: string; name: string } | null; // active or most-recent recording
  record: (name: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

export function useRecorder(reading: Reading | null): Recorder {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [segment, setSegment] = useState<SegmentInfo | null>(null);
  const [recState, setRecState] = useState<RecState>('idle');
  const [recCount, setRecCount] = useState(0);
  const [csvTarget, setCsvTarget] = useState<{ id: string; name: string } | null>(null);
  const [statsStartT, setStatsStartT] = useState(0); // window start for live stats

  // Cross-render bookkeeping the per-reading effect reads without stale closures.
  const lastTsRef = useRef<number | null>(null); // dedup (StrictMode / re-renders)
  const prevKeyRef = useRef<string | null>(null); // last quantity key
  const segRef = useRef(0);

  // Recording-only state: the active session, the seq cursor, the unflushed batch, and
  // the running segment list for session metadata.
  const recRef = useRef<RecState>('idle');
  const sessionRef = useRef<Session | null>(null);
  const seqRef = useRef(0);
  const pendingRef = useRef<Reading[]>([]);
  const segmentsRef = useRef<SegmentInfo[]>([]);

  // Flush the unwritten batch to IndexedDB and keep the session row current. Called on a
  // timer and again on stop, so a crash loses at most ~FLUSH_MS of samples.
  const flush = useCallback(async (final = false) => {
    const s = sessionRef.current;
    if (!s) return;
    const batch = pendingRef.current;
    if (batch.length > 0) {
      pendingRef.current = [];
      const startSeq = seqRef.current;
      seqRef.current += batch.length;
      await storage.appendSamples(s.id, startSeq, batch);
    }
    const updated: Session = {
      ...s,
      sampleCount: seqRef.current,
      segments: segmentsRef.current.map((g) => ({
        seg: g.seg,
        function: g.function,
        acdc: g.acdc,
        unit: g.unit,
      })),
      endedAt: final ? Date.now() : s.endedAt,
    };
    sessionRef.current = updated;
    await storage.updateSession(updated);
  }, []);

  // Periodic flush while recording.
  useEffect(() => {
    if (recState !== 'recording') return;
    const id = setInterval(() => void flush(), FLUSH_MS);
    return () => clearInterval(id);
  }, [recState, flush]);

  // The one place readings enter the system.
  useEffect(() => {
    if (!reading) return;
    if (lastTsRef.current === reading.ts) return; // same frame, re-render — ignore
    lastTsRef.current = reading.ts;

    const key = quantityKey(reading);
    const isNewSegment = prevKeyRef.current !== null && key !== prevKeyRef.current;
    prevKeyRef.current = key;

    if (isNewSegment) {
      segRef.current += 1;
      setSamples([]); // chart restarts on the new quantity (§3.4)
      setTruncated(false);
      setStatsStartT(reading.ts); // live stats window resets to the new segment
    }

    const info: SegmentInfo = {
      seg: segRef.current,
      function: reading.function,
      acdc: reading.acdc,
      unit: reading.baseUnit,
    };
    setSegment(info);

    const sample: Sample = { t: reading.ts, v: reading.baseValue, seg: segRef.current };
    setSamples((prev) => {
      const next = prev.length >= LIVE_CAP ? prev.slice(prev.length - LIVE_CAP + 1) : prev.slice();
      next.push(sample);
      if (next.length >= LIVE_CAP) setTruncated(true);
      return next;
    });

    // Persistence: only while actively recording (paused = gap in the recording).
    if (recRef.current === 'recording') {
      if (isNewSegment || segmentsRef.current.length === 0) segmentsRef.current.push(info);
      pendingRef.current.push(reading);
      setRecCount((c) => c + 1);
    }
  }, [reading]);

  // Live stats over the current window (segment start, or last resetStats). Cheap at a
  // few Hz; recomputing on each new sample keeps min/max/avg live.
  const windowed = useMemo(() => samples.filter((s) => s.t >= statsStartT), [samples, statsStartT]);
  const stats = useMemo(() => computeStats(windowed.map((s) => s.v)), [windowed]);
  const statsDurationMs = windowed.length > 1 ? windowed[windowed.length - 1].t - windowed[0].t : 0;

  const resetStats = useCallback(() => {
    const lastT = samples.length ? samples[samples.length - 1].t : 0;
    setStatsStartT(lastT);
  }, [samples]);

  const record = useCallback((name: string) => {
    if (recRef.current !== 'idle') return;
    const session: Session = {
      id: newId(),
      name: name.trim() || `Recording ${new Date().toLocaleString()}`,
      startedAt: Date.now(),
      endedAt: null,
      sampleCount: 0,
      segments: [],
    };
    sessionRef.current = session;
    seqRef.current = 0;
    pendingRef.current = [];
    segmentsRef.current = [];
    setRecCount(0);
    setCsvTarget({ id: session.id, name: session.name }); // enables CSV export now
    void storage.createSession(session);
    recRef.current = 'recording';
    setRecState('recording');
  }, []);

  const pause = useCallback(() => {
    if (recRef.current !== 'recording') return;
    recRef.current = 'paused';
    setRecState('paused');
    void flush();
  }, [flush]);

  const resume = useCallback(() => {
    if (recRef.current !== 'paused') return;
    recRef.current = 'recording';
    setRecState('recording');
  }, []);

  const stop = useCallback(() => {
    if (recRef.current === 'idle') return;
    recRef.current = 'idle';
    setRecState('idle');
    void flush(true).then(() => {
      sessionRef.current = null;
    });
  }, [flush]);

  return {
    samples,
    truncated,
    segment,
    stats,
    statsDurationMs,
    resetStats,
    recState,
    recCount,
    csvTarget,
    record,
    pause,
    resume,
    stop,
  };
}
