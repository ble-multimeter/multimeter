// Fixture test for the Voltcraft VC900-series (R10W) driver. The frames are the LIVE-VERIFIED R10W
// vectors: built from the worked examples in docs/protocols/voltcraft.md and cross-checked against
// the emulator-oracle decoder (fake-ble-meter `tests/decode_voltcraft.py`), which was itself
// confirmed byte-for-byte against the official Voltcraft app. So these expectations track the real
// meter, not a synthetic re-derivation of an unverified port. See drivers/voltcraft.ts.
//
// Frame builder mirrors the on-wire layout: five 24-bit LITTLE-endian words at byte offsets
// 0/3/6/9/12. gear word = decimals | prefix<<3 | gear<<6; value word = count | overrange<<20 |
// sign<<23; state word = LSB-numbered annunciator bitmask (HOLD=bit0).
import { describe, it, expect } from 'vitest';
import { decodeVoltcraft, voltcraft, looksLikeVoltcraftFrame } from './voltcraft';

const le24 = (w: number): number[] => [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff];

function frame(opts: {
  gear: number;
  prefix?: number;
  decimals?: number;
  count?: number;
  overrange?: number;
  sign?: boolean;
  state?: number;
}): number[] {
  const {
    gear,
    prefix = 4,
    decimals = 0,
    count = 0,
    overrange = 0,
    sign = false,
    state = 0,
  } = opts;
  const gearWord = (decimals & 7) | ((prefix & 7) << 3) | ((gear & 0x1f) << 6);
  const valueWord = (count & 0x7ffff) | ((overrange & 7) << 20) | (sign ? 1 << 23 : 0);
  return [...le24(gearWord), ...le24(valueWord), 0, 0, 0, 0, 0, 0, ...le24(state)];
}

const FRAMES: {
  bytes: number[];
  note: string;
  text: string;
  unit: string;
  acdc: string;
  overload: boolean;
  fn: string;
  value: number | null;
}[] = [
  {
    // Worked example from the protocol doc: 4.200 V DC = 23 00 00 68 10 00 …
    bytes: frame({ gear: 0, prefix: 4, decimals: 3, count: 4200 }),
    note: '4.200 V DC',
    text: '4.200',
    unit: 'V',
    acdc: 'DC',
    overload: false,
    fn: 'DCV',
    value: 4.2,
  },
  {
    bytes: frame({ gear: 1, prefix: 4, decimals: 1, count: 2305 }),
    note: '230.5 V AC',
    text: '230.5',
    unit: 'V',
    acdc: 'AC',
    overload: false,
    fn: 'ACV',
    value: 230.5,
  },
  {
    bytes: frame({ gear: 4, prefix: 6, decimals: 3, count: 1000 }),
    note: '1.000 MΩ',
    text: '1.000',
    unit: 'MΩ',
    acdc: '',
    overload: false,
    fn: 'OHM',
    value: 1.0,
  },
  {
    bytes: frame({ gear: 2, prefix: 2, decimals: 2, count: 1230 }),
    note: '12.30 µA DC',
    text: '12.30',
    unit: 'µA',
    acdc: 'DC',
    overload: false,
    fn: 'DCA',
    value: 12.3,
  },
  {
    bytes: frame({ gear: 0, prefix: 4, decimals: 3, count: 512, sign: true }),
    note: '-0.512 V DC',
    text: '-0.512',
    unit: 'V',
    acdc: 'DC',
    overload: false,
    fn: 'DCV',
    value: -0.512,
  },
  {
    bytes: frame({ gear: 1, prefix: 4, overrange: 1 }),
    note: 'OL (V AC)',
    text: 'OL',
    unit: 'V',
    acdc: 'AC',
    overload: true,
    fn: 'ACV',
    value: null,
  },
  {
    bytes: frame({ gear: 4, prefix: 5, overrange: 2 }),
    note: 'UL (kΩ)',
    text: 'UL',
    unit: 'kΩ',
    acdc: '',
    overload: false,
    fn: 'OHM',
    value: null,
  },
];

describe('voltcraft decode (live-verified R10W frames)', () => {
  for (const f of FRAMES) {
    it(`decodes: ${f.note}`, () => {
      const r = decodeVoltcraft(Uint8Array.from(f.bytes), 123);
      expect(r.displayText).toBe(f.text);
      expect(r.displayUnit).toBe(f.unit);
      expect(r.acdc).toBe(f.acdc);
      expect(r.overload).toBe(f.overload);
      expect(r.function).toBe(f.fn);
      expect(r.ts).toBe(123);
      if (f.value === null) {
        expect(r.displayValue).toBeNull();
      } else {
        expect(r.displayValue).toBeCloseTo(f.value, 9);
      }
    });
  }

  it('matches the protocol-doc worked example bytes exactly (4.200 V DC)', () => {
    const r = decodeVoltcraft(
      Uint8Array.from([0x23, 0, 0, 0x68, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
    expect(r.displayText).toBe('4.200');
    expect(r.displayUnit).toBe('V');
    expect(r.acdc).toBe('DC');
    expect(r.displayValue).toBeCloseTo(4.2, 9);
  });

  it('normalizes range prefixes into baseValue (MΩ → Ω)', () => {
    const r = decodeVoltcraft(
      Uint8Array.from(frame({ gear: 4, prefix: 6, decimals: 3, count: 1000 })),
    );
    expect(r.displayUnit).toBe('MΩ');
    expect(r.baseUnit).toBe('Ω');
    expect(r.baseValue).toBeCloseTo(1_000_000, 3);
    expect(r.function).toBe('OHM');
  });

  it('flags overload and yields a null value (OL)', () => {
    const r = decodeVoltcraft(Uint8Array.from(frame({ gear: 1, overrange: 1 })));
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
  });

  it('reports a negative DC voltage from value-word bit23 (bit7 of byte 5)', () => {
    const r = decodeVoltcraft(
      Uint8Array.from(frame({ gear: 0, prefix: 4, decimals: 3, count: 512, sign: true })),
    );
    expect(r.displayText).toBe('-0.512');
    expect(r.displayValue).toBeCloseTo(-0.512, 9);
    expect(r.acdc).toBe('DC');
  });
});

// The headline fix: the state word is a straight LSB-numbered bitmask (HOLD=bit0), not MSB-first.
describe('voltcraft state flags (LSB-first; HOLD = bit0)', () => {
  const FLAG_CASES: {
    bit: number;
    key: keyof ReturnType<typeof decodeVoltcraft>['flags'];
    note: string;
  }[] = [
    { bit: 0, key: 'hold', note: 'HOLD' },
    { bit: 1, key: 'rel', note: 'REL' },
    { bit: 2, key: 'auto', note: 'AUTO' },
    { bit: 3, key: 'lowBattery', note: 'Bat' },
    { bit: 4, key: 'min', note: 'MIN' },
    { bit: 5, key: 'max', note: 'MAX' },
  ];

  for (const c of FLAG_CASES) {
    it(`sets only flags.${c.key} for ${c.note} (bit ${c.bit})`, () => {
      const r = decodeVoltcraft(
        Uint8Array.from(frame({ gear: 0, prefix: 4, decimals: 3, count: 4200, state: 1 << c.bit })),
      );
      expect(r.flags[c.key]).toBe(true);
      // Every other surfaced flag stays clear.
      for (const other of FLAG_CASES) {
        if (other.key !== c.key) expect(r.flags[other.key]).toBe(false);
      }
      // The measurement is unaffected by the state word.
      expect(r.displayText).toBe('4.200');
    });
  }

  it('decodes the protocol-doc HOLD worked example (4.2 V DC + HOLD)', () => {
    // 21 00 00 2a 00 00 00 00 00 00 00 00 01 00 00
    const r = decodeVoltcraft(
      Uint8Array.from([0x21, 0, 0, 0x2a, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0, 0]),
    );
    expect(r.displayText).toBe('4.2');
    expect(r.acdc).toBe('DC');
    expect(r.flags.hold).toBe(true);
    expect(r.flags.rel).toBe(false);
  });

  it('does NOT read flags MSB-first (the old bug): a high state bit lights nothing', () => {
    // bit15 (USB) — under the old MSB-first read this was HOLD; now it must light no surfaced flag.
    const r = decodeVoltcraft(
      Uint8Array.from(frame({ gear: 0, prefix: 4, decimals: 3, count: 4200, state: 1 << 15 })),
    );
    expect(r.flags.hold).toBe(false);
    expect(r.flags.rel).toBe(false);
    expect(r.flags.max).toBe(false);
  });
});

describe('voltcraft special displays + graceful degradation', () => {
  it('degrades a short frame to a blank reading (never throws)', () => {
    const r = decodeVoltcraft(Uint8Array.from([0x23, 0, 0, 0x68, 0x10]), 7);
    expect(r.displayText).toBe('');
    expect(r.function).toBe('?');
    expect(r.ts).toBe(7);
  });

  it('returns a blank reading for an empty frame (never throws)', () => {
    const r = decodeVoltcraft(Uint8Array.from([]), 3);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
    expect(r.ts).toBe(3);
  });

  it('renders an NCV strength bar of dashes (gear 13, count > 0) with no unit/value', () => {
    const r = decodeVoltcraft(Uint8Array.from(frame({ gear: 13, count: 3 })));
    expect(r.displayText).toBe('---');
    expect(r.displayUnit).toBe('');
    expect(r.displayValue).toBeNull();
    expect(r.function).toBe('NCV');
  });

  it('renders "EF" for NCV with no field (gear 13, count == 0)', () => {
    const r = decodeVoltcraft(Uint8Array.from(frame({ gear: 13, count: 0 })));
    expect(r.displayText).toBe('EF');
    expect(r.displayValue).toBeNull();
  });

  it('renders hFE as a unit-less gain (gear 12)', () => {
    const r = decodeVoltcraft(Uint8Array.from(frame({ gear: 12, count: 250 })));
    expect(r.displayUnit).toBe('');
    expect(r.function).toBe('HFE');
    expect(r.displayText).toBe('250');
  });

  it('populates every Reading field', () => {
    const r = decodeVoltcraft(
      Uint8Array.from(frame({ gear: 0, prefix: 4, decimals: 3, count: 4200 })),
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
  const FRAME = frame({ gear: 0, prefix: 4, decimals: 3, count: 4200 });

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

  it('rejects a 15-byte payload whose gear code is out of range (14..31)', () => {
    // gear 31 (all bits set) — not a valid R10W function.
    const bad = frame({ gear: 31 });
    expect(looksLikeVoltcraftFrame(Uint8Array.from(bad))).toBe(false);
  });

  it('cross-rejects the other FFF0 families', () => {
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

describe('voltcraft framer (split/coalesced notifications)', () => {
  const FRAME = frame({ gear: 0, prefix: 4, decimals: 3, count: 4200 });

  it('frames one notification == one frame', () => {
    const f = voltcraft.createFramer();
    const out = f.push(Uint8Array.from(FRAME));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('measurement');
    expect([...out[0]!.bytes]).toEqual(FRAME);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = voltcraft.createFramer();
    expect(f.push(Uint8Array.from(FRAME.slice(0, 6)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(FRAME.slice(6)));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(FRAME);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = voltcraft.createFramer();
    const out = f.push(Uint8Array.from([...FRAME, ...FRAME]));
    expect(out).toHaveLength(2);
  });

  it('reset clears buffered bytes', () => {
    const f = voltcraft.createFramer();
    f.push(Uint8Array.from(FRAME.slice(0, 6)));
    f.reset();
    expect(f.push(Uint8Array.from(FRAME.slice(6)))).toHaveLength(0);
  });
});

describe('voltcraft driver wiring', () => {
  const FRAME = frame({ gear: 0, prefix: 4, decimals: 3, count: 4200 });

  it('driver.decode delegates to decodeVoltcraft', () => {
    const r = voltcraft.decode(Uint8Array.from(FRAME), 21);
    expect(r.displayText).toBe('4.200');
    expect(r.ts).toBe(21);
  });

  it('reports app-verified verification status', () => {
    expect(voltcraft.verification).toBe('app-verified');
  });

  it('matches on the FFF0 service and VC/Voltcraft name prefixes', () => {
    expect(voltcraft.match({ services: ['0000fff0-0000-1000-8000-00805f9b34fb'] })).toBe(true);
    expect(voltcraft.match({ name: 'VC900' })).toBe(true);
    expect(voltcraft.match({ name: 'Voltcraft-X' })).toBe(true);
    expect(voltcraft.match({ name: 'Nope' })).toBe(false);
    expect(voltcraft.match({})).toBe(false);
  });
});
