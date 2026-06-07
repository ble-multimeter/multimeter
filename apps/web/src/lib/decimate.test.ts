import { describe, it, expect } from 'vitest';
import { decimate } from './decimate';
import type { Sample } from '../ble/types';

const mk = (vals: (number | null)[]): Sample[] => vals.map((v, i) => ({ t: i, v, seg: 0 }));

describe('decimate', () => {
  it('returns the series untouched when already under the cap', () => {
    const s = mk([1, 2, 3]);
    expect(decimate(s, 100)).toEqual(s);
  });

  it('honors the point cap (within the endpoint allowance)', () => {
    const s = mk(Array.from({ length: 10000 }, (_, i) => Math.sin(i / 50)));
    const out = decimate(s, 200);
    expect(out.length).toBeLessThanOrEqual(202);
    expect(out.length).toBeGreaterThan(50);
  });

  it('pins the exact first and last samples', () => {
    const s = mk(Array.from({ length: 1000 }, (_, i) => i));
    const out = decimate(s, 50);
    expect(out[0]).toEqual(s[0]);
    expect(out[out.length - 1]).toEqual(s[s.length - 1]);
  });

  it('keeps x (time) monotonically increasing', () => {
    const s = mk(Array.from({ length: 5000 }, (_, i) => Math.sin(i)));
    const out = decimate(s, 100);
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
  });

  it('preserves a transient spike that naive sampling would drop', () => {
    const vals = Array.from({ length: 2000 }, () => 1);
    vals[1234] = 999; // single-sample spike buried in flat data
    const out = decimate(mk(vals), 100);
    expect(out.some((s) => s.v === 999)).toBe(true);
  });

  it('preserves a multi-sample gap (OL region)', () => {
    const vals: (number | null)[] = Array.from({ length: 2000 }, () => 5);
    for (let i = 800; i < 1000; i++) vals[i] = null; // sustained overload
    const out = decimate(mk(vals), 100);
    expect(out.some((s) => s.v === null)).toBe(true);
  });
});
