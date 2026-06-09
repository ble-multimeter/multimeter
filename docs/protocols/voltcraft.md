# Voltcraft VC800 / VC900 — `voltcraft`

> **State:** `untested` (ported, not bench-tested). **Driver:** `packages/protocol/src/drivers/voltcraft.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` `Utilities.cs` `VoltcraftDecode` (`isBDM == 5`); reverse-engineered upstream by user FireBird3314.

The `voltcraft` driver decodes the Voltcraft VC800/VC900 family of BLE bench/handheld multimeters (App `DevType 5` in the source Windows app). Like `bdm` and the `owon` families it lives behind GATT service `0xFFF0`, so service UUID alone cannot pick the decoder — the orchestrator disambiguates by sniffing the first raw notification. The meter does not handshake or answer requests: the moment a client subscribes to the notify characteristic it free-streams one 15-byte notification per LCD update. Each frame carries **two** displays (primary and secondary), but the engine has no secondary-display field, so the driver decodes and surfaces only the primary display while still parsing/skipping the secondary block so framing stays correct. There is no scrambling, no AB-CD sync word, and no checksum; framing keys off two constant `0xF0` marker bytes at fixed offsets. The driver is receive-only — it exposes no controls. Everything below is derived from `voltcraft.ts`; byte offsets and bitfields are quoted directly from the code.

## Models

The VC800 and VC900 series of Voltcraft DMMs. The driver header (`voltcraft.ts:1-3`) ties these to the source app's `DevType 5`. These meters advertise inconsistent BLE names, so discovery leans on the service-UUID filter, with name prefixes `"VC"` / `"Voltcraft"` as a fallback (`voltcraft.ts:298-302, 305-308`).

| Series | Notes |
| --- | --- |
| Voltcraft VC800 | dual-display handheld (App `DevType 5`) |
| Voltcraft VC900 | dual-display handheld (App `DevType 5`) |

## Transport (GATT)

GATT profile (`voltcraft.ts:290-292, 303`):

| Role | UUID |
| --- | --- |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` (`0xFFF0`) |
| Notify | `0000fff4-0000-1000-8000-00805f9b34fb` (`0xFFF4`) |
| Write | `0000fff3-0000-1000-8000-00805f9b34fb` (`0xFFF3`) |

The write characteristic is declared for profile-completeness only; the driver never writes (no handshake, no keep-alive, no controls).

**Routing.** The `0xFFF0` service is shared by several unrelated families (`bdm`, `owon-plus`, `owon-old`), so `match()` accepts the device when it advertises `0xFFF0` **or** its name starts with `"VC"` **or** `"Voltcraft"` (`voltcraft.ts:305-308`). The session then disambiguates by sniffing the first raw notification frame against each candidate driver's `sniff()` predicate.

**Frame-sniff rule** (`looksLikeVoltcraftFrame`, `voltcraft.ts:253-255`). A frame is a Voltcraft frame iff it is at least 15 bytes long **and** carries the constant `0xF0` markers at `bytes[2]` and `bytes[8]`:

```ts
bytes.length >= 15 && bytes[2] === 0xf0 && bytes[8] === 0xf0
```

This is the discriminator vs the other `0xFFF0` families: `bdm` is exactly 11 bytes and `owon` frames are shorter (6 bytes), so neither can satisfy the 15-byte length test, and the two `0xF0` markers reject coincidental 15-byte payloads (`voltcraft.ts:246-251`).

## Handshake / session start

None. The driver's `handshake()` is a no-op (`voltcraft.ts:313-315`) and `onRequest()` is a no-op (`voltcraft.ts:318-320`): there is no AB-CD sync, no challenge/response, and no request/response keep-alive in this family. Subscribing to the `0xFFF4` notify characteristic is sufficient — the meter streams measurement notifications immediately and continuously (`voltcraft.ts:312`).

## Frame format

One BLE notification carries exactly one 15-byte frame (`FRAME_LEN = 15`, `voltcraft.ts:33`; the source app accepts any `data.Length > 14`, and the driver slices fixed 15-byte windows, `voltcraft.ts:34`). The frame has:

- **No scrambling** (raw bytes, no XOR key).
- **No AB-CD sync word.**
- **No checksum.**
- **Two constant `0xF0` markers** at `bytes[2]` and `bytes[8]` (`F0_MARK = 0xf0`, `voltcraft.ts:35`) separating the primary and secondary display blocks — used purely to sync the stream.

The frame is a **dual-display** structure: a PRIMARY block, a SECONDARY block, then shared mode/power flags. Full layout (FireBird3314's annotations, `voltcraft.ts:10-25`):

| Bytes | Field | Meaning |
| --- | --- | --- |
| `[0..1]` | primary "symbols" word (LE) | function / prefix / decimal-point bitfield (+ bit 12 = secondary-display active) |
| `[2]` | `0xF0` marker | constant primary separator |
| `[3..4]` | primary count (LE) | raw measurement `0..65535` |
| `[5]` | bit 7 | primary negative |
| `[6..7]` | secondary "symbols" word (LE) | same bitfield layout as primary |
| `[8]` | `0xF0` marker | constant secondary separator |
| `[9..10]` | secondary count (LE) | raw secondary measurement |
| `[11]` | bit 7 | secondary negative |
| `[12..13]` | mode flags word (LE) | HOLD / REL / AUTO / LOWBATT / MIN / MAX |
| `[14]` | power-measurement flags | LoZ / PF / AC / DC / USB power — **not surfaced** |

### The "symbols" word

Both displays share a 16-bit little-endian "symbols" word (primary `bytes[0..1]`, secondary `bytes[6..7]`). The driver reads it as `(bytes[1] << 8) | bytes[0]` (`voltcraft.ts:165`) and decomposes it into three packed fields (`voltcraft.ts:166-168`):

| Field | Bits | Extract | Meaning |
| --- | --- | --- | --- |
| `point` | 0..2 | `symbols & 0x07` | decimal-point position (0..4 places), or `6`=UL / `7`=OL sentinels |
| `scale` | 3..5 | `(symbols >> 3) & 0x07` | metric-prefix index into `PREFIX` |
| `fn` | 6..10 | `(symbols >> 6) & 0x1f` | function / display-mode code (see Decode) |
| (secondary active) | 12 | — | header bit 12 = secondary display active (noted but not modelled) |

### Framer / resync

`VoltcraftFramer` (`voltcraft.ts:261-288`) buffers incoming chunks and tolerates split/coalesced notifications like the other drivers, even though in practice one notification equals one frame. On each pass it calls `sync()`, then if at least 15 bytes are buffered it emits a `measurement` frame of the first 15 bytes and consumes them (`voltcraft.ts:267-273`). `sync()` (`voltcraft.ts:282-287`) advances the buffer head (shifting one byte at a time) until `buf[2] === 0xF0` **and** `buf[8] === 0xF0`; it can only confirm once at least 9 bytes are buffered, otherwise it keeps what it has. `reset()` clears the buffer (`voltcraft.ts:276-278`).

## Decode

`decodeVoltcraft(bytes, ts)` (`voltcraft.ts:161-243`) is pure and never throws; it degrades gracefully. A frame shorter than 15 bytes returns a `blank` reading (`voltcraft.ts:162`; blank shape at `voltcraft.ts:78-102`). An unknown function code renders a `'?'` unit (via `functionFor`) rather than erroring. Only the **primary** display is surfaced in the `Reading`; the secondary block (`bytes[6..11]`) is parsed/skipped exactly as the source does so framing stays correct (`voltcraft.ts:27-28`).

### Primary count and sign

- `count = (bytes[4] << 8) | bytes[3]` — little-endian raw measurement, `0..65535` (`voltcraft.ts:171`).
- `negative = (bytes[5] & 0x80) > 0` — bit 7 of `bytes[5]` (`voltcraft.ts:170`).

### Function / unit table

The function code `fn` (symbols bits 6..10) maps to a base unit through `FUNCTION_UNIT` (`voltcraft.ts:47-68`), mirroring the source's chain of `((function == n) ? "X" : "")` concatenations:

| `fn` | Base unit | Quantity | | `fn` | Base unit | Quantity |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | `V` | Voltage DC | | 11 | `Ω` | Continuity (ohms) |
| 1 | `V` | Voltage AC | | 12 | `''` | hFE (bare gain) |
| 2 | `A` | Current DC | | 13 | `''` | NCV (strength bar) |
| 3 | `A` | Current AC | | 14 | `W` | Power [W] |
| 4 | `Ω` | Resistance | | 15 | `VA` | Power [VA] |
| 5 | `F` | Capacitance | | 16 | `PF` | Power factor |
| 6 | `Hz` | Frequency | | 18 | `Ah` | Energy [Ah] |
| 7 | `%` | Duty cycle | | 19 | `''` | Time [hh:mm:ss] (no primary unit) |
| 8 | `°C` | Temperature C | | 20 | `Wh` | Energy [Wh] |
| 9 | `°F` | Temperature F | | 21 | `V` | Voltage [V] |
| 10 | `V` | Diode (volts) | | 22 | `A` | Current [A] |

Codes 12 (hFE), 13 (NCV) and 19 (time) carry no base unit. Any `fn` not in the table falls back to `''` (`voltcraft.ts:190`) and is rendered via `functionFor` as `'?'`.

### SI prefix

The prefix index `scale` (symbols bits 3..5) indexes `PREFIX = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G']` (`voltcraft.ts:38`). Index 4 (`''`) is the unprefixed unit. `displayUnit` is `PREFIX[scale] + baseUnit`, except when the base unit is empty (then `displayUnit` is `''`, `voltcraft.ts:190-191`).

> Note: `PREFIX` includes `p` (pico) and `G` (giga), but the shared `unitInfo()` normalizer (`types.ts:157, 168-174`) only recognizes prefixes `n µ m k M`. A `p`- or `G`-prefixed display unit therefore decodes correctly as a string but is treated as exponent 0 during SI normalization (`baseUnit` keeps the prefix, `baseValue` = `displayValue`).

### Decimal point, overload / underload

The decimal point is placed by `point` (symbols bits 0..2). Values `0..4` are point positions; the two top values are overload sentinels (`voltcraft.ts:41-43`):

| `point` | Meaning |
| --- | --- |
| `0` | no decimal point |
| `1..4` | decimal point that many places from the right |
| `6` (`POINT_UL`) | underload → `U.L` |
| `7` (`POINT_OL`) | overload → `O.L` |

`overload = point === 7`, `underload = point === 6` (`voltcraft.ts:175-176`). The source emits `" O.L "` / `" U.L "` with surrounding spaces; the driver trims to `O.L` / `U.L` for a tidy `displayText` (`voltcraft.ts:178-182`).

### Display text formatting

For a normal reading, `formatCount(count, point, negative)` (`voltcraft.ts:147-154`) builds the LCD string exactly as the source's `measurement.ToString("00000").Insert(len - point, ".")`: zero-pad the raw count to 5 digits, then insert a `.` `point` places from the right (`point == 0` → no point), and prepend `-` when negative. E.g. count `1002`, point `3`, positive → `01.002`; count `42`, point `0`, negative → `-00042`.

### hFE and NCV special cases

Two function codes override the display (`voltcraft.ts:195-200`):

- **`fn == 12` (hFE):** `displayUnit` forced to `''` (a bare transistor gain, not an SI quantity). The numeric `displayText` from `formatCount` is kept.
- **`fn == 13` (NCV):** `displayText` becomes a strength bar — `'-'.repeat(count)` when `count > 0`, otherwise `'EF'` — and `displayUnit` is forced to `''`.

### AC/DC classification

`acdcFor(fn)` (`voltcraft.ts:71-75`): `AC` for `fn ∈ {1, 3}`, `DC` for `fn ∈ {0, 2}`, otherwise `''`. (So only the basic V/A function codes carry an AC/DC tag; the duplicate voltage/current codes 21/22 report `''`.)

### Numeric value and normalization

A reading is numeric only when it is **not** overloaded/underloaded and `displayText` matches `NUMERIC = /^-?\d*\.?\d+$/` (`voltcraft.ts:142, 202`). `displayValue = Number(displayText)` when numeric, else `null` (`voltcraft.ts:203`). `unitInfo(displayUnit)` (`types.ts:168-174`) splits the displayed unit into SI `base` + prefix exponent (`n`→−9, `µ`→−6, `m`→−3, `k`→3, `M`→6); `baseValue = displayValue * 10**exp` (`voltcraft.ts:205-206`) so range changes (mV↔V, kΩ↔MΩ) keep a continuous normalized curve. `bargraph` is always `0` — the Voltcraft frame has no analog bar (`voltcraft.ts:230`).

### Status flags

The mode flags word (`bytes[12..13]`, little-endian) is read as `(bytes[13] << 8) | bytes[12]` (`voltcraft.ts:211`). The source reads it MSB-first as a 16-bit binary string and indexes `mode[0..5]`; translating those string indices to bit tests (`mode[0]` = bit 15, the top bit of the high byte `bytes[13]`) gives (`voltcraft.ts:212-218`):

| Flag | Source index | Bit | Code ref |
| --- | --- | --- | --- |
| `hold` | `mode[0]` | 15 | `voltcraft.ts:213` |
| `rel` | `mode[1]` | 14 | `voltcraft.ts:214` |
| `auto` | `mode[2]` | 13 | `voltcraft.ts:215` |
| `lowBattery` | `mode[3]` | 12 | `voltcraft.ts:216` |
| `min` | `mode[4]` | 11 | `voltcraft.ts:217` |
| `max` | `mode[5]` | 10 | `voltcraft.ts:218` |
| `hvWarning` | — | — | always `false` — not surfaced (`voltcraft.ts:238`) |
| `peakMax` | — | — | always `false` (`voltcraft.ts:239`) |
| `peakMin` | — | — | always `false` (`voltcraft.ts:240`) |

The power-measurement flags byte (`bytes[14]`: LoZ / PF / AC / DC / USB power) is **not surfaced** (`voltcraft.ts:25`).

### Function key

`functionFor(baseUnit, acdc, diode, cont)` (`voltcraft.ts:107-140`) maps the decoded unit + mode to a range-independent function key so range steps stay one chart segment while a real mode change splits. `diode` is `fn == 10`, `cont` is `fn == 11` (`voltcraft.ts:184-185`):

| Condition | `function` |
| --- | --- |
| `diode` (fn 10) | `DIODE` |
| `cont` (fn 11) | `CONT` |
| `baseUnit === 'V'` | `${acdc}V` (e.g. `ACV`/`DCV`) or `V` if no AC/DC |
| `baseUnit === 'A'` | `${acdc}A` or `A` |
| `baseUnit === 'Ω'` | `OHM` |
| `baseUnit === 'F'` | `CAP` |
| `baseUnit === 'Hz'` | `Hz` |
| `baseUnit === '%'` | `%` |
| `baseUnit === '°C'` | `°C` |
| `baseUnit === '°F'` | `°F` |
| `baseUnit === 'W'` | `W` |
| `baseUnit === 'VA'` | `VA` |
| `baseUnit === 'PF'` | `PF` |
| `baseUnit === 'Ah'` | `Ah` |
| `baseUnit === 'Wh'` | `Wh` |
| else | `baseUnit` or `'?'` |

The diode/continuity checks come first, so they win over the unit-based mapping (a continuity reading carries `Ω` but reports `CONT`; diode carries `V` but reports `DIODE`). The result feeds `quantityKey` (`types.ts:49-51`) as `function|acdc`, which controls chart-segment splitting.

## Controls

Receive-only. The driver declares no `controls` map (none in `voltcraft.ts:294-325`), and the write characteristic, while present in the GATT profile, is never used. There are no soft-button commands (RANGE/SELECT/HOLD/REL/Hz/MAX-MIN) for this family.

## Verification

`verification: 'ported-unverified'` (`voltcraft.ts:297`). The decoder was ported from `Utilities.cs` `VoltcraftDecode` (the function dispatched for `isBDM == 5` in `ParseGattValue`) and cross-checked against the synthetic frames in the source app's `TestData(dev_type == 9, …)` (`voltcraft.ts:5-8`), but it has **not** been bench-tested on physical hardware.

What is inferred / unverified:
- The dual-display layout and byte offsets come from FireBird3314's reverse-engineering annotations in the upstream project (`voltcraft.ts:11`); the primary path is exercised by synthetic `TestData` frames but not confirmed against a real VC800/VC900.
- The secondary display (`bytes[6..11]`) and the secondary-active header bit (symbols bit 12) are parsed for framing but never surfaced — the engine has no secondary-display field (`voltcraft.ts:27-28`).
- The power-measurement flags byte (`bytes[14]`) and `hvWarning`/`peakMax`/`peakMin` are not represented in the surfaced reading and are hard-coded `false` (`voltcraft.ts:238-240`).
- `PREFIX` supports `p`/`G` but `unitInfo()` does not normalize them, so a pico/giga-prefixed reading would not be SI-normalized — believed harmless for the V/A/Ω/F ranges these meters use, but unconfirmed.
- The framer's split/coalesced-notification handling is defensive; in practice one notification equals one frame, so multi-frame resync is untested against real traffic.

## Source

- Driver: `packages/protocol/src/drivers/voltcraft.ts` (`decodeVoltcraft`, `looksLikeVoltcraftFrame`, `VoltcraftFramer`)
- Shared types: `packages/protocol/src/drivers/types.ts` (`Driver`/`DriverFramer`), `packages/protocol/src/types.ts` (`Reading`, `unitInfo`)
- Upstream: `webspiderteam/Bluetooth-DMM-For-Windows` — `Utilities.cs` `VoltcraftDecode` (dispatched for `isBDM == 5` in `ParseGattValue`); verified vs synthetic `TestData(dev_type == 9, …)` frames; reverse-engineered with annotations by user FireBird3314.
