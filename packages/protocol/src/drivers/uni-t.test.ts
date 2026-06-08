// uni-t driver: handshake / onRequest / match. The decode path is covered by decode.test.ts and
// the framer by framing.test.ts (FrameParser); here we exercise the I/O-driven control logic with
// a fake DriverIO, asserting the exact command bytes written for each frame kind and the retry
// budget on handshake.
import { describe, it, expect, vi } from 'vitest';
import { uniT } from './uni-t';
import { COMMANDS } from '../framing';
import type { DriverIO } from './types';
import type { ParsedFrame } from '../framing';

const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';

describe('uni-t match', () => {
  it('matches on the ISSC service', () => {
    expect(uniT.match({ services: [ISSC_SERVICE] })).toBe(true);
  });

  it('matches on a UT60BT name prefix', () => {
    expect(uniT.match({ name: 'UT60BT-AB12' })).toBe(true);
  });

  it('matches the UT161 series (same AB-CD protocol)', () => {
    expect(uniT.match({ name: 'UT161D-9F3A' })).toBe(true);
  });

  it('rejects an unrelated device', () => {
    expect(
      uniT.match({ name: 'SomethingElse', services: ['0000fff0-0000-1000-8000-00805f9b34fb'] }),
    ).toBe(false);
    expect(uniT.match({})).toBe(false);
  });
});

describe('uni-t driver wiring', () => {
  it('createFramer returns a working FrameParser that decodes a real measurement frame', () => {
    // A real 19-byte measurement capture (ACV 274.7 V) from the Phase-0 hardware logs.
    const frame = Uint8Array.from([
      0xab, 0xcd, 0x10, 0x00, 0x30, 0x20, 0x20, 0x32, 0x37, 0x34, 0x2e, 0x37, 0x00, 0x00, 0x00,
      0x00, 0x08, 0x03, 0x02,
    ]);
    const framer = uniT.createFramer();
    const out = framer.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('measurement');
  });

  it('decode delegates to the shared decode() and yields the expected reading', () => {
    const frame = Uint8Array.from([
      0xab, 0xcd, 0x10, 0x00, 0x30, 0x20, 0x20, 0x32, 0x37, 0x34, 0x2e, 0x37, 0x00, 0x00, 0x00,
      0x00, 0x08, 0x03, 0x02,
    ]);
    const r = uniT.decode(frame, 77);
    expect(r.function).toBe('ACV');
    expect(r.displayValue).toBeCloseTo(274.7, 6);
    expect(r.ts).toBe(77);
  });

  it('exposes the backlight control command', () => {
    expect(uniT.controls?.backlight).toBe(COMMANDS.BACKLIGHT);
  });
});

describe('uni-t handshake', () => {
  it('sends GET_NAME, waits for the control frame, then GET_DATA until measurements arrive', async () => {
    const write = vi.fn<DriverIO['write']>().mockResolvedValue(undefined);
    // First waitForFrame (control) resolves true; the next (measurement) resolves true.
    const waitForFrame = vi
      .fn<DriverIO['waitForFrame']>()
      .mockResolvedValueOnce(true) // control frame seen
      .mockResolvedValueOnce(true); // measurement seen on first GET_DATA
    const io: DriverIO = { write, waitForFrame };

    await uniT.handshake(io);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]![0]).toBe(COMMANDS.GET_NAME);
    expect(write.mock.calls[1]![0]).toBe(COMMANDS.GET_DATA);
    // The control wait then exactly one measurement wait (returned true → loop exits).
    expect(waitForFrame).toHaveBeenCalledTimes(2);
  });

  it('keeps nudging GET_DATA across retries until a measurement frame arrives', async () => {
    const write = vi.fn<DriverIO['write']>().mockResolvedValue(undefined);
    const waitForFrame = vi
      .fn<DriverIO['waitForFrame']>()
      .mockResolvedValueOnce(true) // control frame
      .mockResolvedValueOnce(false) // 1st GET_DATA: no measurement
      .mockResolvedValueOnce(false) // 2nd GET_DATA: no measurement
      .mockResolvedValueOnce(true); // 3rd GET_DATA: measurement!
    const io: DriverIO = { write, waitForFrame };

    await uniT.handshake(io);

    // 1 GET_NAME + 3 GET_DATA writes.
    expect(write).toHaveBeenCalledTimes(4);
    expect(write.mock.calls[0]![0]).toBe(COMMANDS.GET_NAME);
    for (const call of write.mock.calls.slice(1)) {
      expect(call[0]).toBe(COMMANDS.GET_DATA);
    }
  });

  it('throws after exhausting the 5-attempt retry budget when no measurement ever arrives', async () => {
    const write = vi.fn<DriverIO['write']>().mockResolvedValue(undefined);
    const waitForFrame = vi
      .fn<DriverIO['waitForFrame']>()
      .mockResolvedValueOnce(true) // control frame seen
      .mockResolvedValue(false); // every GET_DATA attempt times out
    const io: DriverIO = { write, waitForFrame };

    await expect(uniT.handshake(io)).rejects.toThrow(/did not start streaming/);
    // GET_NAME + 5 GET_DATA attempts.
    expect(write).toHaveBeenCalledTimes(6);
  });

  it('still throws if the control frame never arrives (proceeds to GET_DATA retries)', async () => {
    const write = vi.fn<DriverIO['write']>().mockResolvedValue(undefined);
    // Control wait false, and all measurement waits false → exhausts the budget and throws.
    const waitForFrame = vi.fn<DriverIO['waitForFrame']>().mockResolvedValue(false);
    const io: DriverIO = { write, waitForFrame };

    await expect(uniT.handshake(io)).rejects.toThrow(/did not start streaming/);
  });
});

describe('uni-t onRequest', () => {
  function frame(kind: ParsedFrame['kind']): ParsedFrame {
    return { kind, bytes: Uint8Array.from([0xab, 0xcd]) };
  }

  it('re-sends GET_NAME on a type-request', () => {
    const write = vi.fn<DriverIO['write']>().mockResolvedValue(undefined);
    const io: DriverIO = { write, waitForFrame: vi.fn() };
    uniT.onRequest(frame('type-request'), io);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toBe(COMMANDS.GET_NAME);
  });

  it('re-sends GET_DATA on a data-request', () => {
    const write = vi.fn<DriverIO['write']>().mockResolvedValue(undefined);
    const io: DriverIO = { write, waitForFrame: vi.fn() };
    uniT.onRequest(frame('data-request'), io);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toBe(COMMANDS.GET_DATA);
  });

  it('does nothing for a measurement or control frame', () => {
    const write = vi.fn<DriverIO['write']>().mockResolvedValue(undefined);
    const io: DriverIO = { write, waitForFrame: vi.fn() };
    uniT.onRequest(frame('measurement'), io);
    uniT.onRequest(frame('control'), io);
    expect(write).not.toHaveBeenCalled();
  });
});
