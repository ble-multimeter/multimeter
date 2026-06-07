// Fixture test for the Voltcraft driver. Frames are the synthetic captures from the source
// Windows app's `TestData(dev_type == 9, …)` in Utilities.cs (the dev index dispatched to
// VoltcraftDecode). Expected values were computed by re-deriving the source's VoltcraftDecode
// math from those exact bytes — so this is a faithful round-trip of the ported decoder, not a
// hardware capture (verification: 'ported-unverified'). See drivers/voltcraft.ts.
import { describe, it, expect } from 'vitest';
import { decodeVoltcraft, voltcraft, looksLikeVoltcraftFrame } from './voltcraft';

const FRAMES: {
  bytes: number[];
  note: string;
  text: string;
  unit: string;
  acdc: string;
  overload: boolean;
  fn: string;
}[] = [
  {
    bytes: [36, 0, 240, 33, 21, 0, 161, 9, 240, 33, 21, 0, 4, 0, 0],
    note: '0.5409 V DC',
    text: '0.5409',
    unit: 'V',
    acdc: 'DC',
    overload: false,
    fn: 'DCV',
  },
  {
    bytes: [96, 16, 240, 0, 0, 0, 162, 25, 240, 0, 0, 0, 4, 0, 0],
    note: '00000 V AC (sec display active)',
    text: '00000',
    unit: 'V',
    acdc: 'AC',
    overload: false,
    fn: 'ACV',
  },
  {
    bytes: [98, 16, 240, 41, 0, 0, 162, 25, 240, 0, 0, 0, 4, 0, 0],
    note: '000.41 V AC',
    text: '000.41',
    unit: 'V',
    acdc: 'AC',
    overload: false,
    fn: 'ACV',
  },
  {
    bytes: [26, 0, 240, 63, 211, 0, 162, 9, 240, 0, 0, 0, 4, 0, 0],
    note: '540.79 mV DC',
    text: '540.79',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    fn: 'DCV',
  },
  {
    bytes: [89, 16, 240, 59, 2, 0, 162, 25, 240, 0, 0, 0, 0, 0, 0],
    note: '0057.1 mV AC',
    text: '0057.1',
    unit: 'mV',
    acdc: 'AC',
    overload: false,
    fn: 'ACV',
  },
  {
    bytes: [47, 1, 240, 219, 42, 16, 162, 9, 240, 0, 0, 0, 4, 0, 0],
    note: 'O.L kΩ',
    text: 'O.L',
    unit: 'kΩ',
    acdc: '',
    overload: true,
    fn: 'OHM',
  },
  {
    bytes: [55, 1, 240, 143, 3, 16, 162, 9, 240, 0, 0, 0, 4, 0, 0],
    note: 'O.L MΩ',
    text: 'O.L',
    unit: 'MΩ',
    acdc: '',
    overload: true,
    fn: 'OHM',
  },
  {
    bytes: [225, 2, 240, 0, 0, 0, 162, 9, 240, 0, 0, 0, 0, 0, 0],
    note: '0000.0 Ω continuity',
    text: '0000.0',
    unit: 'Ω',
    acdc: '',
    overload: false,
    fn: 'CONT',
  },
  {
    bytes: [231, 2, 240, 175, 43, 16, 162, 9, 240, 0, 0, 0, 0, 0, 0],
    note: 'O.L Ω continuity',
    text: 'O.L',
    unit: 'Ω',
    acdc: '',
    overload: true,
    fn: 'CONT',
  },
  {
    bytes: [167, 2, 240, 2, 126, 16, 162, 9, 240, 0, 0, 0, 0, 0, 0],
    note: 'O.L V diode',
    text: 'O.L',
    unit: 'V',
    acdc: '',
    overload: true,
    fn: 'DIODE',
  },
  {
    bytes: [79, 1, 240, 255, 255, 23, 162, 9, 240, 0, 0, 0, 4, 0, 0],
    note: 'O.L nF',
    text: 'O.L',
    unit: 'nF',
    acdc: '',
    overload: true,
    fn: 'CAP',
  },
  {
    bytes: [76, 1, 240, 86, 3, 0, 162, 9, 240, 0, 0, 0, 4, 0, 0],
    note: '0.0854 nF',
    text: '0.0854',
    unit: 'nF',
    acdc: '',
    overload: false,
    fn: 'CAP',
  },
];

describe('voltcraft decode (synthetic frames from the source app TestData)', () => {
  for (const f of FRAMES) {
    it(`decodes: ${f.note}`, () => {
      const r = decodeVoltcraft(Uint8Array.from(f.bytes), 123);
      expect(r.displayText).toBe(f.text);
      expect(r.displayUnit).toBe(f.unit);
      expect(r.acdc).toBe(f.acdc);
      expect(r.overload).toBe(f.overload);
      expect(r.function).toBe(f.fn);
      expect(r.ts).toBe(123);
      if (/^-?\d*\.?\d+$/.test(f.text) && !f.overload) {
        expect(r.displayValue).toBeTypeOf('number');
      } else {
        expect(r.displayValue).toBeNull();
      }
    });
  }

  it('normalizes range prefixes into baseValue (mV → V)', () => {
    const r = decodeVoltcraft(
      Uint8Array.from([26, 0, 240, 63, 211, 0, 162, 9, 240, 0, 0, 0, 4, 0, 0]),
    );
    expect(r.displayText).toBe('540.79');
    expect(r.displayUnit).toBe('mV');
    expect(r.baseUnit).toBe('V');
    expect(r.baseValue).toBeCloseTo(0.54079, 9);
    expect(r.function).toBe('DCV');
  });

  it('flags overload and yields a null value (O.L kΩ)', () => {
    const r = decodeVoltcraft(
      Uint8Array.from([47, 1, 240, 219, 42, 16, 162, 9, 240, 0, 0, 0, 4, 0, 0]),
    );
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
  });

  it('reports a negative DC voltage (bit7 of byte 5)', () => {
    // 0.5409 V DC frame with the primary-negative bit set.
    const r = decodeVoltcraft(
      Uint8Array.from([36, 0, 240, 33, 21, 0x80, 161, 9, 240, 33, 21, 0, 4, 0, 0]),
    );
    expect(r.displayText).toBe('-0.5409');
    expect(r.displayValue).toBeCloseTo(-0.5409, 9);
    expect(r.acdc).toBe('DC');
  });

  it('decodes underload (U.L) from decimal-point sentinel 6', () => {
    // Force point field = 6 (underload): symbols low byte bits 0..2 = 110.
    // function 4 (Ω), scale 5 (k): symbols = (4<<6)|(5<<3)|6 = 302 = 0x12E → bytes [0x2E, 0x01].
    const r = decodeVoltcraft(
      Uint8Array.from([0x2e, 0x01, 240, 0, 0, 0, 162, 9, 240, 0, 0, 0, 0, 0, 0]),
    );
    expect(r.displayText).toBe('U.L');
    expect(r.displayValue).toBeNull();
    expect(r.displayUnit).toBe('kΩ');
  });

  it('degrades a short frame to a blank reading (never throws)', () => {
    const r = decodeVoltcraft(Uint8Array.from([36, 0, 240, 33, 21]), 7);
    expect(r.displayText).toBe('');
    expect(r.function).toBe('?');
    expect(r.ts).toBe(7);
  });

  it('populates every Reading field', () => {
    const r = decodeVoltcraft(
      Uint8Array.from([36, 0, 240, 33, 21, 0, 161, 9, 240, 33, 21, 0, 4, 0, 0]),
    );
    expect(Object.keys(r).sort()).toEqual(
      [
        'acdc',
        'bargraph',
        'baseUnit',
        'baseValue',
        'displayText',
        'displayUnit',
        'displayValue',
        'flags',
        'function',
        'overload',
        'ts',
      ].sort(),
    );
    expect(Object.keys(r.flags).sort()).toEqual(
      ['auto', 'hold', 'hvWarning', 'lowBattery', 'max', 'min', 'peakMax', 'peakMin', 'rel'].sort(),
    );
  });
});

describe('voltcraft sniffer (FFF0 collision discriminator)', () => {
  const FRAME = [36, 0, 240, 33, 21, 0, 161, 9, 240, 33, 21, 0, 4, 0, 0];

  it('accepts a real 15-byte voltcraft frame', () => {
    expect(looksLikeVoltcraftFrame(Uint8Array.from(FRAME))).toBe(true);
  });

  it('rejects an 11-byte bdm frame (too short)', () => {
    expect(
      looksLikeVoltcraftFrame(
        Uint8Array.from([27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59]),
      ),
    ).toBe(false);
  });

  it('rejects a 15-byte payload lacking the 0xF0 markers', () => {
    const bad = [...FRAME];
    bad[2] = 0x00;
    expect(looksLikeVoltcraftFrame(Uint8Array.from(bad))).toBe(false);
  });
});

describe('voltcraft framer (sync + split/coalesced notifications)', () => {
  const FRAME = [36, 0, 240, 33, 21, 0, 161, 9, 240, 33, 21, 0, 4, 0, 0];

  it('frames one notification == one frame', () => {
    const f = voltcraft.createFramer();
    const out = f.push(Uint8Array.from(FRAME));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('measurement');
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = voltcraft.createFramer();
    expect(f.push(Uint8Array.from(FRAME.slice(0, 6)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(FRAME.slice(6)));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = voltcraft.createFramer();
    const out = f.push(Uint8Array.from([...FRAME, ...FRAME]));
    expect(out).toHaveLength(2);
  });

  it('resyncs past leading garbage to the 0xF0 markers', () => {
    const f = voltcraft.createFramer();
    const out = f.push(Uint8Array.from([0x00, 0xff, ...FRAME]));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('reset clears buffered bytes', () => {
    const f = voltcraft.createFramer();
    f.push(Uint8Array.from(FRAME.slice(0, 6)));
    f.reset();
    expect(f.push(Uint8Array.from(FRAME.slice(6)))).toHaveLength(0);
  });
});

describe('voltcraft special displays (NCV) + driver wiring', () => {
  const FRAME = [36, 0, 240, 33, 21, 0, 161, 9, 240, 33, 21, 0, 4, 0, 0];

  // fn = (symbols>>6)&0x1f, symbols = bytes[1]<<8|bytes[0]. fn 13 (NCV): symbols = 13<<6 = 0x340
  // → bytes[0]=0x40, bytes[1]=0x03. count = bytes[4]<<8|bytes[3]. Markers at bytes[2]/bytes[8].
  it('renders an NCV strength bar of dashes (fn 13, count > 0) with no unit/value', () => {
    const r = decodeVoltcraft(
      Uint8Array.from([0x40, 0x03, 240, 3, 0, 0, 162, 9, 240, 0, 0, 0, 0, 0, 0]),
    );
    expect(r.displayText).toBe('---');
    expect(r.displayUnit).toBe('');
    expect(r.displayValue).toBeNull();
  });

  it('renders "EF" for NCV with no field (fn 13, count == 0)', () => {
    const r = decodeVoltcraft(
      Uint8Array.from([0x40, 0x03, 240, 0, 0, 0, 162, 9, 240, 0, 0, 0, 0, 0, 0]),
    );
    expect(r.displayText).toBe('EF');
    expect(r.displayValue).toBeNull();
  });

  it('returns a blank reading for an empty frame (never throws)', () => {
    const r = decodeVoltcraft(Uint8Array.from([]), 3);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
    expect(r.ts).toBe(3);
  });

  it('driver.decode delegates to decodeVoltcraft', () => {
    const r = voltcraft.decode(Uint8Array.from(FRAME), 21);
    expect(r.displayText).toBe('0.5409');
    expect(r.ts).toBe(21);
  });

  it('matches on the FFF0 service and VC/Voltcraft name prefixes', () => {
    expect(voltcraft.match({ services: ['0000fff0-0000-1000-8000-00805f9b34fb'] })).toBe(true);
    expect(voltcraft.match({ name: 'VC800' })).toBe(true);
    expect(voltcraft.match({ name: 'Voltcraft-X' })).toBe(true);
    expect(voltcraft.match({ name: 'Nope' })).toBe(false);
    expect(voltcraft.match({})).toBe(false);
  });

  it('sniffer cross-rejects the other FFF0 families', () => {
    const sniff = looksLikeVoltcraftFrame;
    expect(sniff(Uint8Array.from([34, 240, 4, 0, 103, 132]))).toBe(false); // owon-plus 6
    expect(sniff(Uint8Array.from([27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59]))).toBe(
      false,
    ); // bdm 11
    expect(sniff(Uint8Array.from([43, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10]))).toBe(
      false,
    ); // owon-old 14
    expect(sniff(Uint8Array.from([]))).toBe(false);
  });
});
