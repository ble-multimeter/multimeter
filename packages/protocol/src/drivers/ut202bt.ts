// UT202BT driver — the UNI-T UT202BT AC clamp meter. In the UNI-T Smart Measure app it is a
// "deviceType 1" device: it streams the SAME AB-CD 19-byte frame as the UT60BT and is decoded by
// the same routine, so we reuse this package's shared decode() + FrameParser + handshake. The
// shared function table already covers the clamp's ACA/DCA/ACV/OHM functions (decode.ts/types.ts).
//
// The connect handshake and the RANGE (0x46) / HOLD (0x4A) controls are the same AB-CD commands as
// the UT60BT. The clamp's front panel additionally has direct function-select keys that are NOT
// part of the generic control set (from Anjianview2): ACA 0x31, ACV 0x33, Ω 0x35, NCV 0x36.
//
// verification: 'ported-unverified' — the decode path is the live-tested UT60BT one, but no
// physical UT202BT clamp was bench-tested (function/range behaviour on a clamp is inferred).

import { decode } from '../decode';
import { FrameParser, COMMANDS } from '../framing';
import type { Driver } from './types';

// Shared ISSC "Transparent UART" service (same family as uni-t.ts; the registry/session route this
// family by advertised name so the drivers don't fight over the service).
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const ISSC_WRITE_FALLBACK = '49535343-6daa-4d02-abf6-19569aca69fe';

export const ut202bt: Driver = {
  id: 'ut202bt',
  label: 'UNI-T UT202BT Clamp',
  verification: 'ported-unverified',
  namePrefixes: ['UT202BT'],
  gatt: { service: ISSC_SERVICE, notify: ISSC_NOTIFY, write: [ISSC_WRITE, ISSC_WRITE_FALLBACK] },

  // Name-only match: it shares the ISSC service with the rest of the UNI-T handheld family, which
  // the session disambiguates by advertised name (it can't be sniffed before the handshake).
  match: ctx => ctx.name?.startsWith('UT202BT') ?? false,

  createFramer: () => new FrameParser(),

  // Identical to the UT60BT: ask for the name (control) frame, then nudge GET-DATA until the
  // measurement stream starts.
  async handshake(io) {
    await io.write(COMMANDS.GET_NAME);
    await io.waitForFrame(k => k === 'control', 1500);
    for (let attempt = 0; attempt < 5; attempt++) {
      await io.write(COMMANDS.GET_DATA);
      if (await io.waitForFrame(k => k === 'measurement', 700)) return;
    }
    throw new Error('meter did not start streaming after handshake');
  },

  onRequest(frame, io) {
    if (frame.kind === 'type-request') void io.write(COMMANDS.GET_NAME);
    else if (frame.kind === 'data-request') void io.write(COMMANDS.GET_DATA);
  },

  decode: (bytes, ts) => decode(bytes, ts),

  // Only the controls shared with the UT60BT panel are exposed generically; the ACA/ACV/Ω/NCV
  // function-select keys are clamp-specific and intentionally left out of the MeterControl union.
  controls: {
    range: COMMANDS.RANGE,
    hold: COMMANDS.HOLD,
  },
};
