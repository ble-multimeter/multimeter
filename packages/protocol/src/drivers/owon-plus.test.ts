// Fixture test. Frames are REAL 6-byte captures extracted from the source app's
// `Utilities.cs` `TestData(dev_type = 6, …)` (the synthetic-but-real owon-plus frame set,
// dispatched to `owonPlusTypeDecode` for `isBDM == 2`). Expected values are computed from a
// faithful re-implementation of `owonPlusTypeDecode` and cross-checked by hand. See
// drivers/owon-plus.ts. ported-unverified: not bench-tested on physical hardware.
import { describe, it, expect } from 'vitest';
import { decodeOwonPlus, looksLikeOwonPlusFrame, owonPlus } from './owon-plus';

const FRAMES: {
  bytes: number[];
  note: string;
  text: string;
  unit: string;
  acdc: string;
  overload: boolean;
  func: string;
}[] = [
  {
    bytes: [34, 240, 4, 0, 103, 132],
    note: 'DC -11.27 V',
    text: '-11.27',
    unit: 'V',
    acdc: 'DC',
    overload: false,
    func: 'DCV',
  },
  {
    bytes: [25, 240, 4, 0, 0, 128],
    note: 'DC 000.0 mV',
    text: '000.0',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    func: 'DCV',
  },
  {
    bytes: [26, 240, 4, 0, 86, 133],
    note: 'DC -13.66 mV',
    text: '-13.66',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    func: 'DCV',
  },
  {
    bytes: [55, 241, 4, 0, 0, 0],
    note: 'OHM O.L MΩ',
    text: 'O.L',
    unit: 'MΩ',
    acdc: '',
    overload: true,
    func: 'OHM',
  },
  {
    bytes: [50, 241, 4, 0, 190, 8],
    note: 'OHM 22.38 MΩ',
    text: '22.38',
    unit: 'MΩ',
    acdc: '',
    overload: false,
    func: 'OHM',
  },
  {
    bytes: [41, 241, 4, 0, 50, 1],
    note: 'OHM 030.6 kΩ',
    text: '030.6',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    func: 'OHM',
  },
  {
    bytes: [167, 242, 0, 0, 0, 0],
    note: 'DIODE O.L V',
    text: 'O.L',
    unit: 'V',
    acdc: '',
    overload: true,
    func: 'DIODE',
  },
  {
    bytes: [231, 242, 0, 0, 0, 0],
    note: 'CONT O.L Ω',
    text: 'O.L',
    unit: 'Ω',
    acdc: '',
    overload: true,
    func: 'CONT',
  },
  {
    bytes: [225, 241, 0, 0, 242, 1],
    note: 'PERCENT 049.8 %',
    text: '049.8',
    unit: '%',
    acdc: '',
    overload: false,
    func: '%',
  },
  {
    bytes: [145, 240, 4, 0, 71, 1],
    note: 'DC 032.7 µA',
    text: '032.7',
    unit: 'µA',
    acdc: 'DC',
    overload: false,
    func: 'DCA',
  },
  {
    bytes: [154, 240, 4, 0, 0, 128],
    note: 'DC 00.00 mA',
    text: '00.00',
    unit: 'mA',
    acdc: 'DC',
    overload: false,
    func: 'DCA',
  },
  {
    bytes: [163, 240, 4, 0, 251, 129],
    note: 'DC -0.507 A',
    text: '-0.507',
    unit: 'A',
    acdc: 'DC',
    overload: false,
    func: 'DCA',
  },
  {
    bytes: [33, 18, 240, 249, 0, 0],
    note: 'TEMP 000.0 °C (hold/rel/auto)',
    text: '000.0',
    unit: '°C',
    acdc: '',
    overload: false,
    func: '°C',
  },
];

describe('owon-plus decode (real frames from the source app TestData dev_type 6)', () => {
  for (const f of FRAMES) {
    it(`decodes: ${f.note}`, () => {
      const r = decodeOwonPlus(Uint8Array.from(f.bytes), 123);
      expect(r.displayText).toBe(f.text);
      expect(r.displayUnit).toBe(f.unit);
      expect(r.acdc).toBe(f.acdc);
      expect(r.overload).toBe(f.overload);
      expect(r.function).toBe(f.func);
      expect(r.ts).toBe(123);
      if (/^-?\d*\.?\d+$/.test(f.text) && !f.overload) {
        expect(r.displayValue).toBeTypeOf('number');
      } else {
        expect(r.displayValue).toBeNull();
      }
    });
  }

  it('normalizes range prefixes into baseValue (MΩ → Ω)', () => {
    const r = decodeOwonPlus(Uint8Array.from([50, 241, 4, 0, 190, 8]));
    expect(r.displayText).toBe('22.38');
    expect(r.displayUnit).toBe('MΩ');
    expect(r.baseUnit).toBe('Ω');
    expect(r.baseValue).toBeCloseTo(22_380_000, 0);
    expect(r.function).toBe('OHM');
  });

  it('reports a millivolt DC reading normalized to volts', () => {
    const r = decodeOwonPlus(Uint8Array.from([26, 240, 4, 0, 86, 133]));
    expect(r.displayUnit).toBe('mV');
    expect(r.baseUnit).toBe('V');
    expect(r.acdc).toBe('DC');
    expect(r.function).toBe('DCV');
    expect(r.baseValue).toBeCloseTo(-0.01366, 9);
  });

  it('flags overload and yields a null value (O.L MΩ)', () => {
    const r = decodeOwonPlus(Uint8Array.from([55, 241, 4, 0, 0, 0]));
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
  });

  it('decodes the negative sign from measurement bit 15', () => {
    const r = decodeOwonPlus(Uint8Array.from([163, 240, 4, 0, 251, 129]));
    expect(r.displayText).toBe('-0.507');
    expect(r.displayValue).toBeCloseTo(-0.507, 6);
  });

  it('renders a "negative zero" (raw 0x8000) without a minus sign, like the source', () => {
    // [25,240,4,0,0,128]: measurement = 0x8000 → -1*(0x8000&0x7fff) = -0 → "0000" (no sign).
    const r = decodeOwonPlus(Uint8Array.from([25, 240, 4, 0, 0, 128]));
    expect(r.displayText).toBe('000.0');
  });

  it('surfaces the hold/rel/auto/bat/min mode flags (C# string-index order)', () => {
    // mode word data[3]<<8|data[2] = 0xF9F0 = 1111100111110000.
    // String-indexed mode[0..5] = 1,1,1,1,1,0 → hold/rel/auto/bat/min set, max clear.
    const r = decodeOwonPlus(Uint8Array.from([33, 18, 240, 249, 0, 0]));
    expect(r.flags.hold).toBe(true);
    expect(r.flags.rel).toBe(true);
    expect(r.flags.auto).toBe(true);
    expect(r.flags.lowBattery).toBe(true);
    expect(r.flags.min).toBe(true);
    expect(r.flags.max).toBe(false);
  });

  it('returns a blank reading on a short frame (never throws)', () => {
    const r = decodeOwonPlus(Uint8Array.from([1, 2, 3]));
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
    expect(r.overload).toBe(false);
  });
});

describe('owon-plus frame sniffer (looksLikeOwonPlusFrame)', () => {
  it('accepts a valid 6-byte owon-plus frame', () => {
    expect(looksLikeOwonPlusFrame(Uint8Array.from([34, 240, 4, 0, 103, 132]))).toBe(true);
  });

  it('rejects an 11-byte bdm frame (constant 0x1B 0x84 header)', () => {
    expect(
      looksLikeOwonPlusFrame(Uint8Array.from([27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59])),
    ).toBe(false);
  });

  it('rejects a 14-byte owon-old ASCII frame', () => {
    expect(
      looksLikeOwonPlusFrame(
        Uint8Array.from([43, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10]),
      ),
    ).toBe(false);
  });

  it('rejects a 15-byte voltcraft frame', () => {
    expect(
      looksLikeOwonPlusFrame(
        Uint8Array.from([36, 0, 240, 33, 21, 0, 161, 9, 240, 33, 21, 0, 4, 0, 0]),
      ),
    ).toBe(false);
  });

  it('rejects a 6-byte frame whose function nibble is unused (14/15)', () => {
    // symbols = data[1]<<8|data[0]; function = (symbols>>6)&0xf. Set function = 15.
    const symbols = 15 << 6;
    const lo = symbols & 0xff;
    const hi = (symbols >> 8) & 0xff;
    expect(looksLikeOwonPlusFrame(Uint8Array.from([lo, hi, 0, 0, 0, 0]))).toBe(false);
  });
});

describe('owon-plus framer (fixed 6-byte slicing + resync)', () => {
  const FRAME = [34, 240, 4, 0, 103, 132];

  it('frames one notification == one frame', () => {
    const f = owonPlus.createFramer();
    const out = f.push(Uint8Array.from(FRAME));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('measurement');
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = owonPlus.createFramer();
    expect(f.push(Uint8Array.from(FRAME.slice(0, 3)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(FRAME.slice(3)));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = owonPlus.createFramer();
    const out = f.push(Uint8Array.from([...FRAME, ...FRAME]));
    expect(out).toHaveLength(2);
  });

  it('buffers a trailing partial frame until the rest arrives', () => {
    const f = owonPlus.createFramer();
    const out1 = f.push(Uint8Array.from([...FRAME, FRAME[0], FRAME[1]]));
    expect(out1).toHaveLength(1);
    const out2 = f.push(Uint8Array.from(FRAME.slice(2)));
    expect(out2).toHaveLength(1);
    expect([...out2[0].bytes]).toEqual(FRAME);
  });

  it('reset clears buffered bytes', () => {
    const f = owonPlus.createFramer();
    f.push(Uint8Array.from(FRAME.slice(0, 3)));
    f.reset();
    expect(f.push(Uint8Array.from(FRAME.slice(3)))).toHaveLength(0);
  });
});

describe('owon-plus special displays (NCV / hFE) + driver wiring', () => {
  // function = (symbols>>6)&0xf, symbols = data[1]<<8|data[0].
  // fn 13 (NCV): symbols = 13<<6 = 0x340 → data[0]=0x40, data[1]=0x03. raw = data[5]<<8|data[4].
  it('renders an NCV strength bar of dashes (fn 13, raw > 0) with no value/unit', () => {
    const r = decodeOwonPlus(Uint8Array.from([0x40, 0x03, 0, 0, 3, 0]));
    expect(r.function).toBe('NCV');
    expect(r.displayText).toBe('---');
    expect(r.displayUnit).toBe('');
    expect(r.displayValue).toBeNull();
  });

  it('renders "EF" for NCV with no field (fn 13, raw == 0)', () => {
    const r = decodeOwonPlus(Uint8Array.from([0x40, 0x03, 0, 0, 0, 0]));
    expect(r.function).toBe('NCV');
    expect(r.displayText).toBe('EF');
    expect(r.displayValue).toBeNull();
  });

  it('reports hFE (fn 12) as a bare gain with no SI unit', () => {
    // fn 12: symbols = 12<<6 = 0x300 → data[0]=0x00, data[1]=0x03.
    const r = decodeOwonPlus(Uint8Array.from([0x00, 0x03, 0, 0, 100, 0]));
    expect(r.function).toBe('HFE');
    expect(r.displayUnit).toBe('');
  });

  it('returns a blank reading for an empty frame (never throws)', () => {
    const r = decodeOwonPlus(Uint8Array.from([]), 5);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
    expect(r.ts).toBe(5);
  });

  it('driver.decode delegates to decodeOwonPlus', () => {
    const r = owonPlus.decode(Uint8Array.from([34, 240, 4, 0, 103, 132]), 42);
    expect(r.displayText).toBe('-11.27');
    expect(r.ts).toBe(42);
  });

  it('matches on the FFF0 service and OWON/BDM name prefixes', () => {
    expect(owonPlus.match({ services: ['0000fff0-0000-1000-8000-00805f9b34fb'] })).toBe(true);
    expect(owonPlus.match({ name: 'OWON-B35' })).toBe(true);
    expect(owonPlus.match({ name: 'BDM' })).toBe(true);
    expect(owonPlus.match({ name: 'Nope' })).toBe(false);
    expect(owonPlus.match({})).toBe(false);
  });
});
