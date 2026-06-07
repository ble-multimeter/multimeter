// Fixture test for the AICARE driver (drivers/ai-care.ts).
//
// REAL FRAME: the source app's `TestData(dev_type=7)` returns exactly one synthetic AICARE
// sample — `[23,32,53,77,91,97,127,130,151,160,176,192,212,224]` — which decodes to "1.234 V DC,
// auto" (this is the one frame the `isBDM == 3` dispatch is exercised with). It is synthetic, not
// a hardware capture, so all decode values here are UNVERIFIED on real hardware.
//
// The remaining frames are constructed by reverse-encoding the source's documented bit layout
// (self-addressing nibbles + the `aiCareDecode` field offsets), then round-tripped through the
// decoder. They exercise overload, AC, mV/sign, °C, kΩ and the flag bits — but, being synthetic,
// they only prove the port is internally consistent with the source layout, not that the device
// emits these exact bytes.
import { describe, it, expect } from 'vitest';
import { decodeAiCare, aiCare } from './ai-care';

const FRAMES: {
  bytes: number[];
  note: string;
  real?: boolean;
  text: string;
  unit: string;
  acdc: string;
  overload: boolean;
  auto: boolean;
  hold: boolean;
  rel: boolean;
  lowBattery: boolean;
}[] = [
  {
    bytes: [23, 32, 53, 77, 91, 97, 127, 130, 151, 160, 176, 192, 212, 224],
    note: '1.234 V DC auto (REAL: source TestData dev_type 7)',
    real: true,
    text: '1.234',
    unit: 'V',
    acdc: 'DC',
    overload: false,
    auto: true,
    hold: false,
    rel: false,
    lowBattery: false,
  },
  {
    bytes: [16, 39, 61, 78, 88, 96, 112, 128, 144, 162, 176, 196, 208, 224],
    note: '0.L kΩ (overload, synthetic)',
    text: '0.L',
    unit: 'kΩ',
    acdc: '',
    overload: true,
    auto: false,
    hold: false,
    rel: false,
    lowBattery: false,
  },
  {
    bytes: [24, 35, 62, 71, 93, 111, 125, 128, 144, 160, 176, 193, 212, 224],
    note: '50.0 V AC hold (synthetic)',
    text: '50.0',
    unit: 'V',
    acdc: 'AC',
    overload: false,
    auto: false,
    hold: true,
    rel: false,
    lowBattery: false,
  },
  {
    bytes: [20, 40, 53, 69, 91, 105, 127, 128, 144, 160, 184, 192, 212, 224],
    note: '-12.3 mV DC (negative + prefix, synthetic)',
    text: '-12.3',
    unit: 'mV',
    acdc: 'DC',
    overload: false,
    auto: false,
    hold: false,
    rel: false,
    lowBattery: false,
  },
  {
    bytes: [16, 39, 61, 69, 91, 103, 126, 128, 144, 160, 176, 192, 209, 228],
    note: '026 °C low battery (synthetic)',
    text: '026',
    unit: '°C',
    acdc: '',
    overload: false,
    auto: false,
    hold: false,
    rel: false,
    lowBattery: true,
  },
];

describe('ai-care decode (1 real source frame + reverse-encoded synthetic frames)', () => {
  for (const f of FRAMES) {
    it(`decodes: ${f.note}`, () => {
      const r = decodeAiCare(Uint8Array.from(f.bytes), 123);
      expect(r.displayText).toBe(f.text);
      expect(r.displayUnit).toBe(f.unit);
      expect(r.acdc).toBe(f.acdc);
      expect(r.overload).toBe(f.overload);
      expect(r.flags.auto).toBe(f.auto);
      expect(r.flags.hold).toBe(f.hold);
      expect(r.flags.rel).toBe(f.rel);
      expect(r.flags.lowBattery).toBe(f.lowBattery);
      expect(r.ts).toBe(123);
      if (/^-?\d*\.?\d+$/.test(f.text) && !f.overload) {
        expect(r.displayValue).toBeTypeOf('number');
      } else {
        expect(r.displayValue).toBeNull();
      }
    });
  }

  it('decodes the real source frame to a fully populated Reading', () => {
    const r = decodeAiCare(
      Uint8Array.from([23, 32, 53, 77, 91, 97, 127, 130, 151, 160, 176, 192, 212, 224]),
    );
    expect(r.displayText).toBe('1.234');
    expect(r.displayValue).toBeCloseTo(1.234, 6);
    expect(r.displayUnit).toBe('V');
    expect(r.baseUnit).toBe('V');
    expect(r.baseValue).toBeCloseTo(1.234, 6);
    expect(r.acdc).toBe('DC');
    expect(r.function).toBe('DCV');
    expect(r.flags.auto).toBe(true);
    expect(r.bargraph).toBe(0);
  });

  it('normalizes range prefixes into baseValue (mV → V)', () => {
    const r = decodeAiCare(
      Uint8Array.from([20, 40, 53, 69, 91, 105, 127, 128, 144, 160, 184, 192, 212, 224]),
    );
    expect(r.displayUnit).toBe('mV');
    expect(r.baseUnit).toBe('V');
    expect(r.displayValue).toBeCloseTo(-12.3, 6);
    expect(r.baseValue).toBeCloseTo(-0.0123, 9);
    expect(r.function).toBe('DCV');
  });

  it('flags overload and yields a null value (0.L kΩ)', () => {
    const r = decodeAiCare(
      Uint8Array.from([16, 39, 61, 78, 88, 96, 112, 128, 144, 162, 176, 196, 208, 224]),
    );
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
    expect(r.function).toBe('OHM');
  });

  it('returns a blank (non-throwing) Reading for a short frame', () => {
    const r = decodeAiCare(Uint8Array.from([23, 32, 53]), 7);
    expect(r.displayText).toBe('');
    expect(r.displayValue).toBeNull();
    expect(r.function).toBe('?');
    expect(r.ts).toBe(7);
  });
});

describe('ai-care framer (self-addressing sync + split/coalesced notifications)', () => {
  const FRAME = [23, 32, 53, 77, 91, 97, 127, 130, 151, 160, 176, 192, 212, 224];

  it('frames one notification == one frame', () => {
    const f = aiCare.createFramer();
    const out = f.push(Uint8Array.from(FRAME));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('measurement');
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = aiCare.createFramer();
    expect(f.push(Uint8Array.from(FRAME.slice(0, 6)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(FRAME.slice(6)));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = aiCare.createFramer();
    const out = f.push(Uint8Array.from([...FRAME, ...FRAME]));
    expect(out).toHaveLength(2);
  });

  it('resyncs past leading garbage to a slot-1 byte (high nibble 0x1)', () => {
    const f = aiCare.createFramer();
    // 0x00, 0xFF, 0x20 (slot 2) are all non-slot-1 and must be dropped before the real frame.
    const out = f.push(Uint8Array.from([0x00, 0xff, 0x20, ...FRAME]));
    expect(out).toHaveLength(1);
    expect([...out[0].bytes]).toEqual(FRAME);
  });

  it('reset clears buffered bytes', () => {
    const f = aiCare.createFramer();
    f.push(Uint8Array.from(FRAME.slice(0, 6)));
    f.reset();
    expect(f.push(Uint8Array.from(FRAME.slice(6)))).toHaveLength(0);
  });
});

describe('ai-care driver metadata + GATT profile', () => {
  it('exposes the AICARE GATT UUIDs (service FFB0 / notify FFB2 / write FFB1)', () => {
    expect(aiCare.id).toBe('ai-care');
    expect(aiCare.verification).toBe('ported-unverified');
    expect(aiCare.gatt.service).toBe('0000ffb0-0000-1000-8000-00805f9b34fb');
    expect(aiCare.gatt.notify).toBe('0000ffb2-0000-1000-8000-00805f9b34fb');
    expect(aiCare.gatt.write).toEqual(['0000ffb1-0000-1000-8000-00805f9b34fb']);
  });

  it('matches on the FFB0 service and on an AICARE name prefix', () => {
    expect(aiCare.match({ services: ['0000ffb0-0000-1000-8000-00805f9b34fb'] })).toBe(true);
    expect(aiCare.match({ name: 'AICARE-1234' })).toBe(true);
    expect(aiCare.match({ name: 'SomethingElse' })).toBe(false);
    expect(aiCare.match({})).toBe(false);
  });
});
