// UT181A driver tests. The UNI-T Smart Measure app embeds NO demo byte arrays for this model,
// so the live-frame vectors below are SYNTHESIZED from the documented parseCommonData layout and
// their length/checksum bytes are recomputed to be byte-accurate (the two short TX vectors —
// start, hold — are byte-exact from the spec). See drivers/ut181a.ts.
import { describe, it, expect } from 'vitest';
import { decodeUt181a, looksLikeUt181aFrame, ut181a } from './ut181a';

// AB CD <len LE> 02 <flagsA flagsB mcLo mcHi range> <float32 LE> <status> <8-byte unit> <chk LE>
// DC volts ~1.30 V: measureCode 0x0014, range 3, float 1.3, status 0x10 (dot=1, normal), unit "V".
const DCV_1_3 = [
  0xab, 0xcd, 0x15, 0x00, 0x02, 0x00, 0x00, 0x14, 0x00, 0x03, 0x66, 0x66, 0xa6, 0x3f, 0x10, 0x56,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x45, 0x02,
];
// -OL: status 0x02 (low nibble 2 => -OL), unit "V".
const NEG_OL = [
  0xab, 0xcd, 0x15, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x80, 0x3f, 0x02, 0x56,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x37, 0x01,
];
// OHM 470.5 Ω: unit byte 0x7E -> "Ω", status 0x10 (dot=1).
const OHM = [
  0xab, 0xcd, 0x15, 0x00, 0x02, 0x00, 0x00, 0x20, 0x00, 0x01, 0x00, 0x40, 0xeb, 0x43, 0x10, 0x7e,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x34, 0x02,
];
// HOLD set (flagsA bit7), DC volts.
const HOLD_FRAME = [
  0xab, 0xcd, 0x15, 0x00, 0x02, 0x80, 0x00, 0x14, 0x00, 0x03, 0x66, 0x66, 0xa6, 0x3f, 0x10, 0x56,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc5, 0x02,
];
// OL: status 0x01 (low nibble 1 => OL).
const OL_FRAME = [
  0xab, 0xcd, 0x15, 0x00, 0x02, 0x00, 0x00, 0x14, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x56,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x85, 0x00,
];
// Temperature 25.4 °C: unit bytes 0xB0 0x43 -> "°C", status 0x10 (dot=1).
const TEMP_C = [
  0xab, 0xcd, 0x15, 0x00, 0x02, 0x00, 0x00, 0x30, 0x00, 0x00, 0x33, 0x33, 0xcb, 0x41, 0x10, 0xb0,
  0x43, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xbc, 0x02,
];

describe('ut181a decode (synthesized live frames)', () => {
  it('decodes a normal DC volts reading with dot rounding', () => {
    const r = decodeUt181a(Uint8Array.from(DCV_1_3), 123);
    expect(r.displayText).toBe('1.3');
    expect(r.displayValue).toBeCloseTo(1.3, 6);
    expect(r.displayUnit).toBe('V');
    expect(r.baseUnit).toBe('V');
    expect(r.baseValue).toBeCloseTo(1.3, 6);
    expect(r.function).toBe('V');
    expect(r.overload).toBe(false);
    expect(r.ts).toBe(123);
  });

  it('decodes an ohms reading with the in-band 0x7E -> Ω unit', () => {
    const r = decodeUt181a(Uint8Array.from(OHM));
    expect(r.displayUnit).toBe('Ω');
    expect(r.baseUnit).toBe('Ω');
    expect(r.function).toBe('OHM');
    expect(r.displayValue).toBeCloseTo(470.5, 4);
    expect(r.overload).toBe(false);
  });

  it('decodes a temperature reading (0xB0 0x43 -> °C)', () => {
    const r = decodeUt181a(Uint8Array.from(TEMP_C));
    expect(r.displayUnit).toBe('°C');
    expect(r.baseUnit).toBe('°C');
    expect(r.function).toBe('°C');
    expect(r.displayValue).toBeCloseTo(25.4, 4);
  });

  it('flags -OL (status nibble 2) with a null value', () => {
    const r = decodeUt181a(Uint8Array.from(NEG_OL));
    expect(r.displayText).toBe('-OL');
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
  });

  it('flags OL (status nibble 1) with a null value', () => {
    const r = decodeUt181a(Uint8Array.from(OL_FRAME));
    expect(r.displayText).toBe('OL');
    expect(r.overload).toBe(true);
    expect(r.displayValue).toBeNull();
  });

  it('surfaces the HOLD flag (flagsA bit7)', () => {
    const r = decodeUt181a(Uint8Array.from(HOLD_FRAME));
    expect(r.flags.hold).toBe(true);
    expect(r.displayText).toBe('1.3');
  });
});

describe('ut181a decode edge cases (never throws)', () => {
  it('returns a blank reading for a too-short frame', () => {
    const r = decodeUt181a(Uint8Array.from([0xab, 0xcd, 0x04, 0x00, 0x02]), 7);
    expect(r.function).toBe('?');
    expect(r.displayText).toBe('');
    expect(r.displayValue).toBeNull();
    expect(r.ts).toBe(7);
  });

  it('returns a blank reading for an empty frame', () => {
    const r = decodeUt181a(Uint8Array.from([]), 0);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });

  it('returns a blank reading for a non-live opcode', () => {
    const notLive = [...DCV_1_3];
    notLive[4] = 0x11; // device-info opcode, not a live frame
    const r = decodeUt181a(Uint8Array.from(notLive));
    expect(r.function).toBe('?');
  });

  it('returns a blank reading on a bad checksum', () => {
    const corrupt = [...DCV_1_3];
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1]! ^ 0xff) & 0xff;
    const r = decodeUt181a(Uint8Array.from(corrupt));
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });
});

describe('ut181a framer (AB-CD envelope, split/coalesced)', () => {
  it('frames one notification == one live frame', () => {
    const f = ut181a.createFramer();
    const out = f.push(Uint8Array.from(DCV_1_3));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('measurement');
    expect([...out[0]!.bytes]).toEqual(DCV_1_3);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = ut181a.createFramer();
    expect(f.push(Uint8Array.from(DCV_1_3.slice(0, 9)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(DCV_1_3.slice(9)));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(DCV_1_3);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = ut181a.createFramer();
    const out = f.push(Uint8Array.from([...DCV_1_3, ...OHM]));
    expect(out).toHaveLength(2);
    expect(out[0]!.bytes).toHaveLength(DCV_1_3.length);
    expect(out[1]!.bytes).toHaveLength(OHM.length);
  });

  it('resyncs past leading garbage to the AB CD header', () => {
    const f = ut181a.createFramer();
    const out = f.push(Uint8Array.from([0x00, 0xff, 0xab, 0x00, ...DCV_1_3]));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(DCV_1_3);
  });

  it('reset clears buffered bytes', () => {
    const f = ut181a.createFramer();
    f.push(Uint8Array.from(DCV_1_3.slice(0, 9)));
    f.reset();
    expect(f.push(Uint8Array.from(DCV_1_3.slice(9)))).toHaveLength(0);
  });
});

describe('ut181a driver wiring + controls', () => {
  it('match() keys on the UT181 name (not the shared service)', () => {
    expect(ut181a.match({ name: 'UT181A' })).toBe(true);
    expect(ut181a.match({ name: 'UT181' })).toBe(true);
    expect(ut181a.match({ name: 'My-UT181A-meter' })).toBe(true);
    expect(ut181a.match({ name: 'UT60BT' })).toBe(false);
    // Sharing the ISSC service alone must NOT claim it (the generic uni-t driver does).
    expect(ut181a.match({ services: ['49535343-fe7d-4ae5-8fa9-9fafd205e455'] })).toBe(false);
    expect(ut181a.match({})).toBe(false);
  });

  it('decode delegates to decodeUt181a', () => {
    const r = ut181a.decode(Uint8Array.from(DCV_1_3), 99);
    expect(r.displayText).toBe('1.3');
    expect(r.ts).toBe(99);
  });

  it('exposes the START command and soft-button controls as exact AB-CD frames', () => {
    // changeHold181 = createCmd(18,{0x5A}) = AB CD 04 00 12 5A 70 00 (byte-exact from the spec).
    expect([...ut181a.controls!.hold!]).toEqual([0xab, 0xcd, 0x04, 0x00, 0x12, 0x5a, 0x70, 0x00]);
    // enterMaxMin181 = createCmd(4,{0x01}) = AB CD 04 00 04 01 09 00.
    expect([...ut181a.controls!.maxMin!]).toEqual([0xab, 0xcd, 0x04, 0x00, 0x04, 0x01, 0x09, 0x00]);
    // changeRange181(0) = createCmd(2,{0x00}) = AB CD 04 00 02 00 06 00.
    expect([...ut181a.controls!.range!]).toEqual([0xab, 0xcd, 0x04, 0x00, 0x02, 0x00, 0x06, 0x00]);
  });

  it('sniffer accepts a real live frame and rejects garbage / wrong opcode', () => {
    expect(looksLikeUt181aFrame(Uint8Array.from(DCV_1_3))).toBe(true);
    const wrongOpcode = [...DCV_1_3];
    wrongOpcode[4] = 0x05;
    expect(looksLikeUt181aFrame(Uint8Array.from(wrongOpcode))).toBe(false);
    const badChk = [...DCV_1_3];
    badChk[badChk.length - 1] = (badChk[badChk.length - 1]! ^ 0xff) & 0xff;
    expect(looksLikeUt181aFrame(Uint8Array.from(badChk))).toBe(false);
    expect(looksLikeUt181aFrame(Uint8Array.from([1, 2, 3]))).toBe(false);
    expect(looksLikeUt181aFrame(Uint8Array.from([]))).toBe(false);
  });

  it('is marked ported-unverified and uses the ISSC profile', () => {
    expect(ut181a.verification).toBe('ported-unverified');
    expect(ut181a.gatt.service).toBe('49535343-fe7d-4ae5-8fa9-9fafd205e455');
    expect(ut181a.id).toBe('ut181a');
  });
});

describe('ut181a handshake (sends start, retries until measurements)', () => {
  it('writes the start command and stops once a measurement arrives', async () => {
    const writes: number[][] = [];
    const io = {
      write: (b: Uint8Array) => {
        writes.push([...b]);
      },
      waitForFrame: async (pred: (k: 'measurement' | 'control') => boolean) => pred('measurement'),
    };
    await ut181a.handshake(io as never);
    expect(writes).toHaveLength(1);
    // startReadTestValue181A = createCmd(5,{0x01}) = AB CD 04 00 05 01 0A 00 (byte-exact).
    expect(writes[0]).toEqual([0xab, 0xcd, 0x04, 0x00, 0x05, 0x01, 0x0a, 0x00]);
  });

  it('retries the start command when no measurement arrives', async () => {
    const writes: number[][] = [];
    const io = {
      write: (b: Uint8Array) => {
        writes.push([...b]);
      },
      waitForFrame: async () => false,
    };
    await ut181a.handshake(io as never);
    expect(writes).toHaveLength(3);
  });
});
