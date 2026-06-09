# AICARE clamp meter (AP-570C-APP) — `ai-care`

> **State:** `untested` (ported, not bench-tested). **Driver:** `packages/protocol/src/drivers/ai-care.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` `Utilities.cs` `aiCareDecode` (`isBDM == 3`).

The `ai-care` driver decodes the AICARE family of Bluetooth clamp meters — `DevType 3` in the source Windows app's GATT table, GATT service `0xFFB0`. The meter performs no handshake and answers no requests; the moment a client subscribes to the notify characteristic it free-streams one 14-byte notification per LCD update. Unlike the XOR-scrambled BDM family, AICARE frames are **self-addressing**: every byte carries its own destination slot in its high nibble and 4 payload bits in its low nibble, so descrambling is a scatter-by-address rather than a fixed-key XOR. Concatenating the 14 low nibbles in addressed order yields a 56-bit field from which AC/DC/AUTO/BT flags, four 7-segment digits, and unit/status annunciator bits are read at fixed bit offsets. There is no checksum and no sync word; framing keys off each byte's self-address (the slot-1 byte marks the frame start). The driver is receive-only — it exposes no controls. Everything below is derived from `ai-care.ts`; nibble and bit offsets are quoted directly from the code.

## Models

The AICARE AP-570C-APP Bluetooth clamp meter and its rebadges (`ai-care.ts:1-2`). The model list is not enumerated in code beyond AP-570C-APP; rebadges share the same `0xFFB0` GATT layout and on-wire frame.

BLE advertised names vary across rebadges, so discovery leans on the service-UUID filter with the name as a hint. The driver's `namePrefixes` are `['AICARE', 'AI-Care']` (`ai-care.ts:231`).

## Transport (GATT)

GATT profile (`ai-care.ts:221-223, 232`):

| Role | UUID |
| --- | --- |
| Service | `0000ffb0-0000-1000-8000-00805f9b34fb` (`0xFFB0`) |
| Notify | `0000ffb2-0000-1000-8000-00805f9b34fb` (`0xFFB2`) |
| Write | `0000ffb1-0000-1000-8000-00805f9b34fb` (`0xFFB1`) |

The write characteristic is declared for profile-completeness only; the driver never writes (no handshake, no keep-alive, no controls).

**Routing.** AICARE **owns its own GATT service** (`0xFFB0`), so discovery is unambiguous — there is no collision with the `0xFFF0` group (bdm / owon-plus / owon-old / voltcraft) and no frame-sniff disambiguation is needed. `match()` accepts the device when it advertises `0xFFB0` **or** its name starts (case-insensitively) with `"AICARE"` (`ai-care.ts:234-236`):

```ts
(ctx.services?.includes(FFB0_SERVICE) ?? false) ||
(ctx.name?.toUpperCase().startsWith('AICARE') ?? false)
```

Because the service UUID is exclusive to this family, the driver declares no `sniff()` predicate — routing is by service UUID alone.

## Handshake / session start

None. The driver's `handshake()` is a no-op (`ai-care.ts:241-243`) and `onRequest()` is a no-op (`ai-care.ts:246-248`): there is no AB-CD sync, no challenge/response, and no request/response keep-alive in this family. Subscribing to the `0xFFB2` notify characteristic is sufficient — the meter streams measurement notifications immediately and continuously (`ai-care.ts:240`).

## Frame format

One BLE notification carries exactly one 14-byte frame (`FRAME_LEN = 14`, `ai-care.ts:21`). The frame has:

- **No AB-CD sync word.**
- **No checksum.**
- **No fixed header constant** — instead every byte is self-addressing.

**Self-addressing nibbles.** Each raw byte is split: the **high nibble is a 1-based slot index** and the **low nibble is 4 payload bits**. A byte at 0-based slot `i` reads `((b & 0xf0) >> 4) - 1 == i`. This self-address is exploited both to descramble (scatter each low nibble to its addressed slot) and to sync the stream (`ai-care.ts:9-16`).

**Descramble** (`descramble`, `ai-care.ts:45-54`). Start with 14 slots pre-filled with `'0000'`. For each of the 14 raw bytes, compute its addressed slot from the high nibble and write the low nibble (as a 4-char binary string) into that slot:

```ts
const slot = ((bytes[i]! & 0xf0) >> 4) - 1;
if (slot >= 0 && slot < FRAME_LEN) {
  slots[slot] = (bytes[i]! & 0x0f).toString(2).padStart(4, '0');
}
```

Out-of-range or duplicate addresses are silently ignored (graceful degradation — never throws). Unaddressed slots stay `'0000'`, which the 7-segment table reads as a blank digit / cleared flag. The 14 four-bit slots are then concatenated **in addressed order** into a 56-bit string the source calls `values` (`BIT_LEN = FRAME_LEN * 4 = 56`, `ai-care.ts:22, 53`). Bit `4*k` is the MSB of slot `k`'s payload nibble; all subsequent decoding indexes individual bits of this 56-bit string via `on(i) = (v[i] === '1')` (`ai-care.ts:122`).

**Framer / resync** (`AiCareFramer`, `ai-care.ts:194-219`). The framer buffers incoming chunks and, although in practice one notification equals one frame, tolerates split/coalesced notifications like the uni-t `FrameParser`. On each pass it calls `sync()` then, if at least 14 bytes are buffered, emits a `measurement` frame of the first 14 bytes and consumes them (`ai-care.ts:200-205`). `sync()` (`ai-care.ts:214-218`) discards leading bytes until the head byte's high nibble is `0x1` — i.e. a slot-1 byte, which marks the frame start. `reset()` clears the buffer (`ai-care.ts:209-211`).

## Decode

`decodeAiCare(bytes, ts)` (`ai-care.ts:118-188`) is pure and unit-tested; it degrades gracefully and never throws. A frame shorter than 14 bytes returns a `blank` reading (`ai-care.ts:119`, blank shape at `ai-care.ts:57-81`); likewise if descrambling yields fewer than 56 bits (`ai-care.ts:121`). An unknown 7-segment glyph renders as `'?'` (→ non-numeric → `displayValue` null) rather than erroring — the C# source indexes a Dictionary that would throw on an unknown key; this port uses a safe `?? '?'` lookup instead (`ai-care.ts:123, 112-117`).

Two helpers index the 56-bit string: `on(i)` tests a single bit, and `seg(start)` looks up the 7 bits `[start, start+7)` in the segment table, defaulting to `'?'` (`ai-care.ts:122-123`).

### Leading flag bits

The first four bits are mode/status flags, read before any digit (`ai-care.ts:154, 181`):

| Bit | Meaning |
| --- | --- |
| 0 | AC |
| 1 | DC |
| 2 | AUTO (autorange) |
| 3 | BT (Bluetooth-link flag; decoded but not surfaced in `Reading`) |

`acdc` is `'AC'` if bit 0, else `'DC'` if bit 1, else `''` (`ai-care.ts:154`). `auto` maps to bit 2 (`ai-care.ts:181`). Bit 3 (BT) is present in the layout but not assigned to any `Reading` field.

### Digits

Four 7-segment digits A..D are read at fixed 8-bit-spaced offsets. Each field is a **leading point/sign bit** followed by **7 segment bits** (`ai-care.ts:125-136`). Digit A's leading bit is the sign (`-`); digits B/C/D's leading bits are decimal points:

| Digit | Leading bit | Bit | Segment field | Offset |
| --- | --- | --- | --- | --- |
| A | sign `-` | 4 | `seg(5)` | bits 5..11 |
| B | point `.` | 12 | `seg(13)` | bits 13..19 |
| C | point `.` | 20 | `seg(21)` | bits 21..27 |
| D | point `.` | 28 | `seg(29)` | bits 29..35 |

```ts
const displayText = (
  (on(4) ? '-' : '') +
  seg(5) +
  (on(12) ? '.' : '') + seg(13) +
  (on(20) ? '.' : '') + seg(21) +
  (on(28) ? '.' : '') + seg(29)
).trim();
```

The 7-bit key is resolved through the `SEG` table (source `aiCareNumbers`, `ai-care.ts:26-39`):

| Key (7 segment bits) | Glyph | | Key | Glyph |
| --- | --- | --- | --- | --- |
| `1111101` | `0` | | `1111110` | `6` |
| `0000101` | `1` | | `0010101` | `7` |
| `1011011` | `2` | | `1111111` | `8` |
| `0011111` | `3` | | `0111111` | `9` |
| `0100111` | `4` | | `1101000` | `L` |
| `0111110` | `5` | | `0000000` | (blank) |

`'L'` is the overload glyph (`"0L"` / `"0.L"`), and `'0000000'` (no segments lit) is a blank digit used for leading-zero suppression. The concatenated `leading + glyph` for all four digits forms `displayText` after trimming (`ai-care.ts:127-136`).

### Unit annunciators

Individual bits at fixed offsets `>= 36`, accumulated **in source order** so metric prefixes land before the base unit ("mV", "kΩ", "µA", "nF") (`ai-care.ts:140-153`):

| Bit | Appends | Bit | Appends |
| --- | --- | --- | --- |
| 36 | `µ` | 44 | `F` |
| 37 | `n` | 45 | `Ω` |
| 38 | `k` | 48 | `A` |
| 40 | `m` | 49 | `V` |
| 42 | `M` | 50 | `Hz` |
| 41 | `%` | 53 | `°C` |

So `displayUnit` is built by concatenation: e.g. bit 40 (`m`) + bit 49 (`V`) → `mV`; bit 38 (`k`) + bit 45 (`Ω`) → `kΩ`; bit 36 (`µ`) + bit 48 (`A`) → `µA`; bit 37 (`n`) + bit 44 (`F`) → `nF`. Note the unusual evaluation order in code: the `%` test (bit 41) runs after `M` (bit 42), but since these are independent annunciators the assembled string is unaffected for any single active unit (`ai-care.ts:142-148`).

### Diode and continuity

| Field | Bit | Code ref |
| --- | --- | --- |
| `diode` | 39 | `ai-care.ts:155` |
| `cont` (continuity) | 43 | `ai-care.ts:156` |

These are consumed only by the function-key mapping (below); they are not surfaced as `Reading` fields directly.

### Status flags

`Reading.flags` (`ai-care.ts:176-186`):

| Flag | Bit | Code ref |
| --- | --- | --- |
| `hold` | 47 | `ai-care.ts:179` |
| `rel` | 46 | `ai-care.ts:178` |
| `auto` | 2 | `ai-care.ts:181` |
| `lowBattery` | 51 | `ai-care.ts:182` |
| `max` | — | always `false` — not surfaced in the AICARE frame (`ai-care.ts:177`) |
| `min` | — | always `false` (`ai-care.ts:177`) |
| `hvWarning` | — | always `false` (`ai-care.ts:183`) |
| `peakMax` | — | always `false` (`ai-care.ts:184`) |
| `peakMin` | — | always `false` (`ai-care.ts:185`) |

### Overload (OL) and value

Overload is detected textually: `overload = displayText.includes('L')` (`ai-care.ts:158`). Because the decimal-point prefix floats with the active range, the overload display can read `"0L"` or `"0.L"` — both contain `L`. A reading is numeric only when it is not overloaded and matches the `NUMERIC` regex `^-?\d*\.?\d+$` (`ai-care.ts:110, 159`). `displayValue` is `Number(displayText)` when numeric, else `null` (`ai-care.ts:160`).

### Normalization

`unitInfo(displayUnit)` (`types.ts:168-174`) splits the displayed unit into an SI `base` and a prefix exponent (`n`→−9, `µ`→−6, `m`→−3, `k`→3, `M`→6). `baseUnit` is the SI base (e.g. `Ω` from `kΩ`, `V` from `mV`, `F` from `nF`); `baseValue = displayValue * 10**exp` (`ai-care.ts:162-163`), so range changes (mV↔V, kΩ↔MΩ) keep a continuous normalized curve. `bargraph` is always `0` (`ai-care.ts:174`) — this family has no analog bar in the decoded frame.

### Function key

`functionFor(baseUnit, acdc, diode, cont)` (`ai-care.ts:85-108`) maps the decoded unit + mode to a range-independent function key so range steps stay one chart segment while a real mode change splits:

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

The diode/continuity checks come first, so they win over the unit-based mapping (a continuity reading carries `Ω` but reports `CONT`). The result feeds `quantityKey` (`types.ts:49-51`) as `function|acdc`, which controls chart-segment splitting. Note `°F` is handled in the mapping even though no bit assembles `°F` into `displayUnit` (only bit 53 → `°C` is decoded), so a Fahrenheit reading would currently surface as `°C`.

## Controls

Receive-only. The driver declares no `controls` map (none in `ai-care.ts:225-251`), and the write characteristic (`0xFFB1`), while present in the GATT profile, is never used. There are no soft-button commands (RANGE/SELECT/HOLD/REL/Hz/MAX-MIN) for this family — `handshake()` and `onRequest()` are both no-ops.

## Verification

`verification: 'ported-unverified'` (`ai-care.ts:228`). The decoder was ported from `Utilities.cs` `aiCareDecode` (the partial method the `isBDM == 3` dispatch actually calls — there is also a `DecoderAI_Care.cs` stub, but the live dispatch uses `aiCareDecode`, `ai-care.ts:4-7`). It has **not** been bench-tested on physical hardware.

What is inferred / unverified:
- All nibble/bit offsets are taken verbatim from `aiCareDecode`; the self-addressing scatter and the 56-bit field layout have not been confirmed against real frames.
- `°F`: no bit assembles `°F` into `displayUnit`, so the `°F` branch of `functionFor` is currently unreachable from a decoded unit; a real Fahrenheit reading would show `°C`. Unconfirmed whether the meter has a separate annunciator bit for `°F`.
- BT (bit 3) is decoded as a layout flag but not mapped to any `Reading` field.
- `max`, `min`, `hvWarning`, `peakMax`, `peakMin` are not represented in the 14-byte frame and are hard-coded `false`.
- The framer's split/coalesced-notification handling mirrors the uni-t parser defensively; in practice one notification equals one frame, so multi-frame resync is untested against real traffic.

## Source

- Driver: `packages/protocol/src/drivers/ai-care.ts`
- Shared types: `packages/protocol/src/drivers/types.ts` (`Driver`/`DriverFramer`), `packages/protocol/src/types.ts` (`Reading`, `unitInfo`)
- Upstream: `webspiderteam/Bluetooth-DMM-For-Windows` — `Utilities.cs` `aiCareDecode` (the `isBDM == 3` dispatch path) and its `aiCareNumbers` 7-segment table.
