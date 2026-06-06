// FrameParser: the buffered framing must survive split/coalesced notifications and
// resync after garbage — "one notification != one frame" (PROTOCOL §1, PLAN §4).
import { describe, it, expect } from 'vitest';
import { FrameParser, checksumOk } from './protocol';

const hex = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));

const DCV = hex('ab cd 10 02 30 20 2d 31 2e 33 32 35 00 00 00 00 00 03 00'); // 19 bytes
const HZ = hex('ab cd 10 04 30 20 20 30 2e 30 30 30 00 00 00 00 08 02 f2'); // 19 bytes
const NAME = hex('ab cd 08 55 54 36 30 42 54 03 25'); // 11-byte control frame

describe('FrameParser', () => {
  it('parses one whole frame in one chunk', () => {
    const p = new FrameParser();
    const out = p.push(DCV);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('measurement');
    expect(out[0].bytes).toEqual(DCV);
  });

  it('coalesced: two frames in a single chunk', () => {
    const p = new FrameParser();
    const out = p.push(concat(DCV, HZ));
    expect(out.map((f) => f.kind)).toEqual(['measurement', 'measurement']);
    expect(out[1].bytes).toEqual(HZ);
  });

  it('split: a frame delivered one byte at a time', () => {
    const p = new FrameParser();
    let total = 0;
    for (let i = 0; i < DCV.length; i++) {
      total += p.push(DCV.subarray(i, i + 1)).length;
    }
    expect(total).toBe(1); // emitted exactly once, on the final byte
  });

  it('split mid-frame across two chunks', () => {
    const p = new FrameParser();
    expect(p.push(DCV.subarray(0, 9))).toHaveLength(0);
    const out = p.push(DCV.subarray(9));
    expect(out).toHaveLength(1);
    expect(out[0].bytes).toEqual(DCV);
  });

  it('classifies an 11-byte name frame as control, not measurement', () => {
    const p = new FrameParser();
    const out = p.push(NAME);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('control');
  });

  it('resyncs past leading garbage', () => {
    const p = new FrameParser();
    const out = p.push(concat(hex('00 11 22 ab'), DCV.subarray(1)));
    // garbage + a stray AB then the real frame minus its AB — parser should find the
    // real AB CD boundary and recover one frame.
    expect(out.map((f) => f.kind)).toEqual(['measurement']);
  });

  it('rejects a corrupted frame (bad checksum) and recovers on the next good one', () => {
    const p = new FrameParser();
    const bad = DCV.slice();
    bad[7] ^= 0xff; // flip a payload byte → checksum fails
    expect(checksumOk(bad)).toBe(false);
    // The corrupted 19 bytes get resynced byte-by-byte; the following good frame parses.
    const out = p.push(concat(bad, HZ));
    expect(out.some((f) => f.bytes.length === 19 && checksumOk(f.bytes))).toBe(true);
    expect(out.at(-1)!.bytes).toEqual(HZ);
  });

  it('reset clears partial buffer state', () => {
    const p = new FrameParser();
    p.push(DCV.subarray(0, 9));
    p.reset();
    const out = p.push(DCV);
    expect(out).toHaveLength(1);
  });
});

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
