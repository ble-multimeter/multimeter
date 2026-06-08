// The 0xFFF0 GATT service is shared by four meter families (bdm/owon-plus/owon-old/voltcraft).
// The transport can't tell them apart by service, so the session sniffs the first frame. This
// test locks in the guarantee that makes that safe: on REAL frames, the sniffers are MUTUALLY
// EXCLUSIVE — every frame is claimed by exactly one driver — and the unique-service drivers
// (uni-t/ai-care) never collide. Frames below are real captures lifted from each driver's tests.
import { describe, it, expect } from 'vitest';
import { drivers, driverById, driversForService, sniffDriver } from './registry';

const FFF0 = '0000fff0-0000-1000-8000-00805f9b34fb';

// One representative real frame per FFF0 family (from each driver's own fixture set).
const FRAMES: Record<string, number[]> = {
  bdm: [27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59], // 11 bytes, header 0x1B 0x84
  'owon-plus': [34, 240, 4, 0, 103, 132], // 6 bytes
  'owon-old': [43, 50, 55, 52, 54, 32, 52, 49, 0, 64, 128, 27, 13, 10], // 14 bytes, ASCII + CRLF
  voltcraft: [36, 0, 240, 33, 21, 0, 161, 9, 240, 33, 21, 0, 4, 0, 0], // 15 bytes, 0xF0 markers
};

describe('FFF0 driver disambiguation', () => {
  const candidates = driversForService(FFF0);

  it('all four FFF0 families are candidates on the shared service', () => {
    expect(candidates.map(d => d.id).sort()).toEqual(['bdm', 'owon-old', 'owon-plus', 'voltcraft']);
  });

  it('sniffDriver picks the correct family for each real frame', () => {
    for (const [id, frame] of Object.entries(FRAMES)) {
      const picked = sniffDriver(candidates, Uint8Array.from(frame));
      expect(picked?.id, `frame for ${id}`).toBe(id);
    }
  });

  it('every real frame is accepted by EXACTLY ONE driver (mutually exclusive sniffers)', () => {
    for (const [id, frame] of Object.entries(FRAMES)) {
      const matches = candidates.filter(d => d.sniff?.(Uint8Array.from(frame)));
      expect(
        matches.map(d => d.id),
        `frame for ${id}`,
      ).toEqual([id]);
    }
  });

  it('ai-care owns its FFB0 service alone (no sniffing needed)', () => {
    const aiCare = driverById('ai-care')!;
    expect(driversForService(aiCare.gatt.service)).toEqual([aiCare]);
    expect(aiCare.sniff).toBeUndefined();
    // The ISSC family (FE7D) also shares a service but is name-routed, not sniffed — see the
    // registry/session. This block only governs the 0xFFF0 free-streaming families.
  });

  it('every FFF0 driver exposes a sniffer (required to disambiguate)', () => {
    for (const d of candidates) expect(typeof d.sniff).toBe('function');
  });

  it('the registry holds all eleven drivers', () => {
    expect(drivers.map(d => d.id).sort()).toEqual([
      'ai-care',
      'bdm',
      'owon-old',
      'owon-plus',
      'uni-t',
      'ut117c',
      'ut171',
      'ut181a',
      'ut202bt',
      'ut219p',
      'voltcraft',
    ]);
  });
});
