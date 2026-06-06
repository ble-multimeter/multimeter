// Phase-0 protocol constants & helpers for the UNI-T UT60BT.
// See PROTOCOL.md. These are the values we're trying to *confirm* with a live capture,
// so treat anything here as a hypothesis until the dump agrees.

// ---- GATT (confirmed by static enumeration of our UT60BTk, 2026-06-06) ----
export const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
export const ISSC_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
export const ISSC_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
export const ISSC_WRITE_FALLBACK = '49535343-6daa-4d02-abf6-19569aca69fe';
export const D0FF_SERVICE = '0000d0ff-3c17-d293-8e48-14fe2e4da212';
export const DEVICE_INFO_SERVICE = 0x180a;

export const REQUEST_SERVICES: (string | number)[] = [
  ISSC_SERVICE,
  D0FF_SERVICE,
  DEVICE_INFO_SERVICE,
];

// ---- Fixed command frames (AB CD <len> <cmd> <param> <checksum>) ----
// `new Uint8Array([...])` yields a Uint8Array<ArrayBuffer>, which Web Bluetooth's
// writeValue* (BufferSource) accepts; Uint8Array.from() would widen to ArrayBufferLike.
export const COMMANDS = {
  GET_NAME: new Uint8Array([0xab, 0xcd, 0x03, 0x5f, 0x01, 0xda]),
  GET_DATA: new Uint8Array([0xab, 0xcd, 0x03, 0x5d, 0x01, 0xd8]),
  BACKLIGHT: new Uint8Array([0xab, 0xcd, 0x03, 0x4b, 0x01, 0xc6]),
} as const;

// ---- Experimental button commands (EA EC framing) ----
// From webspiderteam/Bluetooth-DMM-For-Windows GattMonitor.cs. ⚠️ UNVERIFIED on the UT60BT:
// the repo populates these for DevType 0/1/3 but leaves DevType 4 (our UT60BT) empty. The
// rotary FUNCTION dial is mechanical and can't be driven over BLE — these emulate the meter's
// pushbuttons (RANGE, SELECT-style sub-function, HOLD, etc.). Frame: EA EC 70 <btn> A2 C1 32 71 64 <chk>.
const btn = (code: number, chk: number) =>
  new Uint8Array([0xea, 0xec, 0x70, code, 0xa2, 0xc1, 0x32, 0x71, 0x64, chk]);

export const BUTTON_COMMANDS: { label: string; bytes: Uint8Array<ArrayBuffer> }[] = [
  { label: 'Auto Range', bytes: btn(0xed, 0x99) },
  { label: 'Hz', bytes: btn(0xe6, 0x84) },
  { label: 'mV', bytes: btn(0x93, 0xeb) },
  { label: 'OHM', bytes: btn(0xeb, 0x93) },
  { label: 'Capacitance', bytes: btn(0xe5, 0x81) },
  { label: 'Diode', bytes: btn(0xe4, 0x86) },
  { label: 'NCV', bytes: btn(0xe7, 0x87) },
  { label: 'A/mA', bytes: btn(0x9c, 0xee) },
  { label: 'AC/DC', bytes: btn(0x91, 0x95) },
  { label: '°C', bytes: btn(0xe3, 0x9b) },
  { label: '°F', bytes: btn(0xe2, 0x98) },
  { label: 'Hold', bytes: btn(0xe1, 0x85) },
  { label: 'Min/Max', bytes: btn(0x84, 0xe6) },
  { label: 'REL (ZERO)', bytes: btn(0xe0, 0x9a) },
];

// ---- Function table (index = frame[3] & 0x7F) ----
export const FUNCTIONS = [
  'ACV', 'ACmV', 'DCV', 'DCmV', 'Hz', '%', 'OHM', 'CONT', 'DIODE', 'CAP',
  '°C', '°F', 'DCuA', 'ACuA', 'DCmA', 'ACmA', 'DCA', 'ACA', 'HFE', 'Live',
  'NCV', 'LozV',
] as const;

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export type FrameKind = 'measurement' | 'type-request' | 'data-request' | 'unknown';

// Length-based classification (PROTOCOL §2-3). 19 bytes = measurement; the short
// AB-CD frames are keep-alive requests we must answer to keep the stream alive.
export function classifyFrame(b: Uint8Array): FrameKind {
  const framed = b.length >= 2 && b[0] === 0xab && b[1] === 0xcd;
  if (b.length === 19) return 'measurement';
  if (framed && b.length === 9) return 'type-request';
  if (framed && b.length === 7) return 'data-request';
  return 'unknown';
}

export interface TentativeDecode {
  fnIndex: number;
  fnName: string;
  fnBit7: boolean;
  rangeChar: string;
  rangeIndex: number;
  display: string;
  flagsA: number;
  flagsB: number;
  flagsC: number;
}

// Best-effort decode of a 19-byte frame, purely so we can eyeball codes per dial
// position while capturing. NOT the real decoder — that lands in Phase 1, tested.
export function tentativeDecode(b: Uint8Array): TentativeDecode | null {
  if (b.length !== 19) return null;
  const fnIndex = b[3] & 0x7f;
  return {
    fnIndex,
    fnName: FUNCTIONS[fnIndex] ?? `#${fnIndex}`,
    fnBit7: (b[3] & 0x80) !== 0,
    rangeChar: String.fromCharCode(b[4]),
    rangeIndex: b[4] - 0x30,
    display: new TextDecoder().decode(b.slice(5, 12)),
    flagsA: b[14],
    flagsB: b[15],
    flagsC: b[16],
  };
}
