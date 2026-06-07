// Fixture test for the owon-old (legacy OWON B35T) driver. Frames are real synthetic captures
// extracted from the source Windows app's `TestData(dev_type == 5, …)` in Utilities.cs — the
// branch dispatched to `b35tDecodeOld`. Expected values were computed by faithfully replaying
// that decoder. NOT bench-tested on hardware (driver verification: 'ported-unverified').
import { describe, it, expect } from 'vitest';
import { decodeOwonOld, looksLikeOwonOldFrame, owonOld } from './owon-old';

const FRAMES: {
  bytes: number[];
  note: string;
  text: string;
  unit: string;
  acdc: string;
  overload: boolean;
  auto: boolean;
  rel: boolean;
}[] = [
  {
    bytes: [43, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10],
    note: '274.6 mV DC auto',
    text: '274.6',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 50, 52, 50, 53, 32, 52, 49, 0, 64, 128, 24, 13, 10],
    note: '242.5 mV DC auto',
    text: '242.5',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 48, 48, 48, 50, 32, 50, 49, 0, 64, 128, 128, 13, 10],
    note: '00.02 mV DC auto',
    text: '00.02',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 48, 48, 48, 48, 32, 52, 20, 0, 64, 128, 0, 13, 10],
    note: '000.0 mV DC rel',
    text: '000.0',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    auto: false,
    rel: true,
  },
  {
    bytes: [43, 48, 48, 48, 48, 32, 48, 32, 0, 0, 32, 61, 13, 10],
    note: '0000 Ω auto',
    text: '0000',
    unit: 'Ω',
    acdc: '',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 48, 48, 48, 48, 32, 48, 48, 0, 0, 64, 61, 13, 10],
    note: '0000 A DC auto',
    text: '0000',
    unit: 'A',
    acdc: 'DC',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 48, 48, 48, 55, 32, 49, 41, 0, 0, 64, 0, 13, 10],
    note: '0.007 A AC auto',
    text: '0.007',
    unit: 'A',
    acdc: 'AC',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 48, 48, 48, 48, 32, 50, 32, 2, 0, 4, 61, 13, 10],
    note: '00.00 nF auto',
    text: '00.00',
    unit: 'nF',
    acdc: '',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 48, 48, 48, 48, 32, 49, 32, 0, 0, 8, 61, 13, 10],
    note: '0.000 Hz auto',
    text: '0.000',
    unit: 'Hz',
    acdc: '',
    overload: false,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 63, 48, 58, 63, 32, 49, 33, 0, 16, 32, 61, 13, 10],
    note: '.OL MΩ auto',
    text: '.OL',
    unit: 'MΩ',
    acdc: '',
    overload: true,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 63, 48, 58, 63, 32, 50, 33, 0, 32, 32, 61, 13, 10],
    note: 'O.L kΩ auto',
    text: 'O.L',
    unit: 'kΩ',
    acdc: '',
    overload: true,
    auto: true,
    rel: false,
  },
  {
    bytes: [43, 63, 48, 58, 63, 32, 52, 1, 0, 8, 32, 61, 13, 10],
    note: 'OL. Ω continuity',
    text: 'OL.',
    unit: 'Ω',
    acdc: '',
    overload: true,
    auto: false,
    rel: false,
  },
  {
    bytes: [43, 63, 48, 58, 63, 32, 48, 0, 0, 4, 128, 61, 13, 10],
    note: 'OL V diode',
    text: 'OL',
    unit: 'V',
    acdc: '',
    overload: true,
    auto: false,
    rel: false,
  },
];

describe('owon-old decode (real frames from the source app TestData dev_type==5)', () => {
  for (const f of FRAMES) {
    it(`decodes: ${f.note}`, () => {
      const r = decodeOwonOld(Uint8Array.from(f.bytes), 123);
      expect(r.displayText).toBe(f.text);
      expect(r.displayUnit).toBe(f.unit);
      expect(r.acdc).toBe(f.acdc);
      expect(r.overload).toBe(f.overload);
      expect(r.flags.auto).toBe(f.auto);
      expect(r.flags.rel).toBe(f.rel);
      expect(r.ts).toBe(123);
      if (/^-?\d*\.?\d+$/.test(f.text) && !f.overload) {
        expect(r.displayValue).toBeTypeOf('number');
      } else {
        expect(r.displayValue).toBeNull();
      }
    });
  }

  it('normalizes a millivolt DC reading to volts and derives DCV', () => {
    const r = decodeOwonOld(
      Uint8Array.from([43, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10]),
    );
    expect(r.displayUnit).toBe('mV');
    expect(r.baseUnit).toBe('V');
    expect(r.acdc).toBe('DC');
    expect(r.function).toBe('DCV');
    expect(r.baseValue).toBeCloseTo(0.2746, 9);
  });

  it('derives DIODE / CONT from byte 9 even while overloaded', () => {
    const diode = decodeOwonOld(
      Uint8Array.from([43, 63, 48, 58, 63, 32, 48, 0, 0, 4, 128, 61, 13, 10]),
    );
    expect(diode.function).toBe('DIODE');
    expect(diode.overload).toBe(true);
    const cont = decodeOwonOld(
      Uint8Array.from([43, 63, 48, 58, 63, 32, 52, 1, 0, 8, 32, 61, 13, 10]),
    );
    expect(cont.function).toBe('CONT');
  });

  it('flags overload and yields null values (.OL MΩ)', () => {
    const r = decodeOwonOld(
      Uint8Array.from([43, 63, 48, 58, 63, 32, 49, 33, 0, 16, 32, 61, 13, 10]),
    );
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
  });

  it('treats a negative sign and reports a number', () => {
    // Same as the 274.6 mV frame but with a '-' sign byte.
    const r = decodeOwonOld(
      Uint8Array.from([45, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10]),
    );
    expect(r.displayText).toBe('-274.6');
    expect(r.displayValue).toBeCloseTo(-274.6, 6);
  });

  it('returns a blank reading for a short frame (never throws)', () => {
    const r = decodeOwonOld(Uint8Array.from([43, 50, 55]));
    expect(r.function).toBe('?');
    expect(r.displayText).toBe('');
    expect(r.displayValue).toBeNull();
  });
});

describe('owon-old sniffer (looksLikeOwonOldFrame)', () => {
  const REAL = [43, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10];
  const OL = [43, 63, 48, 58, 63, 32, 49, 33, 0, 16, 32, 61, 13, 10];

  it('accepts a real owon-old frame', () => {
    expect(looksLikeOwonOldFrame(Uint8Array.from(REAL))).toBe(true);
  });

  it('accepts the OL sentinel frame ("?" digits)', () => {
    expect(looksLikeOwonOldFrame(Uint8Array.from(OL))).toBe(true);
  });

  it('rejects a bdm frame (11 bytes, 0x1B 0x84 header)', () => {
    expect(
      looksLikeOwonOldFrame(Uint8Array.from([27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59])),
    ).toBe(false);
  });

  it('rejects an owon-plus-style binary frame (no ASCII sign / space / CRLF)', () => {
    // A plausible owon-plus 6-ish-byte binary frame, padded to 14 — byte 0 not a sign.
    expect(
      looksLikeOwonOldFrame(
        Uint8Array.from([0x00, 0x80, 0x00, 0x00, 0x39, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe(false);
  });

  it('rejects a 14-byte frame missing the space at byte 5', () => {
    const bad = [...REAL];
    bad[5] = 0x39; // '9' instead of space
    expect(looksLikeOwonOldFrame(Uint8Array.from(bad))).toBe(false);
  });

  it('rejects a frame missing the CR LF terminator', () => {
    const bad = [...REAL];
    bad[13] = 0x00;
    expect(looksLikeOwonOldFrame(Uint8Array.from(bad))).toBe(false);
  });
});

describe('owon-old framer (sync + split/coalesced notifications)', () => {
  const FRAME = [43, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10];

  it('frames one notification == one frame', () => {
    const f = owonOld.createFramer();
    const out = f.push(Uint8Array.from(FRAME));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('measurement');
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = owonOld.createFramer();
    expect(f.push(Uint8Array.from(FRAME.slice(0, 6)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(FRAME.slice(6)));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = owonOld.createFramer();
    const out = f.push(Uint8Array.from([...FRAME, ...FRAME]));
    expect(out).toHaveLength(2);
  });

  it('resyncs past leading garbage to the ASCII sign', () => {
    const f = owonOld.createFramer();
    const out = f.push(Uint8Array.from([0x00, 0xff, 0x11, ...FRAME]));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });
});
