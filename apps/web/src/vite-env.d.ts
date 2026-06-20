/// <reference types="vite/client" />

import type { MeterSnapshot } from '@ble-multimeter/web-bluetooth';

declare global {
  interface Window {
    // Dev-only hook installed by App for the BLE matrix harness (tools/ble-matrix). Absent in
    // production builds. `meters()` returns each channel's id + live snapshot (incl. driverId).
    __bleMatrix?: {
      meters: () => Array<{ id: string } & Partial<MeterSnapshot>>;
      connect: (i?: number) => void;
      disconnect: (i?: number) => void;
    };
  }
}
