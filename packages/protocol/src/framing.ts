// Buffered framing state machine + fixed command frames (PROTOCOL §2-3).
// No BLE deps — fully testable. One notification != one frame: chunks may split or
// coalesce, so we accumulate bytes, sync on AB CD, slice by the <len> byte, and
// validate the trailing 16-bit checksum on measurement frames to detect/recover desync.

// Fixed command frames `AB CD <len> <cmd> <param> <checksum>`, hardcoded (PROTOCOL §2).
// `new Uint8Array([...])` gives a Uint8Array<ArrayBuffer>, which Web Bluetooth's writeValue*
// (BufferSource) accepts. The trailing two bytes are a 16-bit big-endian checksum of the
// preceding bytes: 0xAB + 0xCD + 0x03 + cmd (= cmd + 0x17B).
//
// The soft-button controls (0x41–0x4C block) were reverse-engineered from the UNI-T Smart
// Measure Android app (`Anjianview2` → `BleManager.sendCmd`); each maps to a front-panel key.
export const COMMANDS = {
  GET_NAME: new Uint8Array([0xab, 0xcd, 0x03, 0x5f, 0x01, 0xda]),
  GET_DATA: new Uint8Array([0xab, 0xcd, 0x03, 0x5d, 0x01, 0xd8]),
  BACKLIGHT: new Uint8Array([0xab, 0xcd, 0x03, 0x4b, 0x01, 0xc6]), // cmd 0x4b
  MAXMIN: new Uint8Array([0xab, 0xcd, 0x03, 0x41, 0x01, 0xbc]), // cmd 0x41 — MAX/MIN
  RANGE: new Uint8Array([0xab, 0xcd, 0x03, 0x46, 0x01, 0xc1]), // cmd 0x46 — step manual range
  RANGE_AUTO: new Uint8Array([0xab, 0xcd, 0x03, 0x47, 0x01, 0xc2]), // cmd 0x47 — RANGE long-press (auto)
  REL: new Uint8Array([0xab, 0xcd, 0x03, 0x48, 0x01, 0xc3]), // cmd 0x48 — relative
  HZ_DUTY: new Uint8Array([0xab, 0xcd, 0x03, 0x49, 0x01, 0xc4]), // cmd 0x49 — Hz / duty %
  HOLD: new Uint8Array([0xab, 0xcd, 0x03, 0x4a, 0x01, 0xc5]), // cmd 0x4a — data hold
  SELECT: new Uint8Array([0xab, 0xcd, 0x03, 0x4c, 0x01, 0xc7]), // cmd 0x4c — function/mode select
} as const;

export type FrameKind = 'measurement' | 'type-request' | 'data-request' | 'control';

export interface ParsedFrame {
  kind: FrameKind;
  bytes: Uint8Array;
}

// Measurement checksum (PROTOCOL §3): bytes[17..18] = Σ(bytes[0..16]) as 16-bit
// big-endian. (Control frames use a different one-byte scheme; we don't validate those.)
export function checksumOk(frame: Uint8Array): boolean {
  if (frame.length !== 19) return false;
  let sum = 0;
  for (let i = 0; i <= 16; i++) sum += frame[i]!;
  return ((sum >> 8) & 0xff) === frame[17] && (sum & 0xff) === frame[18];
}

function classify(total: number): FrameKind {
  if (total === 19) return 'measurement';
  if (total === 9) return 'type-request'; // AB CD .. AA AA .. → re-send GET-NAME
  if (total === 7) return 'data-request'; // AB CD .. FF 00 .. → re-send GET-DATA
  return 'control'; // 11-byte name frame, etc.
}

export class FrameParser {
  private buf: number[] = [];

  /** Feed a raw notification chunk; returns every complete frame it completes. */
  push(chunk: Uint8Array): ParsedFrame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!);

    const out: ParsedFrame[] = [];
    for (;;) {
      this.sync();
      if (this.buf.length < 3) break; // need at least AB CD <len>

      const total = this.buf[2]! + 3; // <len> counts the bytes after it
      if (total < 4 || total > 64) {
        // Bogus length — almost certainly a false AB CD inside noise. Drop one byte
        // and resync rather than waiting forever for a frame that won't come.
        this.buf.shift();
        continue;
      }
      if (this.buf.length < total) break; // frame split across notifications — wait

      const frame = Uint8Array.from(this.buf.slice(0, total));
      if (total === 19 && !checksumOk(frame)) {
        this.buf.shift(); // desync: this wasn't really a frame boundary, resync past it
        continue;
      }
      this.buf.splice(0, total);
      out.push({ kind: classify(total), bytes: frame });
    }
    return out;
  }

  reset(): void {
    this.buf.length = 0;
  }

  // Drop leading bytes until the buffer starts with a plausible AB CD header.
  private sync(): void {
    while (this.buf.length >= 1) {
      if (this.buf[0] !== 0xab) {
        this.buf.shift();
        continue;
      }
      if (this.buf.length >= 2 && this.buf[1] !== 0xcd) {
        this.buf.shift(); // lone AB followed by non-CD: false start
        continue;
      }
      break; // buf[0] === AB and (buf[1] === CD, or we don't have it yet)
    }
  }
}
