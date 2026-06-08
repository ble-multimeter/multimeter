// UT202BT driver: it reuses the shared AB-CD framer + decode() (covered by framing.test.ts /
// decode.test.ts), so here we pin the driver wiring: name-only match, decode delegation, the shared
// framer, and the RANGE/HOLD control commands.
import { describe, it, expect } from 'vitest';
import { ut202bt } from './ut202bt';
import { COMMANDS } from '../framing';

const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';

// A real 19-byte AB-CD measurement frame (ACV 274.7 V) — the UT202BT shares this frame format.
const FRAME = Uint8Array.from([
  0xab, 0xcd, 0x10, 0x00, 0x30, 0x20, 0x20, 0x32, 0x37, 0x34, 0x2e, 0x37, 0x00, 0x00, 0x00, 0x00,
  0x08, 0x03, 0x02,
]);

describe('ut202bt match', () => {
  it('matches the UT202BT name prefix', () => {
    expect(ut202bt.match({ name: 'UT202BT-1234' })).toBe(true);
  });

  it('does NOT claim the shared ISSC service by itself (name-routed family)', () => {
    expect(ut202bt.match({ services: [ISSC_SERVICE] })).toBe(false);
    expect(ut202bt.match({ name: 'UT60BT-1' })).toBe(false);
    expect(ut202bt.match({})).toBe(false);
  });
});

describe('ut202bt wiring', () => {
  it('uses the shared GATT/profile of the ISSC family', () => {
    expect(ut202bt.gatt.service).toBe(ISSC_SERVICE);
  });

  it('createFramer returns a working FrameParser', () => {
    const out = ut202bt.createFramer().push(FRAME);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('measurement');
  });

  it('decode delegates to the shared decode()', () => {
    const r = ut202bt.decode(FRAME, 42);
    expect(r.function).toBe('ACV');
    expect(r.displayValue).toBeCloseTo(274.7, 6);
    expect(r.ts).toBe(42);
  });

  it('exposes the RANGE and HOLD controls shared with the UT60BT panel', () => {
    expect(ut202bt.controls?.range).toEqual(COMMANDS.RANGE);
    expect(ut202bt.controls?.hold).toEqual(COMMANDS.HOLD);
    // backlight/select/etc. are not present on the UT202BT front panel.
    expect(ut202bt.controls?.backlight).toBeUndefined();
  });
});
