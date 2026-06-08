// The driver registry. The transport offers every driver's service UUID + name prefix to
// requestDevice, then selects the matching driver post-connect. Phase 6 grows this array;
// nothing above the transport changes (PLAN §6).

import type { Driver, DriverMatchContext } from './types';
import { uniT } from './uni-t';
import { ut171 } from './ut171';
import { ut181a } from './ut181a';
import { ut117c } from './ut117c';
import { ut219p } from './ut219p';
import { bdm } from './bdm';
import { owonPlus } from './owon-plus';
import { owonOld } from './owon-old';
import { voltcraft } from './voltcraft';
import { aiCare } from './ai-care';

// Two shared-service families, disambiguated differently:
//   * ISSC (FE7D): uni-t (UT60BT/UT161), ut171, ut181a, ut117c, ut219p. These meters emit NO
//     frame until a model-specific handshake, so they can't be sniffed — the session routes them
//     by advertised name (each driver's match is name-only; see realConnect).
//   * 0xFFF0: bdm/owon-plus/owon-old/voltcraft free-stream, so they're told apart by frame-sniffing
//     (`Driver.sniff`) once the first frame arrives. ai-care (FFB0) owns its service outright.
export const drivers: Driver[] = [
  uniT,
  ut171,
  ut181a,
  ut117c,
  ut219p,
  bdm,
  owonPlus,
  owonOld,
  voltcraft,
  aiCare,
];

/** Every distinct GATT service UUID, for requestDevice `optionalServices`. */
export function allServices(): string[] {
  return [...new Set(drivers.map(d => d.gatt.service))];
}

/** Every distinct advertised-name prefix, for requestDevice `filters`. */
export function allNamePrefixes(): string[] {
  return [...new Set(drivers.flatMap(d => d.namePrefixes))];
}

/** Pick the driver for a freshly connected device (advertised service / name). */
export function selectDriver(ctx: DriverMatchContext): Driver | undefined {
  return drivers.find(d => d.match(ctx));
}

export function driverById(id: string): Driver | undefined {
  return drivers.find(d => d.id === id);
}

/** All drivers exposing a given GATT service. >1 means the session must sniff to disambiguate. */
export function driversForService(service: string): Driver[] {
  return drivers.filter(d => d.gatt.service === service);
}

/** Pick the driver among `candidates` whose `sniff` accepts this raw frame (first match wins). */
export function sniffDriver(candidates: Driver[], frame: Uint8Array): Driver | undefined {
  return candidates.find(d => d.sniff?.(frame) ?? false);
}
