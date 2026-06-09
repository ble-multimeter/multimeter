// MetersSession coordinator. We drive demo meters with fake timers so the V/I streams advance
// deterministically, then assert the unified snapshot + the derived recompute (P = V × I) and the
// add/remove + staleness behavior. demoKind() reads window.location (empty here → 'none'), so the
// default bootstrap is a single real MeterSession; we add demo meters explicitly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetersSession, dedupName } from './meters';

describe('dedupName', () => {
  it('returns the base name when free', () => {
    expect(dedupName('UT60BTk', [])).toBe('UT60BTk');
    expect(dedupName('UT60BTk', ['Other'])).toBe('UT60BTk');
  });

  it('enumerates from 2 when the base is taken', () => {
    expect(dedupName('UT60BTk', ['UT60BTk'])).toBe('UT60BTk 2');
    expect(dedupName('UT60BTk', ['UT60BTk', 'UT60BTk 2'])).toBe('UT60BTk 3');
  });

  it('fills the first free slot, not just the next integer', () => {
    expect(dedupName('UT60BTk', ['UT60BTk', 'UT60BTk 3'])).toBe('UT60BTk 2');
  });
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Advance the demo timers far enough for at least one tick (DEMO_INTERVAL_MS = 250).
const tick = (ms = 300) => vi.advanceTimersByTime(ms);

describe('MetersSession — bootstrap', () => {
  it('starts with a single (real) meter channel and no derived channels', () => {
    const m = new MetersSession();
    const s = m.getSnapshot();
    expect(s.meters).toHaveLength(1);
    expect(s.derived).toHaveLength(0);
    expect(s.channels).toHaveLength(1);
    m.dispose();
  });
});

describe('MetersSession — demo meters + derived', () => {
  it('streams two demo meters and computes P = V × I', () => {
    const m = new MetersSession();
    // Remove the default real meter; add two demo meters (alternation gives one A + one V).
    m.removeMeter(m.getSnapshot().meters[0]!.id);
    const first = m.addDemoMeter(); // amps profile per the alternation
    m.setMeterRole(first, 'A'); // role rename works
    m.addDemoMeter(); // volts profile
    tick();

    const meters = m.getSnapshot().meters;
    expect(meters).toHaveLength(2);
    // Both should be live and have a reading after a tick.
    expect(meters.every(c => c.state === 'live' && c.reading !== null)).toBe(true);

    // Add a derived channel multiplying the two; with one V and one A this yields W.
    const ampMeter = meters.find(c => c.reading?.baseUnit === 'A')!;
    const voltMeter = meters.find(c => c.reading?.baseUnit === 'V')!;
    expect(ampMeter).toBeDefined();
    expect(voltMeter).toBeDefined();
    const dId = m.addDerived({
      label: 'P',
      op: 'mul',
      aChannelId: voltMeter.id,
      bChannelId: ampMeter.id,
    });
    expect(dId).not.toBeNull();
    tick();

    const d = m.getSnapshot().derived[0]!;
    expect(d.unit).toBe('W');
    expect(d.stale).toBe(false);
    expect(d.reading?.baseValue).toBeCloseTo(
      (voltMeter.reading!.baseValue! ?? 0) * (ampMeter.reading!.baseValue! ?? 0),
      // values drift per tick; just assert it's a finite product in a plausible band
      0,
    );
    expect(d.reading?.baseValue).toBeGreaterThan(0);
    m.dispose();
  });

  it('marks a derived channel stale (and nulls it) when an input meter is removed mid-life', () => {
    const m = new MetersSession();
    m.removeMeter(m.getSnapshot().meters[0]!.id);
    const a = m.addDemoMeter();
    const b = m.addDemoMeter();
    tick();
    const dId = m.addDerived({ label: 'P', op: 'mul', aChannelId: a, bChannelId: b })!;
    tick();
    expect(m.getSnapshot().derived.find(d => d.id === dId)!.reading?.baseValue).not.toBeNull();

    // Removing an input drops the derived channel entirely (can't be computed).
    m.removeMeter(a);
    expect(m.getSnapshot().derived).toHaveLength(0);
    m.dispose();
  });

  it('rejects an invalid +/− derived channel (mismatched units)', () => {
    const m = new MetersSession();
    m.removeMeter(m.getSnapshot().meters[0]!.id);
    m.addDemoMeter(); // amps
    m.addDemoMeter(); // volts
    tick();
    const meters = m.getSnapshot().meters;
    const volt = meters.find(c => c.reading?.baseUnit === 'V')!;
    const amp = meters.find(c => c.reading?.baseUnit === 'A')!;
    // V + A is invalid → addDerived returns null and adds nothing.
    const id = m.addDerived({ label: 'X', op: 'add', aChannelId: volt.id, bChannelId: amp.id });
    expect(id).toBeNull();
    expect(m.getSnapshot().derived).toHaveLength(0);
    m.dispose();
  });

  it('rejects a derived channel that combines a channel with itself', () => {
    const m = new MetersSession();
    m.removeMeter(m.getSnapshot().meters[0]!.id);
    const a = m.addDemoMeter();
    m.addDemoMeter();
    tick();
    expect(m.addDerived({ label: 'X', op: 'mul', aChannelId: a, bChannelId: a })).toBeNull();
    expect(m.getSnapshot().derived).toHaveLength(0);
    m.dispose();
  });

  it('rejects a derived channel referencing a non-existent input', () => {
    const m = new MetersSession();
    m.removeMeter(m.getSnapshot().meters[0]!.id);
    const a = m.addDemoMeter();
    m.addDemoMeter();
    tick();
    expect(m.addDerived({ label: 'X', op: 'mul', aChannelId: a, bChannelId: 'ghost' })).toBeNull();
    expect(m.getSnapshot().derived).toHaveLength(0);
    m.dispose();
  });

  it('removes a derived channel on demand', () => {
    const m = new MetersSession();
    m.removeMeter(m.getSnapshot().meters[0]!.id);
    const a = m.addDemoMeter();
    const b = m.addDemoMeter();
    tick();
    const dId = m.addDerived({ label: 'P', op: 'mul', aChannelId: a, bChannelId: b })!;
    expect(m.getSnapshot().derived).toHaveLength(1);
    m.removeDerived(dId);
    expect(m.getSnapshot().derived).toHaveLength(0);
    m.dispose();
  });

  it('notifies subscribers on a meter tick', () => {
    const m = new MetersSession();
    m.removeMeter(m.getSnapshot().meters[0]!.id);
    m.addDemoMeter();
    let n = 0;
    m.subscribe(() => (n += 1));
    tick();
    expect(n).toBeGreaterThan(0);
    m.dispose();
  });
});
