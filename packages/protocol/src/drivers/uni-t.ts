// UNI-T BLE driver (DevType 4 in the source Windows app). Wraps this package's uni-t framing
// (FrameParser/COMMANDS) and decode, plus the handshake/keep-alive logic that previously lived
// inline in the React useMeter hook (PROTOCOL §1-3). live-tested on a physical UT60BT.

import { decode } from '../decode';
import { FrameParser, COMMANDS } from '../framing';
import type { Driver } from './types';

// ISSC "Transparent UART" — the confirmed stream (PROTOCOL §1). The 0xd0ff vendor service has
// no notify characteristic, so it isn't part of the profile.
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
const ISSC_WRITE_FALLBACK = '49535343-6daa-4d02-abf6-19569aca69fe';

export const uniT: Driver = {
  id: 'uni-t',
  label: 'UNI-T BLE',
  verification: 'live-tested',
  // UT60BT and the UT161 series (UT161A/B/C/D/E) stream the same AB-CD 19-byte frame and are
  // routed through this same generic decoder by the Smart Measure app. NOTE: UT171/UT181 share
  // this ISSC service but have their own protocols — when those drivers land, this service-based
  // match must become name-based so it stops greedily claiming them (see PLAN: ISSC name-routing).
  namePrefixes: ['UT60BT', 'UT161'],
  gatt: { service: ISSC_SERVICE, notify: ISSC_NOTIFY, write: [ISSC_WRITE, ISSC_WRITE_FALLBACK] },

  match: ctx =>
    (ctx.services?.includes(ISSC_SERVICE) ?? false) ||
    (ctx.name?.startsWith('UT60BT') ?? false) ||
    (ctx.name?.startsWith('UT161') ?? false),

  createFramer: () => new FrameParser(),

  // Event-driven handshake: the meter ignores GET-DATA before it has answered GET-NAME, so wait
  // for the name (control) frame first, then keep nudging GET-DATA until measurements start.
  async handshake(io) {
    await io.write(COMMANDS.GET_NAME);
    await io.waitForFrame(k => k === 'control', 1500);
    for (let attempt = 0; attempt < 5; attempt++) {
      await io.write(COMMANDS.GET_DATA);
      if (await io.waitForFrame(k => k === 'measurement', 700)) return;
    }
    throw new Error('meter did not start streaming after handshake');
  },

  // The meter periodically asks us to re-send its identity / re-arm the data stream.
  onRequest(frame, io) {
    if (frame.kind === 'type-request') void io.write(COMMANDS.GET_NAME);
    else if (frame.kind === 'data-request') void io.write(COMMANDS.GET_DATA);
  },

  decode: (bytes, ts) => decode(bytes, ts),

  // Front-panel soft buttons, reverse-engineered from the UNI-T Smart Measure app. Same AB-CD
  // write characteristic as the handshake; the meter actions them as if the key were pressed.
  controls: {
    backlight: COMMANDS.BACKLIGHT,
    hold: COMMANDS.HOLD,
    rel: COMMANDS.REL,
    select: COMMANDS.SELECT,
    range: COMMANDS.RANGE,
    rangeAuto: COMMANDS.RANGE_AUTO,
    hzDuty: COMMANDS.HZ_DUTY,
    maxMin: COMMANDS.MAXMIN,
  },
};
