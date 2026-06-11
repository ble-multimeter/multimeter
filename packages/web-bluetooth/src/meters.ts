// MetersSession — the multi-channel coordinator (plan-7.md §2, §4.3). Owns an ordered list of
// meter channels (each backed by its own independent MeterSession) plus a list of derived-channel
// configs (P = V × I, …). It subscribes to every meter, holds each one's latest Reading, and on
// *any* meter tick recomputes the derived channels that reference it from the inputs' latest values
// (nearest-sample alignment, PLAN §7). It exposes one unified useSyncExternalStore-friendly
// snapshot so the React/Vue bindings stay thin.
//
// Single meter is just N=1 — there is no separate single-channel path. The engine is
// framework-agnostic (no React, no DOM beyond what MeterSession already needs); demo and real BLE
// differ only in how a meter channel's MeterSession is constructed.

import {
  combineReadings,
  derivedFormula,
  deriveUnit,
  type Reading,
} from '@ble-multimeter/protocol';
import type { DerivedOp, MeterControl } from '@ble-multimeter/protocol';
import { MeterSession, type MeterSnapshot, type MeterState } from './session';
import { demoKind, DEMO_PROFILES, DEFAULT_DEMO_PROFILE, type DemoProfile } from './demo';

// A derived input is considered stale (its value no longer trustworthy for a synchronized
// computation) when its meter isn't live or its latest sample is older than this. ~2× the slowest
// expected meter interval; a stale input nulls the derived sample (a chart gap) and flags the card.
const STALE_MS = 2_000;

let channelCounter = 0;
const nextChannelId = (prefix: string): string => `${prefix}-${++channelCounter}`;

// --- channel descriptors (the unified snapshot's per-channel view) ---

export interface MeterChannel {
  id: string;
  kind: 'meter';
  label: string; // user-editable display name (defaults to role)
  role: string; // role tag ("V source", "I source") for the derived builder + legend
  // Mirror of the backing MeterSession snapshot, so the UI reads one object per channel.
  state: MeterState;
  reading: Reading | null;
  deviceName: string | null;
  error: string | null;
  controls: MeterControl[]; // front-panel controls the connected meter exposes (empty when idle)
}

export interface DerivedChannel {
  id: string;
  kind: 'derived';
  label: string; // e.g. "P"
  op: DerivedOp;
  aChannelId: string;
  bChannelId: string;
  unit: string; // resolved SI base unit (for legend/axis)
  reading: Reading | null; // last synthesized value (null = gap)
  stale: boolean; // an input lagged / went non-live on the last recompute
}

export type Channel = MeterChannel | DerivedChannel;

export interface MetersSnapshot {
  meters: MeterChannel[];
  derived: DerivedChannel[];
  channels: Channel[]; // meters then derived, in display order
}

// Config for a derived channel the caller wants to add.
export interface DerivedConfig {
  label: string;
  op: DerivedOp;
  aChannelId: string;
  bChannelId: string;
}

// One backing meter: its session, the subscription cleanup, and its mutable label/role.
interface MeterEntry {
  id: string;
  session: MeterSession;
  unsubscribe: () => void;
  label: string;
  role: string;
  // true while the role still tracks the device automatically (named from the device on connect,
  // enumerated on collision); a user rename via setMeterRole pins it (→ false).
  autoRole: boolean;
}

/**
 * Pick a name for an auto-named meter: the device name, or `${name} N` (N≥2) if another channel
 * already uses it — so two identical meters read "UT60BTk" + "UT60BTk 2" rather than colliding.
 */
export function dedupName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!set.has(candidate)) return candidate;
  }
  return base;
}

interface DerivedEntry {
  id: string;
  label: string;
  op: DerivedOp;
  aChannelId: string;
  bChannelId: string;
  reading: Reading | null;
  stale: boolean;
}

export class MetersSession {
  readonly isDemo: boolean;

  private meters: MeterEntry[] = [];
  private derivedList: DerivedEntry[] = [];
  private listeners = new Set<() => void>();
  private snap: MetersSnapshot = { meters: [], derived: [], channels: [] };
  // demo-meter naming so "Add demo meter" produces distinct labels.
  private addedDemoCount = 0;
  // Set by dispose(); revive() rebuilds from it. React StrictMode (dev) runs an effect's
  // setup→cleanup→setup, so the throwaway cleanup disposes this singleton before the real mount —
  // revive() re-bootstraps it so the channels (and their backing sessions) come back.
  private disposed = false;

  constructor() {
    this.isDemo = demoKind() !== 'none';
    this.bootstrap();
    this.rebuild();
  }

  // --- external store ---
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): MetersSnapshot => this.snap;

  private emit(): void {
    this.rebuild();
    for (const l of this.listeners) l();
  }

  // Initial channels for the chosen demo scenario. `power` preloads V + I meters and a P=V×I
  // derived channel — the headline two-device scenario, ready on load. `single`/none start with a
  // single meter channel (auto-connected in demo, awaiting a user gesture for real BLE).
  private bootstrap(): void {
    const kind = demoKind();
    if (kind === 'power') {
      const v = this.addMeterEntry(this.makeDemoSession(DEMO_PROFILES.volts), DEMO_PROFILES.volts);
      const a = this.addMeterEntry(this.makeDemoSession(DEMO_PROFILES.amps), DEMO_PROFILES.amps);
      this.addDerived({ label: 'P', op: 'mul', aChannelId: v.id, bChannelId: a.id });
    } else if (kind === 'single') {
      this.addMeterEntry(this.makeDemoSession(DEFAULT_DEMO_PROFILE), DEFAULT_DEMO_PROFILE);
    } else {
      // Real BLE: one meter channel, awaiting a connect gesture. Its role auto-names from the
      // device once connected ("Meter" is just the pre-connect placeholder).
      this.addMeterEntry(new MeterSession(), { role: 'Meter', auto: true });
    }
  }

  private makeDemoSession(profile: DemoProfile): MeterSession {
    return new MeterSession({ demoProfile: profile, forceDemo: true });
  }

  // Wire a freshly-constructed MeterSession into a channel entry: subscribe so its ticks drive our
  // snapshot + the derived recompute. `seed` provides the channel's role/label/initial id.
  private addMeterEntry(
    session: MeterSession,
    seed: { id?: string; role: string; deviceName?: string; auto?: boolean },
  ): MeterEntry {
    const id = seed.id ?? nextChannelId('meter');
    const entry: MeterEntry = {
      id,
      session,
      unsubscribe: () => {},
      label: seed.role,
      role: seed.role,
      autoRole: seed.auto ?? false,
    };
    entry.unsubscribe = session.subscribe(() => this.onMeterTick(entry));
    this.meters.push(entry);
    // Demo meters auto-stream; real ones wait for connect(). Auto-connect demo here so the
    // coordinator owns activation (the binding doesn't have to).
    if (session.isDemo) session.connect();
    return entry;
  }

  // A meter produced a new snapshot. Adopt the device name (if auto), recompute every derived
  // channel that references it, then emit.
  private onMeterTick(entry: MeterEntry): void {
    const snap = entry.session.getSnapshot();
    this.maybeAutoName(entry, snap.deviceName);
    for (const d of this.derivedList) {
      if (d.aChannelId === entry.id || d.bChannelId === entry.id) {
        this.recomputeDerived(d, snap.reading?.ts ?? Date.now());
      }
    }
    this.emit();
  }

  // Adopt the device name as an auto-named channel's role (deduped against the other channels), so
  // a connected meter reads as its device ("UT60BTk") rather than the "Meter" placeholder. No-op
  // once the user has renamed it (autoRole=false) or before a device name is known.
  private maybeAutoName(entry: MeterEntry, deviceName: string | null): void {
    if (!entry.autoRole || !deviceName) return;
    const taken = this.meters.filter(m => m !== entry).map(m => m.role);
    const desired = dedupName(deviceName, taken);
    if (entry.role === desired) return;
    // Keep label in sync while it's still tracking the role (the default).
    if (entry.label === entry.role) entry.label = desired;
    entry.role = desired;
  }

  // Latest snapshot for a meter channel id (or undefined if it's not a meter).
  private meterSnap(id: string): MeterSnapshot | undefined {
    return this.meters.find(m => m.id === id)?.session.getSnapshot();
  }

  // Is a meter input fresh enough to trust for a synchronized derived value? Stale when the meter
  // isn't live or its latest sample predates `now − STALE_MS` (plan-7.md §4.3).
  private isStale(snap: MeterSnapshot | undefined, now: number): boolean {
    if (!snap || snap.state !== 'live' || !snap.reading) return true;
    return now - snap.reading.ts > STALE_MS;
  }

  private recomputeDerived(d: DerivedEntry, now: number): void {
    const aSnap = this.meterSnap(d.aChannelId);
    const bSnap = this.meterSnap(d.bChannelId);
    const aStale = this.isStale(aSnap, now);
    const bStale = this.isStale(bSnap, now);
    d.stale = aStale || bStale;
    // A stale input nulls the contribution (combineReadings nulls the result), so the derived
    // sample is a gap rather than a stale-but-plausible number masquerading as live.
    const a = aStale ? null : (aSnap?.reading ?? null);
    const b = bStale ? null : (bSnap?.reading ?? null);
    const formula = derivedFormula(
      d.label,
      d.op,
      this.roleOf(d.aChannelId),
      this.roleOf(d.bChannelId),
    );
    d.reading = combineReadings(d.op, formula, a, b, now);
  }

  private roleOf(channelId: string): string {
    const m = this.meters.find(e => e.id === channelId);
    if (m) return m.role;
    const dv = this.derivedList.find(e => e.id === channelId);
    return dv ? dv.label : channelId;
  }

  // --- snapshot assembly ---
  private rebuild(): void {
    const meters: MeterChannel[] = this.meters.map(e => {
      const s = e.session.getSnapshot();
      return {
        id: e.id,
        kind: 'meter',
        label: e.label,
        role: e.role,
        state: s.state,
        reading: s.reading,
        deviceName: s.deviceName,
        error: s.error,
        controls: s.controls,
      };
    });
    const derived: DerivedChannel[] = this.derivedList.map(d => ({
      id: d.id,
      kind: 'derived',
      label: d.label,
      op: d.op,
      aChannelId: d.aChannelId,
      bChannelId: d.bChannelId,
      unit: d.reading?.baseUnit ?? this.previewUnit(d),
      reading: d.reading,
      stale: d.stale,
    }));
    this.snap = { meters, derived, channels: [...meters, ...derived] };
  }

  // The unit a derived channel *would* produce from its inputs' current units, even before a
  // sample exists (so the card/axis can label itself immediately).
  private previewUnit(d: DerivedEntry): string {
    const a = this.meterSnap(d.aChannelId)?.reading?.baseUnit ?? '';
    const b = this.meterSnap(d.bChannelId)?.reading?.baseUnit ?? '';
    return deriveUnit(d.op, a, b).unit;
  }

  // --- public mutators ---

  /** The backing MeterSession for a channel id (so the UI can drive connect/reconnect/controls). */
  meterSession(id: string): MeterSession | undefined {
    return this.meters.find(m => m.id === id)?.session;
  }

  /** Add a real-BLE meter channel (its own requestDevice gesture happens in connect()). With no
   *  explicit role it auto-names from the device on connect; a caller-supplied role is pinned. */
  addRealMeter = (role = 'Meter'): string => {
    const entry = this.addMeterEntry(new MeterSession(), { role, auto: role === 'Meter' });
    this.emit();
    return entry.id;
  };

  /** Add a demo meter channel — alternates V/A profiles so the added curve is interesting. */
  addDemoMeter = (): string => {
    const profile = this.addedDemoCount++ % 2 === 0 ? DEMO_PROFILES.amps : DEMO_PROFILES.volts;
    const entry = this.addMeterEntry(this.makeDemoSession(profile), profile);
    this.emit();
    return entry.id;
  };

  /** Remove a meter channel (disposing its session) and any derived channel that referenced it. */
  removeMeter = (id: string): void => {
    const idx = this.meters.findIndex(m => m.id === id);
    if (idx < 0) return;
    const [entry] = this.meters.splice(idx, 1);
    entry!.unsubscribe();
    entry!.session.disconnect();
    entry!.session.dispose();
    // Drop derived channels that can no longer be computed.
    this.derivedList = this.derivedList.filter(d => d.aChannelId !== id && d.bChannelId !== id);
    this.emit();
  };

  /** Rename / re-role a meter channel (feeds the derived formula + legend). Pins the name so it
   *  no longer auto-tracks the device. */
  setMeterRole = (id: string, role: string): void => {
    const m = this.meters.find(e => e.id === id);
    if (!m) return;
    // If the label was tracking the role (default), keep them in sync; otherwise leave a custom
    // label alone.
    if (m.label === m.role) m.label = role;
    m.role = role;
    m.autoRole = false;
    this.emit();
  };
  setMeterLabel = (id: string, label: string): void => {
    const m = this.meters.find(e => e.id === id);
    if (!m) return;
    m.label = label;
    this.emit();
  };

  /**
   * Add a derived channel. Returns its id, or null if it's invalid: both inputs must exist, be
   * distinct (a channel combined with itself is meaningless), and — when their units are known —
   * the op must be defined for them (mismatched +/−). The builder guards these too; this is the
   * engine-level backstop for any other caller.
   */
  addDerived = (cfg: DerivedConfig): string | null => {
    const aSnap = this.meterSnap(cfg.aChannelId);
    const bSnap = this.meterSnap(cfg.bChannelId);
    // Both inputs must be real meter channels, and they can't be the same channel.
    if (!aSnap || !bSnap || cfg.aChannelId === cfg.bChannelId) return null;
    const a = aSnap.reading?.baseUnit;
    const b = bSnap.reading?.baseUnit;
    // Only block on units when we *know* them and the op is invalid (mismatched +/−). If a unit
    // isn't known yet (meter not live), allow it — recompute validates per tick.
    if (a !== undefined && b !== undefined && !deriveUnit(cfg.op, a, b).ok) return null;
    const entry: DerivedEntry = {
      id: nextChannelId('derived'),
      label: cfg.label,
      op: cfg.op,
      aChannelId: cfg.aChannelId,
      bChannelId: cfg.bChannelId,
      reading: null,
      stale: true,
    };
    this.derivedList.push(entry);
    this.recomputeDerived(entry, Date.now());
    this.emit();
    return entry.id;
  };

  removeDerived = (id: string): void => {
    this.derivedList = this.derivedList.filter(d => d.id !== id);
    this.emit();
  };

  /** Release every backing session + listeners (call from the binding's unmount cleanup). */
  dispose = (): void => {
    for (const m of this.meters) {
      m.unsubscribe();
      m.session.dispose();
    }
    this.meters = [];
    this.derivedList = [];
    this.listeners.clear();
    this.disposed = true;
  };

  /**
   * Re-bootstrap after a dispose() (no-op if still live). Call from the binding's effect *setup*:
   * under React StrictMode the throwaway cleanup disposes this singleton, leaving meterSession()
   * with nothing to find (so connect() silently no-ops); reviving here restores the channels on the
   * real mount. A fresh, never-disposed session skips this entirely.
   */
  revive = (): void => {
    if (!this.disposed) return;
    this.disposed = false;
    this.bootstrap();
    this.emit();
  };
}
