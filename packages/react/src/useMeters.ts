// React binding for the MetersSession coordinator (Phase 7) — replaces useMeter. A thin adapter:
// one MetersSession per mount, mirrored into React via useSyncExternalStore. All multi-channel
// logic (per-meter sessions, derived recompute, staleness, add/remove) lives in the engine
// (@ble-multimeter/web-bluetooth); this just exposes its snapshot + bound mutators. Single meter
// is just N=1 — there is no separate single-meter hook anymore.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  MetersSession,
  MeterSession,
  type MetersSnapshot,
  type DerivedConfig,
} from '@ble-multimeter/web-bluetooth';

export type {
  MetersSnapshot,
  Channel,
  MeterChannel,
  DerivedChannel,
  DerivedConfig,
} from '@ble-multimeter/web-bluetooth';

export interface Meters extends MetersSnapshot {
  isDemo: boolean;
  /** The backing MeterSession for a channel (drive connect/reconnect/disconnect/controls). */
  meterSession: (id: string) => MeterSession | undefined;
  addRealMeter: (role?: string) => string;
  addDemoMeter: () => string;
  removeMeter: (id: string) => void;
  setMeterRole: (id: string, role: string) => void;
  setMeterLabel: (id: string, label: string) => void;
  addDerived: (cfg: DerivedConfig) => string | null;
  removeDerived: (id: string) => void;
}

export function useMeters(): Meters {
  const ref = useRef<MetersSession | null>(null);
  ref.current ??= new MetersSession();
  const session = ref.current;

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // revive() on setup re-bootstraps the singleton if a prior cleanup disposed it — React StrictMode
  // (dev) runs setup→cleanup→setup, and without this the throwaway dispose leaves meterSession()
  // empty, so connect() silently no-ops and the BLE chooser never opens. Mirrors the refresh-on-
  // setup pattern in useSessions/useRecorder.
  useEffect(() => {
    session.revive();
    return () => session.dispose();
  }, [session]);

  return {
    ...snap,
    isDemo: session.isDemo,
    meterSession: session.meterSession.bind(session),
    addRealMeter: session.addRealMeter,
    addDemoMeter: session.addDemoMeter,
    removeMeter: session.removeMeter,
    setMeterRole: session.setMeterRole,
    setMeterLabel: session.setMeterLabel,
    addDerived: session.addDerived,
    removeDerived: session.removeDerived,
  };
}
