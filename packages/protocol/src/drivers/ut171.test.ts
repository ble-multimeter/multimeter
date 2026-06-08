// UT171 driver tests. Frames are SYNTHESIZED from the decode logic in the UNI-T Smart Measure
// app (no annotated hardware captures exist for UT171) and re-checksummed via the AB-CD builder.
// The spec's sample-vector frame bytes are reproduced; where the spec's stated checksum was
// internally inconsistent (vector 2: spec said 0x01D2, arithmetic gives 0x01BF) we use the
// arithmetically-correct frame and additionally assert the framer rejects the bad-checksum copy.
import { describe, it, expect } from 'vitest';
import {
  decodeUt171,
  checksumOk,
  looksLikeUt171Frame,
  ut171,
  UT171_COMMANDS,
  relSetCmd,
  rangeSetCmd,
  funcSetCmd,
  outputCmd,
} from './ut171';

const hex = (s: string): number[] =>
  s
    .trim()
    .split(/\s+/)
    .map(x => parseInt(x, 16));

describe('ut171 decode — spec sample vectors', () => {
  it('vector 1: DC volts 1.5000 V, AUTO range, not overloaded', () => {
    const f = hex('AB CD 0D 00 02 00 01 00 00 00 00 C0 3F 40 00 4F 01');
    const r = decodeUt171(Uint8Array.from(f), 42);
    expect(r.function).toBe('DCV');
    expect(r.acdc).toBe('DC');
    expect(r.displayUnit).toBe('V');
    expect(r.displayText).toBe('1.5000'); // dot = 4
    expect(r.displayValue).toBeCloseTo(1.5, 6);
    expect(r.baseUnit).toBe('V');
    expect(r.baseValue).toBeCloseTo(1.5, 6);
    expect(r.overload).toBe(false);
    expect(r.flags.auto).toBe(true);
    expect(r.flags.hold).toBe(false);
    expect(r.ts).toBe(42);
  });

  it('vector 2 (re-checksummed): resistance OVERLOAD, HOLD active, manual range', () => {
    // Spec bytes with corrected checksum 0x01BF (spec stated 0x01D2 in error).
    const f = hex('AB CD 0D 00 02 80 00 0F 02 00 00 80 7F 11 0F BF 01');
    const r = decodeUt171(Uint8Array.from(f), 7);
    expect(r.function).toBe('OHM');
    expect(r.displayUnit).toBe('Ω');
    expect(r.overload).toBe(true);
    expect(r.displayText).toBe('OL');
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
    expect(r.flags.hold).toBe(true);
    expect(r.flags.auto).toBe(false); // manual range
  });
});

describe('ut171 decode — unit + flag coverage', () => {
  it('AC volts (unit code 1)', () => {
    const r = decodeUt171(
      Uint8Array.from(hex('AB CD 0D 00 02 00 00 00 00 00 80 66 43 10 01 49 01')),
    );
    expect(r.function).toBe('ACV');
    expect(r.acdc).toBe('AC');
    expect(r.displayUnit).toBe('V');
    expect(r.displayValue).toBeCloseTo(230.5, 3);
  });

  it('millivolts DC normalize to volts in baseValue (unit code 3)', () => {
    const r = decodeUt171(
      Uint8Array.from(hex('AB CD 0D 00 02 00 00 00 00 A4 70 45 41 20 03 CC 01')),
    );
    expect(r.displayUnit).toBe('mV');
    expect(r.baseUnit).toBe('V');
    expect(r.acdc).toBe('DC');
    expect(r.function).toBe('DCV');
    expect(r.displayValue).toBeCloseTo(12.34, 3);
    expect(r.baseValue).toBeCloseTo(0.01234, 7);
  });

  it('negative overload shows -OL (OL nibble == 2)', () => {
    const r = decodeUt171(
      Uint8Array.from(hex('AB CD 0D 00 02 00 00 00 00 00 00 80 FF 02 00 90 01')),
    );
    expect(r.overload).toBe(true);
    expect(r.displayText).toBe('-OL');
    expect(r.displayValue).toBeNull();
  });

  it('HOLD + MAX flags decode together', () => {
    const r = decodeUt171(
      Uint8Array.from(hex('AB CD 0D 00 02 A0 00 00 00 00 00 A0 40 30 00 BF 01')),
    );
    expect(r.flags.hold).toBe(true);
    expect(r.flags.max).toBe(false); // flagB maxMode == 0 → neither max nor min flagged
    expect(r.displayValue).toBeCloseTo(5.0, 3);
  });

  it('kΩ resistance normalizes to Ω (unit code 16)', () => {
    const r = decodeUt171(
      Uint8Array.from(hex('AB CD 0D 00 02 00 01 0F 03 66 66 96 40 20 10 F4 01')),
    );
    expect(r.function).toBe('OHM');
    expect(r.displayUnit).toBe('kΩ');
    expect(r.baseUnit).toBe('Ω');
    expect(r.displayValue).toBeCloseTo(4.7, 3);
    expect(r.baseValue).toBeCloseTo(4700, 1);
  });

  it('OUTPUT/pulse mode (measureCode 29) reports frequency', () => {
    const r = decodeUt171(
      Uint8Array.from(
        hex('AB CD 14 00 02 00 00 1D 00 00 00 7A 44 00 00 48 42 64 00 00 00 01 E0 01'),
      ),
    );
    expect(r.function).toBe('Hz');
    expect(r.displayUnit).toBe('Hz');
    expect(r.displayValue).toBeCloseTo(1000, 3);
  });
});

describe('ut171 decode — never throws / graceful degradation', () => {
  it('returns a blank reading for a too-short frame', () => {
    const r = decodeUt171(Uint8Array.from([0xab, 0xcd, 0x03]), 9);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
    expect(r.ts).toBe(9);
  });

  it('returns a blank reading for an empty frame', () => {
    const r = decodeUt171(Uint8Array.from([]), 0);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });

  it('returns blank for a non-AB-CD frame', () => {
    const r = decodeUt171(Uint8Array.from([0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(r.function).toBe('?');
  });

  it('returns blank for a non-measurement command (cmd != 2)', () => {
    const f = hex('AB CD 0D 00 72 00 01 00 00 00 00 C0 3F 40 00 4F 01');
    const r = decodeUt171(Uint8Array.from(f));
    expect(r.function).toBe('?');
  });
});

describe('ut171 checksum + framer', () => {
  const FRAME = hex('AB CD 0D 00 02 00 01 00 00 00 00 C0 3F 40 00 4F 01');

  it('validates the little-endian checksum', () => {
    expect(checksumOk(Uint8Array.from(FRAME))).toBe(true);
    const bad = [...FRAME];
    bad[bad.length - 1] = (bad[bad.length - 1]! ^ 0xff) & 0xff;
    expect(checksumOk(Uint8Array.from(bad))).toBe(false);
  });

  it('frames one notification == one frame', () => {
    const fr = ut171.createFramer();
    const out = fr.push(Uint8Array.from(FRAME));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('measurement');
    expect([...out[0]!.bytes]).toEqual(FRAME);
  });

  it('reassembles a frame split across two notifications', () => {
    const fr = ut171.createFramer();
    expect(fr.push(Uint8Array.from(FRAME.slice(0, 6)))).toHaveLength(0);
    const out = fr.push(Uint8Array.from(FRAME.slice(6)));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(FRAME);
  });

  it('splits two coalesced frames in one notification', () => {
    const fr = ut171.createFramer();
    const out = fr.push(Uint8Array.from([...FRAME, ...FRAME]));
    expect(out).toHaveLength(2);
  });

  it('resyncs past leading garbage to AB CD', () => {
    const fr = ut171.createFramer();
    const out = fr.push(Uint8Array.from([0x00, 0xff, 0xab, 0x00, ...FRAME]));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(FRAME);
  });

  it('rejects a frame with a bad checksum (resyncs)', () => {
    const fr = ut171.createFramer();
    // The spec's vector-2 bytes carry the wrong checksum (0x01D2) → dropped, no frame emitted.
    const badV2 = hex('AB CD 0D 00 02 80 00 0F 02 00 00 80 7F 11 0F D2 01');
    expect(fr.push(Uint8Array.from(badV2))).toHaveLength(0);
  });

  it('reset clears buffered bytes', () => {
    const fr = ut171.createFramer();
    fr.push(Uint8Array.from(FRAME.slice(0, 6)));
    fr.reset();
    expect(fr.push(Uint8Array.from(FRAME.slice(6)))).toHaveLength(0);
  });
});

describe('ut171 sniff + driver wiring', () => {
  const FRAME = hex('AB CD 0D 00 02 00 01 00 00 00 00 C0 3F 40 00 4F 01');

  it('sniffer accepts a valid UT171 live frame', () => {
    expect(looksLikeUt171Frame(Uint8Array.from(FRAME))).toBe(true);
  });

  it('sniffer rejects a UT60BT/UT161 19-byte AB-CD frame (BE checksum / cmd != 2)', () => {
    // 19-byte UT60BT measurement frame shape — wrong length/cmd for UT171.
    const utbt = [
      0xab, 0xcd, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ];
    expect(looksLikeUt171Frame(Uint8Array.from(utbt))).toBe(false);
    expect(looksLikeUt171Frame(Uint8Array.from([]))).toBe(false);
    expect(looksLikeUt171Frame(Uint8Array.from([1, 2, 3]))).toBe(false);
  });

  it('matches on the UT171 / UT-D07A name prefixes only', () => {
    expect(ut171.match({ name: 'UT171C' })).toBe(true);
    expect(ut171.match({ name: 'UT-D07A' })).toBe(true);
    expect(ut171.match({ name: 'UT60BT' })).toBe(false);
    // Service alone must NOT match (shared ISSC service is routed by name).
    expect(ut171.match({ services: ['49535343-fe7d-4ae5-8fa9-9fafd205e455'] })).toBe(false);
    expect(ut171.match({})).toBe(false);
  });

  it('decode delegates to decodeUt171', () => {
    const r = ut171.decode(Uint8Array.from(FRAME), 99);
    expect(r.displayText).toBe('1.5000');
    expect(r.ts).toBe(99);
  });

  it('advertises ported-unverified + ISSC GATT profile', () => {
    expect(ut171.verification).toBe('ported-unverified');
    expect(ut171.gatt.service).toBe('49535343-fe7d-4ae5-8fa9-9fafd205e455');
    expect(ut171.gatt.write[0]).toBe('49535343-8841-43f4-a8d4-ecbe34729bb3');
  });
});

describe('ut171 control frames', () => {
  const bytes = (u: Uint8Array): number[] => [...u];

  it('matches the spec control-code frames exactly', () => {
    expect(bytes(UT171_COMMANDS.START)).toEqual(hex('AB CD 04 00 0A 01 16 00'));
    expect(bytes(UT171_COMMANDS.DEVICE_INFO)).toEqual(hex('AB CD 04 00 16 5A 7B 00'));
    expect(bytes(UT171_COMMANDS.HOLD)).toEqual(hex('AB CD 02 00 07 5A 63 00'));
    expect(bytes(UT171_COMMANDS.HZ_DUTY)).toEqual(hex('AB CD 02 00 03 5A 5F 00'));
    expect(bytes(UT171_COMMANDS.PEAK_ENTER)).toEqual(hex('AB CD 02 00 06 01 09 00'));
    expect(bytes(UT171_COMMANDS.PEAK_EXIT)).toEqual(hex('AB CD 02 00 06 00 08 00'));
    expect(bytes(UT171_COMMANDS.MAXMIN_ENTER)).toEqual(hex('AB CD 02 00 05 01 08 00'));
    expect(bytes(UT171_COMMANDS.MAXMIN_EXIT)).toEqual(hex('AB CD 02 00 05 00 07 00'));
    expect(bytes(UT171_COMMANDS.REL_EXIT)).toEqual(hex('AB CD 02 00 04 00 06 00'));
    expect(bytes(UT171_COMMANDS.RANGE)).toEqual(hex('AB CD 02 00 02 00 04 00'));
    expect(bytes(UT171_COMMANDS.SELECT)).toEqual(hex('AB CD 02 00 01 00 03 00'));
  });

  it('builds REL-set with a float32 value (v=0)', () => {
    expect(bytes(relSetCmd(0))).toEqual(hex('AB CD 06 00 04 01 00 00 00 00 0B 00'));
  });

  it('builds parameterized range/func frames', () => {
    expect(bytes(rangeSetCmd(0))).toEqual(hex('AB CD 02 00 02 00 04 00'));
    expect(bytes(funcSetCmd(0))).toEqual(hex('AB CD 02 00 01 00 03 00'));
  });

  it('builds an OUTPUT/pulse frame (cmd 20, freq+duty floats)', () => {
    const out = outputCmd(1000, 50);
    expect(out[4]).toBe(20);
    expect(checksumOk(out)).toBe(true);
    expect(out.length).toBe(4 + 1 + 8 + 2); // header + cmd + 2 floats + chk
  });

  it('exposes generic controls map', () => {
    expect(ut171.controls?.hold).toBeDefined();
    expect(ut171.controls?.maxMin).toBeDefined();
    expect([...ut171.controls!.hold!]).toEqual(hex('AB CD 02 00 07 5A 63 00'));
  });
});
