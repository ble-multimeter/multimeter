// UT117C driver tests. The measurement frames are the spec's synthesized sampleVectors (no real
// measurement captures exist in the decompiled app); the control/poll frames are the real byte
// arrays from UT117cManager. See drivers/ut117c.ts.
import { describe, it, expect } from 'vitest';
import { decodeUt117c, looksLikeUt117cFrame, checksumOk, UT117C_COMMANDS, ut117c } from './ut117c';

const hex = (s: string): number[] =>
  s
    .trim()
    .split(/\s+/)
    .map(x => parseInt(x, 16));

// Spec sampleVectors (synthesized from the decode logic).
const V1 = hex('AB CD 00 12 02 05 31 00 31 32 2E 33 34 35 20 56 20 20 00 00 00 08 03 AD'); // DCV 12.345 V
const V2 = hex('AB CD 00 12 02 01 32 00 32 33 30 2E 35 20 20 56 20 20 00 00 06 0A 03 9D'); // ACV 230.5 V HOLD
const V3 = hex('AB CD 00 12 02 06 31 00 30 2E 30 30 30 20 20 4D 6F 20 31 00 00 00 03 FE'); // OHM OL MΩ
const POLL = hex('AB CD 00 04 05 00 01 81'); // real host poll command

describe('ut117c decode (spec sample vectors)', () => {
  it('decodes DCV 12.345 V, auto, DC (V1)', () => {
    const r = decodeUt117c(Uint8Array.from(V1), 42);
    expect(r.function).toBe('DCV');
    expect(r.displayText).toBe('12.345');
    expect(r.displayValue).toBeCloseTo(12.345, 6);
    expect(r.displayUnit).toBe('V');
    expect(r.baseUnit).toBe('V');
    expect(r.baseValue).toBeCloseTo(12.345, 6);
    expect(r.acdc).toBe('DC');
    expect(r.overload).toBe(false);
    expect(r.flags.auto).toBe(true);
    expect(r.flags.hold).toBe(false);
    expect(r.flags.rel).toBe(false);
    expect(r.ts).toBe(42);
  });

  it('decodes ACV 230.5 V, AC, auto, HOLD + manual-range (V2)', () => {
    const r = decodeUt117c(Uint8Array.from(V2), 7);
    expect(r.function).toBe('ACV');
    expect(r.displayText).toBe('230.5');
    expect(r.displayValue).toBeCloseTo(230.5, 6);
    expect(r.displayUnit).toBe('V');
    expect(r.acdc).toBe('AC');
    expect(r.flags.hold).toBe(true);
    expect(r.flags.auto).toBe(true);
    expect(r.flags.rel).toBe(false);
    expect(r.overload).toBe(false);
  });

  it('decodes resistance overload OL with MΩ unit remap (V3)', () => {
    const r = decodeUt117c(Uint8Array.from(V3), 0);
    expect(r.function).toBe('OHM');
    expect(r.overload).toBe(true);
    expect(r.displayText).toBe('OL');
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
    expect(r.displayUnit).toBe('MΩ'); // 'Mo' → 'MΩ'
    expect(r.baseUnit).toBe('Ω');
  });
});

describe('ut117c decode edge cases (never throws)', () => {
  it('blank reading for a short frame', () => {
    const r = decodeUt117c(Uint8Array.from([0xab, 0xcd, 0x00]), 5);
    expect(r.function).toBe('?');
    expect(r.displayText).toBe('');
    expect(r.displayValue).toBeNull();
    expect(r.ts).toBe(5);
  });

  it('blank reading for an empty frame', () => {
    const r = decodeUt117c(Uint8Array.from([]), 0);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });

  it('blank reading for an ACK (type 1) frame', () => {
    const ack = [...V1];
    ack[4] = 0x01; // type 1 = ACK, not measurement
    const r = decodeUt117c(Uint8Array.from(ack), 0);
    expect(r.function).toBe('?');
  });

  it('negative overload yields -OL', () => {
    const f = [...V3];
    f[18] = 0x32; // olFlag = -OL
    const r = decodeUt117c(Uint8Array.from(f), 0);
    expect(r.overload).toBe(true);
    expect(r.displayText).toBe('-OL');
    expect(r.displayValue).toBeNull();
  });

  it('NCV shows HI/LO not a number', () => {
    const f = [...V1];
    f[5] = 13; // NCV funcID
    f[6] = 0x31; // rangIndex '1' → HI
    const hi = decodeUt117c(Uint8Array.from(f), 0);
    expect(hi.function).toBe('NCV');
    expect(hi.displayText).toBe('HI');
    expect(hi.displayValue).toBeNull();
    f[6] = 0x30; // → LO
    const lo = decodeUt117c(Uint8Array.from(f), 0);
    expect(lo.displayText).toBe('LO');
  });
});

describe('ut117c control/poll commands (real captures)', () => {
  const expectFrame = (got: Uint8Array, want: string) =>
    expect([...got].map(b => b.toString(16).padStart(2, '0')).join(' ')).toBe(
      want.toLowerCase().trim(),
    );

  it('builds the exact captured command bytes', () => {
    expectFrame(UT117C_COMMANDS.POLL, 'AB CD 00 04 05 00 01 81');
    expectFrame(UT117C_COMMANDS.SELECT, 'AB CD 00 04 01 5A 01 D7');
    expectFrame(UT117C_COMMANDS.RANGE, 'AB CD 00 04 02 01 01 7F');
    expectFrame(UT117C_COMMANDS.RANGE_AUTO, 'AB CD 00 04 02 00 01 7E');
    expectFrame(UT117C_COMMANDS.REL, 'AB CD 00 04 03 5A 01 D9');
    expectFrame(UT117C_COMMANDS.MAXMIN, 'AB CD 00 04 04 01 01 81');
    expectFrame(UT117C_COMMANDS.HOLD, 'AB CD 00 04 12 5A 01 E8');
    expectFrame(UT117C_COMMANDS.LPF, 'AB CD 00 04 14 5A 01 EA');
    expectFrame(UT117C_COMMANDS.BACKLIGHT, 'AB CD 00 04 15 5A 01 EB');
  });

  it('exposes the soft-button controls on the driver', () => {
    expectFrame(ut117c.controls!.hold!, 'AB CD 00 04 12 5A 01 E8');
    expectFrame(ut117c.controls!.backlight!, 'AB CD 00 04 15 5A 01 EB');
    expectFrame(ut117c.controls!.select!, 'AB CD 00 04 01 5A 01 D7');
    expectFrame(ut117c.controls!.range!, 'AB CD 00 04 02 01 01 7F');
    expectFrame(ut117c.controls!.rangeAuto!, 'AB CD 00 04 02 00 01 7E');
    expectFrame(ut117c.controls!.rel!, 'AB CD 00 04 03 5A 01 D9');
    expectFrame(ut117c.controls!.maxMin!, 'AB CD 00 04 04 01 01 81');
  });
});

describe('ut117c framer (sync + split/coalesced notifications)', () => {
  it('frames one notification == one measurement frame', () => {
    const f = ut117c.createFramer();
    const out = f.push(Uint8Array.from(V1));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('measurement');
    expect([...out[0]!.bytes]).toEqual(V1);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = ut117c.createFramer();
    expect(f.push(Uint8Array.from(V1.slice(0, 10)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(V1.slice(10)));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(V1);
  });

  it('splits two frames coalesced into one notification', () => {
    const f = ut117c.createFramer();
    const out = f.push(Uint8Array.from([...V1, ...V2]));
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('measurement');
    expect(out[1]!.kind).toBe('measurement');
  });

  it('resyncs past leading garbage to the AB CD header', () => {
    const f = ut117c.createFramer();
    const out = f.push(Uint8Array.from([0x00, 0xff, 0xab, 0x00, ...V1]));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(V1);
  });

  it('reset clears buffered bytes', () => {
    const f = ut117c.createFramer();
    f.push(Uint8Array.from(V1.slice(0, 10)));
    f.reset();
    expect(f.push(Uint8Array.from(V1.slice(10)))).toHaveLength(0);
  });
});

describe('ut117c checksum + sniffer + driver wiring', () => {
  it('validates the additive checksum on sample frames', () => {
    expect(checksumOk(Uint8Array.from(V1))).toBe(true);
    expect(checksumOk(Uint8Array.from(V2))).toBe(true);
    expect(checksumOk(Uint8Array.from(V3))).toBe(true);
    const bad = [...V1];
    bad[23] = (bad[23]! + 1) & 0xff;
    expect(checksumOk(Uint8Array.from(bad))).toBe(false);
  });

  it('sniffer accepts a valid measurement frame and rejects others', () => {
    expect(looksLikeUt117cFrame(Uint8Array.from(V1))).toBe(true);
    expect(looksLikeUt117cFrame(Uint8Array.from(V3))).toBe(true);
    // Poll command (wrong length / type) and garbage.
    expect(looksLikeUt117cFrame(Uint8Array.from(POLL))).toBe(false);
    expect(looksLikeUt117cFrame(Uint8Array.from([1, 2, 3]))).toBe(false);
    expect(looksLikeUt117cFrame(Uint8Array.from([]))).toBe(false);
    // Right length but corrupted checksum.
    const bad = [...V1];
    bad[23] = (bad[23]! + 1) & 0xff;
    expect(looksLikeUt117cFrame(Uint8Array.from(bad))).toBe(false);
  });

  it('matches on the UT117C name prefix only (not bare service)', () => {
    expect(ut117c.match({ name: 'UT117C-1234' })).toBe(true);
    expect(ut117c.match({ name: 'UT60BT' })).toBe(false);
    expect(ut117c.match({ services: ['49535343-fe7d-4ae5-8fa9-9fafd205e455'] })).toBe(false);
    expect(ut117c.match({})).toBe(false);
  });

  it('handshake writes the poll command once', async () => {
    const writes: Uint8Array[] = [];
    await ut117c.handshake({
      write: b => {
        writes.push(b);
      },
      waitForFrame: async () => true,
    });
    expect(writes).toHaveLength(1);
    expect([...writes[0]!]).toEqual([...UT117C_COMMANDS.POLL]);
  });

  it('onRequest re-arms the poll', () => {
    const writes: Uint8Array[] = [];
    ut117c.onRequest(
      { kind: 'measurement', bytes: Uint8Array.from(V1) },
      {
        write: b => {
          writes.push(b);
        },
        waitForFrame: async () => true,
      },
    );
    expect(writes).toHaveLength(1);
    expect([...writes[0]!]).toEqual([...UT117C_COMMANDS.POLL]);
  });

  it('declares ported-unverified verification', () => {
    expect(ut117c.verification).toBe('ported-unverified');
    expect(ut117c.id).toBe('ut117c');
  });

  it('driver.decode delegates to decodeUt117c', () => {
    const r = ut117c.decode(Uint8Array.from(V1), 99);
    expect(r.displayText).toBe('12.345');
    expect(r.ts).toBe(99);
  });
});
