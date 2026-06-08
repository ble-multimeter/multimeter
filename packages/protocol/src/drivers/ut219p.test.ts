// UT219P driver tests. The command-frame vectors are REAL byte arrays from the UNI-T Smart
// Measure app (UT219pManager); the standard-measurement frames are SYNTHESIZED from the decode
// logic (the app ships no captured measurement frames) but carry valid checksums computed the
// same way the device would. See drivers/ut219p.ts.
import { describe, it, expect } from 'vitest';
import { decodeUt219p, checksumOk, liveDataReq, COMMANDS, ut219p } from './ut219p';

const hex = (s: string): number[] =>
  s
    .trim()
    .split(/\s+/)
    .map(b => parseInt(b, 16));

// The spec's standard-measurement sample vector: daoPos=1 (ACV), 230.0 V, auto range, no flags.
const STD_ACV = hex(
  'AB CD 00 1B 05 00 01 00 00 00 00 11 00 00 00 00 00 00 00 00 00 66 43 00 00 00 00 00 00 00 00 DB 00',
);
// Same frame but the first per-value code = 1 (OL): codes32 = 0x40000000.
const STD_OL = hex(
  'AB CD 00 1B 05 00 01 00 00 00 00 11 00 40 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 72 00',
);
// daoPos=2 routes to the ACA set; index 1 = ACA(A), value 12.34, range0 → 2 dp.
const STD_ACA = hex('AB CD 00 13 05 00 02 00 00 00 00 11 00 00 00 00 00 00 00 A4 70 45 41 C5 01');

describe('ut219p checksum (big-endian LEN, little-endian trailing checksum)', () => {
  it('accepts the spec standard-measurement frame', () => {
    expect(checksumOk(Uint8Array.from(STD_ACV))).toBe(true);
  });

  // Host->device command frames (LEN=4) store their checksum at [2+LEN], a different layout from
  // the reply parser convention (chk at [LEN+4]) that checksumOk implements. So we assert their
  // exact literal bytes (verified against the source) rather than running them through checksumOk.
  it('carries the real command-frame literal bytes from the source app', () => {
    expect([...COMMANDS.DEVINFO_REQ]).toEqual([0xab, 0xcd, 0x00, 0x04, 0x17, 0x00, 0x1b, 0x00]);
    expect([...COMMANDS.LIVE_STD]).toEqual([0xab, 0xcd, 0x00, 0x04, 0x05, 0x00, 0x09, 0x00]);
    expect([...COMMANDS.LOCK]).toEqual([0xab, 0xcd, 0x00, 0x04, 0x19, 0x5a, 0x77, 0x00]);
    expect([...COMMANDS.UNLOCK]).toEqual([0xab, 0xcd, 0x00, 0x04, 0x19, 0xa5, 0xc2, 0x00]);
    expect([...COMMANDS.OTA]).toEqual([0xab, 0xcd, 0x00, 0x04, 0x90, 0x00, 0x94, 0x00]);
    expect([...COMMANDS.BATTERY_REQ]).toEqual([
      0xab, 0xcd, 0x00, 0x05, 0x20, 0xe8, 0x03, 0x13, 0x01,
    ]);
  });

  it('rejects a frame with a corrupted checksum byte', () => {
    const bad = [...STD_ACV];
    bad[bad.length - 1] = 0xff;
    expect(checksumOk(Uint8Array.from(bad))).toBe(false);
  });

  it('rejects a non-AB-CD frame and a too-short frame', () => {
    expect(checksumOk(Uint8Array.from([0x00, 0x00, 0x00, 0x04]))).toBe(false);
    expect(checksumOk(Uint8Array.from([0xab, 0xcd]))).toBe(false);
  });
});

describe('ut219p liveDataReq builder', () => {
  it('builds the standard (type 0) poll frame AB CD 00 04 05 00 09 00', () => {
    expect([...liveDataReq(0)]).toEqual([0xab, 0xcd, 0x00, 0x04, 0x05, 0x00, 0x09, 0x00]);
  });

  it('builds the waveform-V poll (type 7) with chk = type+9', () => {
    const f = liveDataReq(7);
    expect([...f]).toEqual([0xab, 0xcd, 0x00, 0x04, 0x05, 0x07, 0x10, 0x00]);
  });
});

describe('ut219p decode — standard measurement (cmdCode 0)', () => {
  it('decodes the spec ACV sample: 230.0 V', () => {
    const r = decodeUt219p(Uint8Array.from(STD_ACV), 123);
    expect(r.function).toBe('ACV');
    expect(r.displayText).toBe('230.0');
    expect(r.displayValue).toBe(230);
    expect(r.displayUnit).toBe('V');
    expect(r.baseUnit).toBe('V');
    expect(r.baseValue).toBe(230);
    expect(r.acdc).toBe('AC');
    expect(r.overload).toBe(false);
    expect(r.ts).toBe(123);
  });

  it('reflects status flags (auto range, no hold/maxmin)', () => {
    const r = decodeUt219p(Uint8Array.from(STD_ACV));
    expect(r.flags.auto).toBe(true);
    expect(r.flags.hold).toBe(false);
    expect(r.flags.max).toBe(false);
    expect(r.flags.min).toBe(false);
    expect(r.flags.hvWarning).toBe(false);
  });

  it('decodes the ACA set (daoPos=2) with 2-dp current', () => {
    const r = decodeUt219p(Uint8Array.from(STD_ACA));
    expect(r.function).toBe('ACA');
    expect(r.displayUnit).toBe('A');
    expect(r.displayText).toBe('12.34');
    expect(r.displayValue).toBeCloseTo(12.34, 2);
    expect(r.acdc).toBe('AC');
  });

  it('renders a per-value OL code as overload with null value', () => {
    const r = decodeUt219p(Uint8Array.from(STD_OL));
    expect(r.overload).toBe(true);
    expect(r.displayText).toBe('OL');
    expect(r.displayValue).toBeNull();
    expect(r.baseValue).toBeNull();
    expect(r.displayUnit).toBe('');
  });

  it('parses HOLD and manual-range + MAX flags from the status bytes', () => {
    // statusByte1: bit4 HOLD (0x10), bit1 manual range (0x02), bits6-7=01 → MAX (0x40).
    const f = [...STD_ACV];
    f[7] = 0x10 | 0x02 | 0x40;
    // recompute checksum over [2 .. i+4)
    const i = (f[2]! << 8) | f[3]!;
    let sum = 0;
    for (let k = 2; k < i + 4; k++) sum += f[k]!;
    sum &= 0xffff;
    f[i + 4] = sum & 0xff;
    f[i + 5] = (sum >> 8) & 0xff;
    const r = decodeUt219p(Uint8Array.from(f));
    expect(r.flags.hold).toBe(true);
    expect(r.flags.auto).toBe(false);
    expect(r.flags.max).toBe(true);
  });
});

describe('ut219p decode — graceful degradation (never throws)', () => {
  it('blank reading for a too-short frame', () => {
    const r = decodeUt219p(Uint8Array.from([0xab, 0xcd, 0x00]), 7);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
    expect(r.ts).toBe(7);
  });

  it('blank reading for an empty frame', () => {
    const r = decodeUt219p(Uint8Array.from([]), 0);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });

  it('blank reading for a bad-checksum frame', () => {
    const bad = [...STD_ACV];
    bad[bad.length - 1] = 0xff;
    const r = decodeUt219p(Uint8Array.from(bad));
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });

  it('blank reading for a non-live CMDID (device-info reply)', () => {
    // A minimal valid-checksum CMDID 0x17 frame is treated as control (no reading).
    const r = decodeUt219p(COMMANDS.DEVINFO_REQ);
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });

  it('blank reading for a non-zero cmdCode (waveform/harmonic)', () => {
    // cmdCode 7 frame envelope (valid checksum, no float decode here).
    const f = [...STD_ACV];
    f[5] = 0x07;
    const i = (f[2]! << 8) | f[3]!;
    let sum = 0;
    for (let k = 2; k < i + 4; k++) sum += f[k]!;
    sum &= 0xffff;
    f[i + 4] = sum & 0xff;
    f[i + 5] = (sum >> 8) & 0xff;
    const r = decodeUt219p(Uint8Array.from(f));
    expect(r.function).toBe('?');
    expect(r.displayValue).toBeNull();
  });
});

describe('ut219p framer (sync + split/coalesced/checksum)', () => {
  it('frames one notification == one measurement frame', () => {
    const f = ut219p.createFramer();
    const out = f.push(Uint8Array.from(STD_ACV));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('measurement');
    expect([...out[0]!.bytes]).toEqual(STD_ACV);
  });

  it('reassembles a frame split across two notifications', () => {
    const f = ut219p.createFramer();
    expect(f.push(Uint8Array.from(STD_ACV.slice(0, 10)))).toHaveLength(0);
    const out = f.push(Uint8Array.from(STD_ACV.slice(10)));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(STD_ACV);
  });

  it('splits two coalesced frames', () => {
    const f = ut219p.createFramer();
    const out = f.push(Uint8Array.from([...STD_ACV, ...STD_ACA]));
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('measurement');
    expect(out[1]!.kind).toBe('measurement');
  });

  it('resyncs past leading garbage to the AB CD header', () => {
    const f = ut219p.createFramer();
    const out = f.push(Uint8Array.from([0x00, 0xff, 0xab, 0x00, ...STD_ACV]));
    expect(out).toHaveLength(1);
    expect([...out[0]!.bytes]).toEqual(STD_ACV);
  });

  it('reset clears buffered bytes', () => {
    const f = ut219p.createFramer();
    f.push(Uint8Array.from(STD_ACV.slice(0, 10)));
    f.reset();
    expect(f.push(Uint8Array.from(STD_ACV.slice(10)))).toHaveLength(0);
  });
});

describe('ut219p driver wiring', () => {
  it('matches the UT219P / UT-219P name prefixes only', () => {
    expect(ut219p.match({ name: 'UT219P' })).toBe(true);
    expect(ut219p.match({ name: 'UT-219P' })).toBe(true);
    expect(ut219p.match({ name: 'UT60BT' })).toBe(false);
    expect(ut219p.match({})).toBe(false);
  });

  it('exposes the shared ISSC GATT profile and ported-unverified status', () => {
    expect(ut219p.gatt.service).toBe('49535343-fe7d-4ae5-8fa9-9fafd205e455');
    expect(ut219p.verification).toBe('ported-unverified');
    expect(ut219p.id).toBe('ut219p');
  });

  it('maps generic controls onto the device lock/unlock frames', () => {
    expect([...ut219p.controls!.hold!]).toEqual([...COMMANDS.LOCK]);
    expect([...ut219p.controls!.rel!]).toEqual([...COMMANDS.UNLOCK]);
  });

  it('sniffer accepts a valid UT219P frame and rejects garbage', () => {
    expect(ut219p.sniff!(Uint8Array.from(STD_ACV))).toBe(true);
    expect(ut219p.sniff!(Uint8Array.from([1, 2, 3]))).toBe(false);
    expect(ut219p.sniff!(Uint8Array.from([]))).toBe(false);
  });

  it('handshake polls devinfo → battery → live-data and resolves on a measurement', async () => {
    const writes: number[][] = [];
    const io = {
      write: (b: Uint8Array) => {
        writes.push([...b]);
      },
      waitForFrame: async (pred: (k: 'measurement' | 'control') => boolean) => {
        // Answer the gating control waits, and the live-data wait with a measurement.
        return pred('control') || pred('measurement');
      },
    };
    await ut219p.handshake(io as never);
    expect(writes[0]).toEqual([...COMMANDS.DEVINFO_REQ]);
    expect(writes[1]).toEqual([...COMMANDS.BATTERY_REQ]);
    expect(writes[2]).toEqual([...COMMANDS.LIVE_STD]);
  });
});
