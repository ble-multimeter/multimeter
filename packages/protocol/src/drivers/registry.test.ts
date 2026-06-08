// Registry surface: the discovery helpers the transport relies on (distinct services + name
// prefixes for requestDevice), the lookup/selection functions, and the FFF0-collision plumbing
// (driversForService + sniffDriver). disambiguation.test.ts covers the cross-family sniff matrix;
// this file pins down the registry functions themselves, including the miss/no-match branches.
import { describe, it, expect } from 'vitest';
import {
  drivers,
  allServices,
  allNamePrefixes,
  selectDriver,
  driverById,
  driversForService,
  sniffDriver,
} from './registry';

const FFF0 = '0000fff0-0000-1000-8000-00805f9b34fb';
const FE7D = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const FFB0 = '0000ffb0-0000-1000-8000-00805f9b34fb';

describe('allServices', () => {
  it('returns each distinct GATT service exactly once', () => {
    const services = allServices();
    expect(new Set(services).size).toBe(services.length);
    // The three families collapse to three services (FFF0 shared by four drivers).
    expect(services.sort()).toEqual([FFF0, FFB0, FE7D].sort());
  });
});

describe('allNamePrefixes', () => {
  it('returns distinct prefixes (deduped across drivers that share one, e.g. "BDM")', () => {
    const prefixes = allNamePrefixes();
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // BDM is listed by bdm/owon-plus/owon-old; OWON by owon-plus/owon-old — each appears once.
    expect(prefixes.filter(p => p === 'BDM')).toHaveLength(1);
    expect(prefixes.filter(p => p === 'OWON')).toHaveLength(1);
    expect(prefixes).toContain('UT60BT');
  });
});

describe('driverById', () => {
  it('returns the matching driver', () => {
    expect(driverById('uni-t')?.id).toBe('uni-t');
    expect(driverById('voltcraft')?.id).toBe('voltcraft');
  });

  it('returns undefined for an unknown id', () => {
    expect(driverById('does-not-exist')).toBeUndefined();
  });
});

describe('selectDriver', () => {
  it('selects by advertised service', () => {
    expect(selectDriver({ services: [FE7D] })?.id).toBe('uni-t');
    expect(selectDriver({ services: [FFB0] })?.id).toBe('ai-care');
  });

  it('selects by advertised name prefix', () => {
    expect(selectDriver({ name: 'UT60BT-1234' })?.id).toBe('uni-t');
    expect(selectDriver({ name: 'AICARE-9' })?.id).toBe('ai-care');
  });

  it('on the shared FFF0 service returns the first registered candidate (bdm)', () => {
    // selectDriver is first-match; the session sniffs frames to refine within FFF0.
    expect(selectDriver({ services: [FFF0] })?.id).toBe('bdm');
  });

  it('returns undefined when nothing matches', () => {
    expect(
      selectDriver({ name: 'Unknown', services: ['0000abcd-0000-1000-8000-00805f9b34fb'] }),
    ).toBeUndefined();
    expect(selectDriver({})).toBeUndefined();
  });
});

describe('driversForService', () => {
  it('returns all four families on the shared FFF0 service', () => {
    expect(driversForService(FFF0)).toHaveLength(4);
  });

  it('returns the whole ISSC family on FE7D (name-routed) and one driver on FFB0', () => {
    expect(driversForService(FE7D).map(d => d.id)).toEqual([
      'uni-t',
      'ut171',
      'ut181a',
      'ut117c',
      'ut219p',
      'ut202bt',
    ]);
    expect(driversForService(FFB0)).toHaveLength(1);
  });

  it('returns an empty array for an unknown service', () => {
    expect(driversForService('0000abcd-0000-1000-8000-00805f9b34fb')).toEqual([]);
  });
});

describe('sniffDriver', () => {
  const candidates = driversForService(FFF0);

  it('picks the family whose sniffer accepts the frame (first match wins)', () => {
    const bdmFrame = Uint8Array.from([27, 132, 112, 177, 41, 123, 191, 123, 102, 172, 59]);
    const owonPlusFrame = Uint8Array.from([34, 240, 4, 0, 103, 132]);
    expect(sniffDriver(candidates, bdmFrame)?.id).toBe('bdm');
    expect(sniffDriver(candidates, owonPlusFrame)?.id).toBe('owon-plus');
  });

  it('returns undefined when no candidate accepts the frame', () => {
    // 3-byte garbage: too short for any FFF0 family.
    expect(sniffDriver(candidates, Uint8Array.from([0x00, 0x01, 0x02]))).toBeUndefined();
  });

  it('returns undefined when a candidate has no sniffer (?? false fallback)', () => {
    // uni-t has no `sniff`; the `?? false` keeps sniffDriver from picking it.
    const uniT = driverById('uni-t')!;
    expect(sniffDriver([uniT], Uint8Array.from([0xab, 0xcd, 0x03]))).toBeUndefined();
  });

  it('returns undefined for an empty candidate list', () => {
    expect(sniffDriver([], Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });
});

describe('drivers array', () => {
  it('registers all eleven known drivers in order (ISSC family first, then 0xFFF0, then FFB0)', () => {
    expect(drivers.map(d => d.id)).toEqual([
      'uni-t',
      'ut171',
      'ut181a',
      'ut117c',
      'ut219p',
      'ut202bt',
      'bdm',
      'owon-plus',
      'owon-old',
      'voltcraft',
      'ai-care',
    ]);
  });
});
