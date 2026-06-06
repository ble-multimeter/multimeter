import { describe, it, expect } from 'vitest';
import { computeStats } from './stats';

describe('computeStats', () => {
  it('returns an empty result for no samples', () => {
    const s = computeStats([]);
    expect(s.count).toBe(0);
    expect(s.min).toBeNull();
    expect(s.avg).toBeNull();
    expect(s.p2p).toBeNull();
  });

  it('computes basic stats over numeric values', () => {
    const s = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.count).toBe(8);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.avg).toBe(5);
    expect(s.p2p).toBe(7);
    expect(s.stddev).toBeCloseTo(2, 10); // textbook population σ for this set
    expect(s.last).toBe(9);
  });

  it('counts nulls but excludes them from the math', () => {
    const s = computeStats([10, null, 20, null, 30]);
    expect(s.count).toBe(3);
    expect(s.nullCount).toBe(2);
    expect(s.avg).toBe(20);
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
    expect(s.last).toBe(30); // trailing nulls don't move `last`
  });

  it('reports nulls even when there are no numeric samples', () => {
    const s = computeStats([null, null]);
    expect(s.count).toBe(0);
    expect(s.nullCount).toBe(2);
    expect(s.avg).toBeNull();
  });

  it('handles a single value (stddev 0, p2p 0)', () => {
    const s = computeStats([42]);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.avg).toBe(42);
    expect(s.p2p).toBe(0);
    expect(s.stddev).toBe(0);
  });

  it('handles negative values', () => {
    const s = computeStats([-5, -1, -3]);
    expect(s.min).toBe(-5);
    expect(s.max).toBe(-1);
    expect(s.p2p).toBe(4);
  });
});
