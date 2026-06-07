// The driver registry. The transport offers every driver's service UUID + name prefix to
// requestDevice, then selects the matching driver post-connect. Phase 6 grows this array;
// nothing above the transport changes (PLAN §6).

import type { Driver, DriverMatchContext } from './types';
import { uniT } from './uni-t';
import { bdm } from './bdm';

export const drivers: Driver[] = [uniT, bdm];

/** Every distinct GATT service UUID, for requestDevice `optionalServices`. */
export function allServices(): string[] {
  return [...new Set(drivers.map((d) => d.gatt.service))];
}

/** Every distinct advertised-name prefix, for requestDevice `filters`. */
export function allNamePrefixes(): string[] {
  return [...new Set(drivers.flatMap((d) => d.namePrefixes))];
}

/** Pick the driver for a freshly connected device (advertised service / name). */
export function selectDriver(ctx: DriverMatchContext): Driver | undefined {
  return drivers.find((d) => d.match(ctx));
}

export function driverById(id: string): Driver | undefined {
  return drivers.find((d) => d.id === id);
}
