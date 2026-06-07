// AUTO-GENERATED fixture test. Frames + expected values are the 36 annotated captures from
// the source app's `Binary raw data.md` (BDM dev_type-0, 11-byte frames). See drivers/bdm.ts.
import { describe, it, expect } from 'vitest';
import { decodeBdm, bdm } from './bdm';

const FRAMES: {
  bytes: number[];
  note: string;
  text: string;
  unit: string;
  acdc: string;
  overload: boolean;
  hold: boolean;
  rel: boolean;
  auto: boolean;
}[] = [
  {
    bytes: [27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59],
    note: '07.27 ^',
    text: '07.27',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 73, 158, 188, 126, 102, 172, 59],
    note: '08.43',
    text: '08.43',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 105, 62, 185, 126, 102, 172, 59],
    note: '09.03',
    text: '09.03',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 72, 26, 213, 118, 102, 172, 59],
    note: '10.56',
    text: '10.56',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 241, 79, 58, 61, 123, 102, 172, 59],
    note: '20.81',
    text: '20.81',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 209, 77, 90, 216, 126, 102, 172, 59],
    note: '30.78',
    text: '30.78',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 17, 76, 58, 213, 122, 102, 172, 59],
    note: '40.60',
    text: '40.60',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 145, 69, 218, 216, 122, 102, 172, 59],
    note: '50.10',
    text: '50.10',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 69, 154, 252, 118, 102, 172, 59],
    note: '60.45',
    text: '60.45',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 89, 42, 217, 122, 102, 250, 58],
    note: '0.000 v auto dc ble',
    text: '0.000',
    unit: 'V',
    acdc: 'DC',
    overload: false,
    hold: false,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 179, 89, 42, 217, 122, 102, 250, 59],
    note: '0.000 v dc rel ble',
    text: '0.000',
    unit: 'V',
    acdc: 'DC',
    overload: false,
    hold: false,
    rel: true,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 89, 42, 217, 122, 110, 186, 58],
    note: '0.000 v auto ac truerms ble',
    text: '0.000',
    unit: 'V',
    acdc: 'AC',
    overload: false,
    hold: false,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 177, 140, 162, 23, 118, 102, 170, 59],
    note: 'big auto ble',
    text: 'AUTO',
    unit: '',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 73, 58, 57, 107, 102, 218, 58],
    note: '00.01 mV dc hold ble',
    text: '00.01',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    hold: true,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 177, 73, 106, 223, 38, 102, 170, 59],
    note: '0026 Cdeg hold ble',
    text: '0026',
    unit: '°C',
    acdc: '',
    overload: false,
    hold: true,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 73, 42, 221, 74, 102, 170, 59],
    note: '0080 Fdeg hold ble',
    text: '0080',
    unit: '°F',
    acdc: '',
    overload: false,
    hold: true,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 161, 73, 122, 223, 102, 102, 218, 58],
    note: '-00.26 mV dc hold ble (neg)',
    text: '-00.26',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    hold: true,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 81, 66, 186, 51, 113, 102, 160, 58],
    note: '0.L Mohm auto ble',
    text: '0.L',
    unit: 'MΩ',
    acdc: '',
    overload: true,
    hold: false,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 81, 66, 186, 51, 113, 102, 160, 59],
    note: '0.L Mohm ble',
    text: '0.L',
    unit: 'MΩ',
    acdc: '',
    overload: true,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 66, 170, 35, 113, 102, 168, 59],
    note: '0L. ohm',
    text: '0L.',
    unit: 'Ω',
    acdc: '',
    overload: true,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 66, 186, 51, 113, 102, 172, 59],
    note: '0.L Kohm',
    text: '0.L',
    unit: 'kΩ',
    acdc: '',
    overload: true,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 66, 170, 35, 113, 102, 172, 59],
    note: '0L. Kohm',
    text: '0L.',
    unit: 'kΩ',
    acdc: '',
    overload: true,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 89, 82, 170, 51, 241, 102, 186, 59],
    note: '.0L V dMode snd ble',
    text: '.0L',
    unit: 'V',
    acdc: '',
    overload: true,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 66, 36, 54, 113, 102, 170, 59],
    note: 'ef ble',
    text: 'EF',
    unit: '',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 166, 193, 50, 113, 102, 170, 59],
    note: '-*** bip ble',
    text: '-',
    unit: '',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 166, 197, 50, 113, 102, 170, 59],
    note: '--** bip ble',
    text: '--',
    unit: '',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 166, 197, 54, 113, 102, 170, 59],
    note: '---*',
    text: '---',
    unit: '',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 81, 166, 197, 54, 117, 102, 170, 59],
    note: '----',
    text: '----',
    unit: '',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 89, 42, 217, 122, 246, 170, 58],
    note: '0.000 nF auto ble',
    text: '0.000',
    unit: 'nF',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 177, 89, 42, 57, 123, 246, 170, 59],
    note: '0.001 nF ble',
    text: '0.001',
    unit: 'nF',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 89, 42, 217, 122, 102, 171, 58],
    note: '0.000 Hz auto ble',
    text: '0.000',
    unit: 'Hz',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 177, 73, 42, 201, 122, 98, 170, 59],
    note: '000.0 % ble',
    text: '000.0',
    unit: '%',
    acdc: '',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 89, 42, 217, 122, 102, 106, 58],
    note: '0.000 dc A auto ble',
    text: '0.000',
    unit: 'A',
    acdc: 'DC',
    overload: false,
    hold: false,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 177, 89, 42, 217, 122, 102, 106, 59],
    note: '0.000 dc a ble',
    text: '0.000',
    unit: 'A',
    acdc: 'DC',
    overload: false,
    hold: false,
    rel: false,
    auto: false,
  },
  {
    bytes: [27, 132, 112, 177, 73, 58, 217, 122, 102, 106, 50],
    note: '00.00 dc mA auto ble',
    text: '00.00',
    unit: 'mA',
    acdc: 'DC',
    overload: false,
    hold: false,
    rel: false,
    auto: true,
  },
  {
    bytes: [27, 132, 112, 177, 73, 42, 201, 122, 102, 106, 62],
    note: '000.0 dc uA auto ble',
    text: '000.0',
    unit: 'µA',
    acdc: 'DC',
    overload: false,
    hold: false,
    rel: false,
    auto: true,
  },
];

describe('bdm decode (real frames from the source app)', () => {
  for (const f of FRAMES) {
    it(`decodes: ${f.note}`, () => {
      const r = decodeBdm(Uint8Array.from(f.bytes), 123);
      expect(r.displayText).toBe(f.text);
      expect(r.displayUnit).toBe(f.unit);
      expect(r.acdc).toBe(f.acdc);
      expect(r.overload).toBe(f.overload);
      expect(r.flags.hold).toBe(f.hold);
      expect(r.flags.rel).toBe(f.rel);
      expect(r.flags.auto).toBe(f.auto);
      expect(r.ts).toBe(123);
      if (/^-?\d*\.?\d+$/.test(f.text) && !f.overload) {
        expect(r.displayValue).toBeTypeOf('number');
      } else {
        expect(r.displayValue).toBeNull();
      }
    });
  }

  it('normalizes range prefixes into baseValue (kΩ → Ω)', () => {
    const r = decodeBdm(Uint8Array.from([27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59]));
    expect(r.displayText).toBe('07.27');
    expect(r.displayUnit).toBe('kΩ');
    expect(r.baseUnit).toBe('Ω');
    expect(r.baseValue).toBeCloseTo(7270, 5);
    expect(r.function).toBe('OHM');
  });

  it('reports a millivolt DC reading normalized to volts', () => {
    const r = decodeBdm(Uint8Array.from([27, 132, 112, 177, 73, 58, 57, 107, 102, 218, 58]));
    expect(r.displayUnit).toBe('mV');
    expect(r.baseUnit).toBe('V');
    expect(r.acdc).toBe('DC');
    expect(r.function).toBe('DCV');
    expect(r.baseValue).toBeCloseTo(0.00001, 9);
  });

  it('flags overload and yields a null value (0.L MΩ)', () => {
    const r = decodeBdm(Uint8Array.from([27, 132, 112, 81, 66, 186, 51, 113, 102, 160, 58]));
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
  });
});

describe('bdm framer (sync + split/coalesced notifications)', () => {
  // A known-good 11-byte frame (the "07.27 kΩ" capture).
  const FRAME = [27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59];

  it('frames one notification == one frame', () => {
    const f = bdm.createFramer();
    const out = f.push(Uint8Array.from(FRAME));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('measurement');
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = bdm.createFramer();
    expect(f.push(Uint8Array.from(FRAME.slice(0, 5)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(FRAME.slice(5)));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = bdm.createFramer();
    const out = f.push(Uint8Array.from([...FRAME, ...FRAME]));
    expect(out).toHaveLength(2);
  });

  it('resyncs past leading garbage to the 0x1B 0x84 header', () => {
    const f = bdm.createFramer();
    const out = f.push(Uint8Array.from([0x00, 0xff, 0x1b, 0x00, ...FRAME]));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });
});
