// decode.ts verified against the real Phase-0 captures (captures/phase0-captures.md).
// Every frame here came off the physical UT60BTk and passes its 16-bit checksum.
import { describe, it, expect } from 'vitest';
import { decode } from './decode';
import { checksumOk } from './framing';

const hex = (s: string) =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((h) => parseInt(h, 16)),
  );

interface Fix {
  name: string;
  hex: string;
  fn: string;
  unit: string;
  baseUnit: string;
  value: number | null; // displayValue
  base: number | null; // baseValue
  acdc: 'AC' | 'DC' | '';
  overload: boolean;
}

const FIXTURES: Fix[] = [
  {
    name: 'ACV r0',
    hex: 'ab cd 10 00 30 20 20 32 37 34 2e 37 00 00 00 00 08 03 02',
    fn: 'ACV',
    unit: 'V',
    baseUnit: 'V',
    value: 274.7,
    base: 274.7,
    acdc: 'AC',
    overload: false,
  },
  {
    name: 'ACV r1',
    hex: 'ab cd 10 00 31 20 20 30 2e 32 31 39 00 00 00 04 08 02 ff',
    fn: 'ACV',
    unit: 'V',
    baseUnit: 'V',
    value: 0.219,
    base: 0.219,
    acdc: 'AC',
    overload: false,
  },
  {
    name: 'ACV r2',
    hex: 'ab cd 10 00 32 20 20 20 30 2e 32 36 00 00 00 04 08 02 ec',
    fn: 'ACV',
    unit: 'V',
    baseUnit: 'V',
    value: 0.26,
    base: 0.26,
    acdc: 'AC',
    overload: false,
  },
  {
    name: 'ACV r3',
    hex: 'ab cd 10 00 33 20 20 20 20 31 2e 34 00 00 00 04 08 02 da',
    fn: 'ACV',
    unit: 'V',
    baseUnit: 'V',
    value: 1.4,
    base: 1.4,
    acdc: 'AC',
    overload: false,
  },
  {
    name: 'DCV r0',
    hex: 'ab cd 10 02 30 20 2d 31 2e 33 32 35 00 00 00 00 00 03 00',
    fn: 'DCV',
    unit: 'V',
    baseUnit: 'V',
    value: -1.325,
    base: -1.325,
    acdc: 'DC',
    overload: false,
  },
  {
    name: 'DCV r1',
    hex: 'ab cd 10 02 31 20 2d 30 2e 30 30 31 00 00 00 04 00 02 fb',
    fn: 'DCV',
    unit: 'V',
    baseUnit: 'V',
    value: -0.001,
    base: -0.001,
    acdc: 'DC',
    overload: false,
  },
  {
    name: 'DCV r2',
    hex: 'ab cd 10 02 32 20 20 20 30 2e 30 30 00 00 00 04 00 02 de',
    fn: 'DCV',
    unit: 'V',
    baseUnit: 'V',
    value: 0,
    base: 0,
    acdc: 'DC',
    overload: false,
  },
  {
    name: 'DCV r3',
    hex: 'ab cd 10 02 33 20 20 20 20 30 2e 30 00 00 00 04 00 02 cf',
    fn: 'DCV',
    unit: 'V',
    baseUnit: 'V',
    value: 0,
    base: 0,
    acdc: 'DC',
    overload: false,
  },
  {
    name: 'DCmV r1',
    hex: 'ab cd 10 03 31 20 20 33 32 2e 34 32 00 00 00 00 00 02 f5',
    fn: 'DCmV',
    unit: 'mV',
    baseUnit: 'V',
    value: 32.42,
    base: 0.03242,
    acdc: 'DC',
    overload: false,
  },
  {
    name: 'Hz r0',
    hex: 'ab cd 10 04 30 20 20 30 2e 30 30 30 00 00 00 00 08 02 f2',
    fn: 'Hz',
    unit: 'Hz',
    baseUnit: 'Hz',
    value: 0,
    base: 0,
    acdc: '',
    overload: false,
  },
  {
    name: 'OHM r0 OL',
    hex: 'ab cd 10 06 30 20 20 20 4f 4c 2e 20 00 00 00 00 00 03 07',
    fn: 'OHM',
    unit: 'Ω',
    baseUnit: 'Ω',
    value: null,
    base: null,
    acdc: '',
    overload: true,
  },
  {
    name: 'OHM r5 OL',
    hex: 'ab cd 10 06 35 20 20 20 4f 2e 4c 20 00 00 00 00 00 03 0c',
    fn: 'OHM',
    unit: 'MΩ',
    baseUnit: 'Ω',
    value: null,
    base: null,
    acdc: '',
    overload: true,
  },
  {
    name: 'CONT r0 OL',
    hex: 'ab cd 10 07 30 20 20 20 4f 4c 2e 20 00 00 00 04 00 03 0c',
    fn: 'CONT',
    unit: 'Ω',
    baseUnit: 'Ω',
    value: null,
    base: null,
    acdc: '',
    overload: true,
  },
  {
    name: 'DIODE r1 OL',
    hex: 'ab cd 10 08 31 20 20 2e 4f 4c 20 20 00 00 00 04 00 03 0e',
    fn: 'DIODE',
    unit: 'V',
    baseUnit: 'V',
    value: null,
    base: null,
    acdc: '',
    overload: true,
  },
  {
    name: 'CAP r0',
    hex: 'ab cd 10 09 30 20 20 30 2e 30 31 31 00 00 00 00 00 02 f1',
    fn: 'CAP',
    unit: 'nF',
    baseUnit: 'F',
    value: 0.011,
    base: 1.1e-11,
    acdc: '',
    overload: false,
  },
  {
    name: 'CAP r1 OL',
    hex: 'ab cd 10 09 31 20 20 2e 4f 4c 20 20 00 00 00 00 00 03 0b',
    fn: 'CAP',
    unit: 'nF',
    baseUnit: 'F',
    value: null,
    base: null,
    acdc: '',
    overload: true,
  },
  {
    name: '°C r0',
    hex: 'ab cd 10 0a 30 20 20 20 20 20 30 20 00 00 00 04 00 02 b6',
    fn: '°C',
    unit: '°C',
    baseUnit: '°C',
    value: 0,
    base: 0,
    acdc: '',
    overload: false,
  },
  {
    name: '°C r0 OL',
    hex: 'ab cd 10 0a 30 20 20 20 4f 4c 20 20 00 00 00 04 00 03 01',
    fn: '°C',
    unit: '°C',
    baseUnit: '°C',
    value: null,
    base: null,
    acdc: '',
    overload: true,
  },
  {
    name: 'DCµA r0',
    hex: 'ab cd 10 0c 30 20 20 20 20 30 2e 30 00 00 00 04 00 02 d6',
    fn: 'DCuA',
    unit: 'µA',
    baseUnit: 'A',
    value: 0,
    base: 0,
    acdc: 'DC',
    overload: false,
  },
  {
    name: 'DCmA r0',
    hex: 'ab cd 10 0e 30 20 20 20 20 30 2e 30 00 00 00 00 00 02 d4',
    fn: 'DCmA',
    unit: 'mA',
    baseUnit: 'A',
    value: 0,
    base: 0,
    acdc: 'DC',
    overload: false,
  },
  {
    name: 'NCV EFLO',
    hex: 'ab cd 10 14 30 20 20 45 46 4c 4f 20 00 00 00 04 08 03 5e',
    fn: 'NCV',
    unit: '',
    baseUnit: '',
    value: null,
    base: null,
    acdc: '',
    overload: false,
  },
  {
    name: 'NCV bar',
    hex: 'ab cd 10 14 30 20 20 20 20 20 2d 20 00 00 00 04 08 02 c5',
    fn: 'NCV',
    unit: '',
    baseUnit: '',
    value: null,
    base: null,
    acdc: '',
    overload: false,
  },
];

describe('checksum', () => {
  it.each(FIXTURES)('$name passes its 16-bit checksum', (f) => {
    expect(checksumOk(hex(f.hex))).toBe(true);
  });
});

describe('decode', () => {
  it.each(FIXTURES)('$name → value/unit/acdc/overload', (f) => {
    const r = decode(hex(f.hex), 1000);
    expect(r.function).toBe(f.fn);
    expect(r.displayUnit).toBe(f.unit);
    expect(r.baseUnit).toBe(f.baseUnit);
    expect(r.acdc).toBe(f.acdc);
    expect(r.overload).toBe(f.overload);

    if (f.value === null) expect(r.displayValue).toBeNull();
    else expect(r.displayValue).toBeCloseTo(f.value, 10);

    if (f.base === null) expect(r.baseValue).toBeNull();
    else expect(r.baseValue).toBeCloseTo(f.base, 15);

    expect(r.ts).toBe(1000);
  });
});

describe('flags', () => {
  it('reads autorange-off (flags B bit2) as auto=false', () => {
    // ACV r1 has flags B = 0x04 (manual range)
    const manual = decode(hex(FIXTURES[1].hex));
    expect(manual.flags.auto).toBe(false);
    // ACV r0 has flags B = 0x00 (autoranging)
    const auto = decode(hex(FIXTURES[0].hex));
    expect(auto.flags.auto).toBe(true);
  });
});

describe('graceful degradation', () => {
  it('unknown function code → "#n" + "?" unit, never throws', () => {
    // function code 0x1f (31) is past the table; keep a valid 19-byte length.
    const bytes = hex('ab cd 10 1f 30 20 20 20 31 2e 32 33 00 00 00 00 00 00 00');
    const r = decode(bytes);
    expect(r.function).toBe('#31');
    expect(r.displayUnit).toBe('?');
    expect(r.displayText).toBe('1.23');
  });

  it('non-measurement length → blank reading, never throws', () => {
    const r = decode(hex('ab cd 08 55 54 36 30 42 54 03 25'));
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });
});

describe('extended function codes (other UT-series models, ported/unverified)', () => {
  // Reuse a real ACV frame layout and re-tag the function/range bytes. These codes never came
  // off our UT60BT, so we assert only the table lookup (label + unit), not hardware behavior.
  const base = 'ab cd 10 00 30 20 20 32 37 34 2e 37 00 00 00 00 08 03 02';
  const retag = (fn: number, range = 0x30) => {
    const b = hex(base);
    b[3] = fn;
    b[4] = range;
    return b;
  };

  it('code 25 → AC/DC voltage in V', () => {
    const r = decode(retag(25));
    expect(r.function).toBe('AC/DC');
    expect(r.displayUnit).toBe('V');
    expect(r.baseUnit).toBe('V');
  });

  it('code 27 → AC+DC current in A', () => {
    const r = decode(retag(27, 0x31));
    expect(r.function).toBe('AC+DC');
    expect(r.displayUnit).toBe('A');
  });

  it('code 30 → INRUSH in V', () => {
    const r = decode(retag(30));
    expect(r.function).toBe('INRUSH');
    expect(r.displayUnit).toBe('V');
  });
});
