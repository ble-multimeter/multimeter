# Bluetooth DMM clones (Aneng / BSIDE / ZOYI / BABATools) — `bdm`

> **State:** `live-tested` — bench-validated on an **Aneng AN9002** (device-type AB_300, 11-byte) and a **ZOYI ZT-5B** (device-type S_5G, 10-byte) — see [Verification](#verification). **Driver:** `packages/protocol/src/drivers/bdm.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` `DecoderBluetoothDMM.cs` (`BDMDecode`, 11-byte path), verified vs 36 annotated frames in `Binary raw data.md`.
>
> **Device-types.** `bdm` dispatches on descrambled `byte[2]`: **AB_300 (3, 11 B)** and **S_5G (2, 10 B)** are decoded; **QB_5G (1)** and **P_66 (4)** are not. The sections below describe the AB_300 11-byte layout in detail; S_5G shares the digit decode but uses a different annunciator bit layout (its `max`/`min`/`auto` bit positions are not yet confirmed and read as `false`).

The `bdm` driver decodes a large family of rebadged "Bluetooth DMM" handheld multimeters — sold under the Aneng, BSIDE, ZOYI and BABATools brands — that all expose the same GATT layout (`DevType 0` / service `0xFFF0`) and the same on-wire frame. The meter does not handshake or answer requests; the moment a client subscribes to the notify characteristic it free-streams one 11-byte notification per LCD update. Each byte is XOR-scrambled with a fixed 11-element key; descrambling yields an 88-bit field from which four 7-segment digits, a set of unit annunciator bits, AC/DC bits, diode/continuity bits and status flags (max/min/hold/rel/auto/low-battery) are read at fixed bit offsets. There is no checksum and no sync word; framing keys off the constant first two raw bytes (`0x1B 0x84`). The driver is receive-only — it exposes no controls. Everything below is derived from `bdm.ts`; bit offsets and the descramble key are quoted directly from the code.

## Models

One decoder unlocks roughly a dozen rebadged clones. The model list comes from the driver header comment (`bdm.ts:2-3`, PLAN §6):

| Brand | Models |
| --- | --- |
| Aneng | V05B, AN9002, ST207, AN999S |
| BSIDE | ZT-5B, ZT-300AB, ZT-5BQ |
| ZOYI | ZT-5B, ZT-300AB, ZT-5BQ, ZT-5566SE |
| BABATools | AD900 |

These meters advertise inconsistent BLE names (`"BDM"` is the common prefix), so discovery leans on the service-UUID filter rather than the name (`bdm.ts:250-256`).

## Transport (GATT)

GATT profile (`bdm.ts:242-244, 253`):

| Role | UUID |
| --- | --- |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` (`0xFFF0`) |
| Notify | `0000fff4-0000-1000-8000-00805f9b34fb` (`0xFFF4`) |
| Write | `0000fff3-0000-1000-8000-00805f9b34fb` (`0xFFF3`) |

The write characteristic is declared for profile-completeness only; the driver never writes (no handshake, no keep-alive, no controls).

**Routing.** The `0xFFF0` service is shared by several unrelated families (`owon-plus`, `owon-old`, `voltcraft`), so service UUID alone is not enough to pick the decoder. `match()` accepts the device when it advertises `0xFFF0` **or** its name starts with `"BDM"` (`bdm.ts:255-256`), and the session then disambiguates by sniffing the first raw notification frame against each candidate driver's `sniff()` predicate.

**Frame-sniff rule** (`looksLikeBdmFrame`, `bdm.ts:238-240`). A frame is a BDM frame iff it is exactly 11 bytes long and starts with the constant raw header `0x1B 0x84`:

```ts
bytes.length === 11 && bytes[0] === 0x1b && bytes[1] === 0x84
```

This is distinct from the other `0xFFF0` families by length alone — `owon-plus` is 6 bytes, `owon-old` is 14, `voltcraft` is 15 (`bdm.ts:235-236`).

## Handshake / session start

None. The driver's `handshake()` is a no-op (`bdm.ts:261-263`) and `onRequest()` is a no-op (`bdm.ts:266-268`): there is no AB-CD sync, no challenge/response, and no request/response keep-alive in this family. Subscribing to the `0xFFF4` notify characteristic is sufficient — the meter streams measurement notifications immediately and continuously.

## Frame format

One BLE notification carries exactly one 11-byte frame (`FRAME_LEN = 11`, `bdm.ts:23`). The frame has:

- **No AB-CD sync word.**
- **No checksum.**
- **A constant 2-byte raw header:** the first two raw bytes are always `0x1B 0x84` (`SYNC0`/`SYNC1`, `bdm.ts:25-26`). This is the descrambled-back constant `0x1B84` and is used purely to sync the stream.

**XOR descramble.** Each raw byte `i` is XOR'd with `DATASHIFT[i]` and masked to 8 bits, then the 11 resulting bytes are concatenated MSB-first into an 88-character bit string the source calls `newValue` (`descramble`, `bdm.ts:51-58`):

```ts
bits += ((bytes[i] ^ DATASHIFT[i]) & 0xff).toString(2).padStart(8, '0');
```

The fixed key (`bdm.ts:21`) is the first 11 of the source app's 20-byte `datashift` array (only 11 are used for the 11-byte BDM frame):

```
DATASHIFT = [65, 33, 115, 85, 162, 193, 50, 113, 102, 170, 59]
```

(Source literal `{ 65, 33, 115, 85, 256-94, 256-63, 50, 113, 102, 256-86, 59, ... }`; the `256-n` terms reduce to `162, 193, 170`.)

After descrambling, all subsequent decoding indexes individual bits of the 88-bit string via `on(i) = (bits[i] === '1')` (`bdm.ts:124`). Bit 0 is the MSB of raw byte 0; bit `8*k` is the MSB of raw byte `k`.

**Framer / resync** (`BdmFramer`, `bdm.ts:199-231`). The framer buffers incoming chunks and, although in practice one notification equals one frame, tolerates split/coalesced notifications like the uni-t `FrameParser`. On each pass it calls `sync()` then, if at least 11 bytes are buffered, emits a `measurement` frame of the first 11 bytes and consumes them (`bdm.ts:205-211`). `sync()` (`bdm.ts:218-230`) discards leading bytes until the buffer starts with `0x1B`, and if a second byte is present discards again unless it is `0x84` — i.e. it slides the window to the next plausible `0x1B 0x84` header. `reset()` clears the buffer (`bdm.ts:214-216`).

## Decode

`decodeBdm(bytes, ts)` (`bdm.ts:121-194`) is pure and never throws; it degrades gracefully. A frame shorter than 11 bytes returns a `blank` reading (`bdm.ts:122`, blank shape at `bdm.ts:61-85`). An unknown 7-segment glyph renders as `'?'` (→ non-numeric → `displayValue` null) rather than erroring.

### Digits

Four 7-segment digits are read in a loop (`bdm.ts:128-138`). Each digit `n` (0..3) has a **prefix bit** (sign or decimal point), then a 7-bit segment field split into a 3-bit "first" group and a non-adjacent 4-bit "second" group:

| Per-digit field | Bit offset | Notes |
| --- | --- | --- |
| `first` (3 bits) | `(n+3)*8` .. `+3` | first half of segment lookup key |
| prefix bit | `(n+3)*8 + 3` | when set, emits `prePoints[n]` |
| `second` (4 bits) | `(n+4)*8 + 4` .. `+4` | second half of segment lookup key |

The prefix glyphs are `prePoints = ['-', '.', '.', '.']` (`bdm.ts:128`): digit 0's prefix is a leading minus sign, digits 1-3's prefixes are decimal points. The lookup key is the 7-char string `first + second`, resolved through the `SEG` table (`bdm.ts:29-49`):

| Key (`first`+`second`) | Glyph | | Key | Glyph |
| --- | --- | --- | --- | --- |
| `0000000` | (space) | | `1111011` | `0` |
| `1111110` | `A` | | `0001010` | `1` |
| `0010011` | `U` | | `1011101` | `2` |
| `0110101` | `T` | | `1001111` | `3` |
| `0010111` | `O` | | `0101110` | `4` |
| `1110101` | `E` | | `1100111` | `5` |
| `1110100` | `F` | | `1110111` | `6` |
| `0110001` | `L` | | `1001010` | `7` |
| `0000100` | `-` | | `1111111` | `8` |
| | | | `1101111` | `9` |

`A U T O`, `E`, `F`, `L` exist so the display can spell `AUTO`, error words (`EFLO`-style), and the `L` of an `OL` overload. The concatenated `prefix + glyph` for all four digits forms `text`, which is trimmed to `displayText` (`bdm.ts:136-138`).

### Unit annunciators

Individual bits, accumulated **in source order** so metric prefixes land before the base unit ("mV", "kΩ", "µA", "nF") (`bdm.ts:142-158`):

| Bit | Appends | Bit | Appends |
| --- | --- | --- | --- |
| 57 | `°C` | 74 | `m` |
| 58 | `°F` | 75 | `V` |
| 64 | `n` | 76 | `M` |
| 65 | `m` | 77 | `k` |
| 66 | `µ` | 78 | `Ω` |
| 67 | `F` | 79 | `Hz` |
| 69 | `%` | 85 | `µ` |
| 72 | `A` | 84 | `m` |
| 68/73 | (AC/DC, see below) | | |

So `displayUnit` is assembled by concatenation: e.g. bit 74 (`m`) + bit 75 (`V`) → `mV`; bit 77 (`k`) + bit 78 (`Ω`) → `kΩ`; bit 66 (`µ`) + bit 72 (`A`) → `µA`; bit 64 (`n`) + bit 67 (`F`) → `nF`; bits 57/58 → `°C`/`°F`. Current prefixes appear in two places (bits 65/66 near the cap group, and bits 84/85 near the current group) because the meter drives the same `A` annunciator (bit 72) with prefix bits from whichever range bank is active.

### AC/DC, diode, continuity

| Field | Bit(s) | Code ref |
| --- | --- | --- |
| `acdc` | `'AC'` if bit 68, else `'DC'` if bit 73, else `''` | `bdm.ts:160` |
| `diode` | bit 56 | `bdm.ts:161` |
| `cont` (continuity) | bit 28 | `bdm.ts:162` |

### Status flags

`Reading.flags` (`bdm.ts:182-192`):

| Flag | Bit | Code ref |
| --- | --- | --- |
| `max` | 71 | `bdm.ts:183` |
| `min` | 70 | `bdm.ts:184` |
| `hold` | 59 | `bdm.ts:185` |
| `rel` | 30 | `bdm.ts:186` |
| `auto` | 87 | `bdm.ts:187` |
| `lowBattery` | 31 | `bdm.ts:188` |
| `hvWarning` | — | always `false` — not surfaced in the 11-byte frame (`bdm.ts:189`) |
| `peakMax` | — | always `false` (`bdm.ts:190`) |
| `peakMin` | — | always `false` (`bdm.ts:191`) |

### Overload (OL) and value

Overload is detected textually: `overload = displayText.includes('L')` (`bdm.ts:164`). Because the decimal-point prefix floats with the selected range, the overload display can read `"OL"`, `"0.L"`, `"0L."` or `".0L"` — all contain `L`. A reading is numeric only when it is not overloaded and matches the `NUMERIC` regex `^-?\d*\.?\d+$` (`bdm.ts:114, 165`). `displayValue` is `Number(displayText)` when numeric, else `null` (`bdm.ts:166`).

### Normalization

`unitInfo(displayUnit)` (`types.ts:168-174`) splits the displayed unit into an SI `base` and a prefix exponent (`n`→−9, `µ`→−6, `m`→−3, `k`→3, `M`→6). `baseUnit` is the SI base (e.g. `Ω` from `kΩ`, `V` from `mV`, `F` from `nF`); `baseValue = displayValue * 10**exp` (`bdm.ts:168-169`), so range changes (mV↔V, kΩ↔MΩ) keep a continuous normalized curve. `bargraph` is always `0` (`bdm.ts:181`) — this family has no analog bar.

### Function key

`functionFor(baseUnit, acdc, diode, cont)` (`bdm.ts:89-112`) maps the decoded unit + mode to a range-independent function key so range steps stay one chart segment while a real mode change splits:

| Condition | `function` |
| --- | --- |
| `diode` | `DIODE` |
| `cont` | `CONT` |
| `baseUnit === 'V'` | `${acdc}V` (e.g. `ACV`/`DCV`) or `V` if no AC/DC |
| `baseUnit === 'A'` | `${acdc}A` or `A` |
| `baseUnit === 'Ω'` | `OHM` |
| `baseUnit === 'F'` | `CAP` |
| `baseUnit === 'Hz'` | `Hz` |
| `baseUnit === '%'` | `%` |
| `baseUnit === '°C'` | `°C` |
| `baseUnit === '°F'` | `°F` |
| else | `baseUnit` or `'?'` |

Note the diode/continuity checks come first, so they win over the unit-based mapping (a continuity reading carries `Ω` but reports `CONT`). The result feeds `quantityKey` (`types.ts:49-51`) as `function|acdc`, which controls chart-segment splitting.

## Controls

Receive-only. The driver declares no `controls` map (none in `bdm.ts:246-273`), and the write characteristic, while present in the GATT profile, is never used. There are no soft-button commands (RANGE/SELECT/HOLD/REL/Hz/MAX-MIN) for this family.

## Verification

`verification: 'live-tested'`. Two lines of evidence agree on this decoder:

1. The original port from `DecoderBluetoothDMM.cs` `BDMDecode` (the `data.Count() == 11` path), cross-checked against the 36 annotated frames in the source repo's `Binary raw data.md`.
2. **Physical hardware** — bench-validated on an **Aneng AN9002** (AB_300, 11-byte) and a **ZOYI ZT-5B** (S_5G, 10-byte). Confirmed live for the ZT-5B: value, unit (prefix+base), AC/DC, diode, continuity, hold, rel, low-battery. The S_5G `max`/`min`/`auto` bit positions remain unconfirmed and are left `false`.

The two decoded device-types share the 4-digit value decode (descrambled bytes 3–7) but differ in annunciator bit layout; the **Unit annunciators** and **Status flags** tables above describe the AB_300 (11-byte) layout. For AB_300, `max`/`min` (bits 71/70) and `%` (bit 69) are decoded but not independently cross-confirmed. `hvWarning`, `peakMax`, and `peakMin` are not represented in the frame and are hard-coded `false`. The framer's split/coalesced-notification handling is defensive; in practice one notification equals one frame, so multi-frame resync is untested against real traffic.

## Source

- Driver: `packages/protocol/src/drivers/bdm.ts`
- Shared types: `packages/protocol/src/drivers/types.ts` (`Driver`/`DriverFramer`), `packages/protocol/src/types.ts` (`Reading`, `unitInfo`)
- Upstream: `webspiderteam/Bluetooth-DMM-For-Windows` — `DecoderBluetoothDMM.cs` `BDMDecode` (11-byte path), `ParsedigitBDM` (7-segment table), `datashift` key; verified vs `Binary raw data.md` (36 annotated frames).
