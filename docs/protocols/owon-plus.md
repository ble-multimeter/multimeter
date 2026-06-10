# Owon "plus" (B35T+ / B41T+ / OW18E / CM2100B) — `owon-plus`

> **State:** `app-verified` — decode-verified byte-exact against the official "OWON Multimeter BLE4.0" Android app (`handleReceivedData_common`) via the `fake-ble-meter` emulator oracle (a hardware-free bench test), **not yet live on a physical meter** (the OWON app could not render this meter live due to its own CCCD bug; Owon OW18E ordered to validate). **No driver bug was found** — the scale/function nibbles, SI-prefix + unit tables, and the LSB-first flag order (fixed earlier in commit 4506bdc) all match the app. **Driver:** `packages/protocol/src/drivers/owon-plus.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` `Utilities.cs` `owonPlusTypeDecode` (`isBDM == 2` / `TestDevice == 6`), confirmed against the app.

<a name="overview"></a>

The owon-plus driver decodes the modern Owon BLE multimeter family — the "+" generation of the B35/B41 plus the OW18E and CM2100B clamp meter, along with their rebadges. These meters stream a fixed **6-byte little-endian frame** with **no scramble, no sync header and no checksum** (`owon-plus.ts:9-13`), which is what distinguishes them from the other meters that share the same `0xFFF0` GATT service.

The decoder is a pure function (`decodeOwonPlus`, `owon-plus.ts:107`) and never throws: a short or garbled frame degrades to a blank reading (`owon-plus.ts:40-64`, `owon-plus.ts:108`). One BLE notification is treated as exactly one atomic frame.

## Models

| Model | Notes |
| --- | --- |
| Owon B35T+ | Multimeter (the `BM35_BLE_*` UUID set in the source) |
| Owon B41T+ | Multimeter |
| Owon OW18E | Multimeter (the unit ordered for hardware validation) |
| Owon CM2100B | Clamp meter |
| Rebadges | Various OEM rebadges of the above |

These devices commonly advertise BLE names beginning with `OWON` or `BDM`. The driver's `namePrefixes` are `['OWON', 'BDM']` (`owon-plus.ts:271`). Because `0xFFF0` is shared with the `bdm`, `owon-old` and `voltcraft` drivers, name is only a hint — final disambiguation is by frame shape (see [Transport](#transport)).

<a name="transport"></a>

## Transport (GATT)

| Role | UUID | Constant (`owon-plus.ts`) |
| --- | --- | --- |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` | `FFF0_SERVICE` (`owon-plus.ts:260`) |
| Notify (measurements) | `0000fff4-0000-1000-8000-00805f9b34fb` | `FFF4_NOTIFY` (`owon-plus.ts:261`) |
| Write (commands) | `0000fff3-0000-1000-8000-00805f9b34fb` | `FFF3_WRITE` (`owon-plus.ts:262`) |

The GATT profile is declared at `owon-plus.ts:272`: `{ service: FFF0_SERVICE, notify: FFF4_NOTIFY, write: [FFF3_WRITE] }`.

**Routing / disambiguation.** `match()` (`owon-plus.ts:276-279`) returns `true` whenever the `0xFFF0` service is advertised **or** the device name starts with `OWON`/`BDM`. Since the same service is claimed by the other three FFF0-family drivers, `match()` deliberately only *claims the service*; the orchestrator resolves the collision by sniffing the first notification frame.

The frame sniffer is `looksLikeOwonPlusFrame` (`owon-plus.ts:231-234`, also wired as `sniff` at `owon-plus.ts:298`). Its rule:

1. **Length must be exactly 6 bytes** (`owon-plus.ts:232`). owon-plus is the only FFF0 family with a 6-byte frame; the others are bdm (11 bytes, constant `0x1B 0x84` header, XOR-scrambled), owon-old (14 bytes, ASCII digits, CR/LF terminated) and voltcraft (15 bytes) (`owon-plus.ts:22-25`). Length is therefore the primary discriminator.
2. **The function nibble must be a valid `MODE_*` code 0..13** (`owon-plus.ts:233`, `MAX_FUNCTION = 13` at `owon-plus.ts:37`). Codes 14/15 are unused, so this rejects stray/garbled 6-byte runs whose function field would land out of range.

The function nibble is extracted by `functionOf` (`owon-plus.ts:98-101`) from the same `symbols` word the decoder uses — see below.

## Handshake / session start

**None.** The meter free-streams measurements as soon as you subscribe to the notify characteristic. `handshake()` is a no-op (`owon-plus.ts:284-286`) and there is no request/response keep-alive — `onRequest()` is also a no-op (`owon-plus.ts:289-291`).

## Framer

owon-plus frames carry no sync word, header or checksum, so there is nothing to resync against (`owon-plus.ts:236-241`). `OwonPlusFramer` (`owon-plus.ts:242-258`) simply buffers incoming bytes and slices fixed 6-byte frames:

- `push(chunk)` appends every byte to an internal buffer, then emits one `{ kind: 'measurement', bytes }` frame per complete 6-byte slice (`owon-plus.ts:245-253`). This reassembles a frame split across two notifications and splits two frames coalesced into one.
- `reset()` clears the buffer (`owon-plus.ts:255-257`).

The framer deliberately does **not** attempt byte-level resync: without a marker, a wrong alignment would still produce a "valid-looking" frame and emit garbage, so it trusts the meter's framing instead (`owon-plus.ts:238-241`).

## Frame format

Six raw little-endian bytes, one notification == one frame. **No XOR descramble, no constant sync header, no checksum** (`owon-plus.ts:9-12`). The decoder reads the raw bytes directly.

The 6 bytes form three little-endian `u16` words:

| Word | Bytes | Expression (`owon-plus.ts`) | Meaning |
| --- | --- | --- | --- |
| `symbols` | `data[0]`, `data[1]` | `data[1] << 8 \| data[0]` (`:110`) | function / scale / point packed bitfield |
| `mode` | `data[2]`, `data[3]` | `data[3] << 8 \| data[2]` (`:163`) | mode flag bits (HOLD..VBAR) |
| `measurement` | `data[4]`, `data[5]` | `data[5] << 8 \| data[4]` (`:122`) | 4-digit magnitude; bit15 = negative sign |

### `symbols` word bitfield (`owon-plus.ts:110-113`)

| Field | Extraction | Bits | Meaning |
| --- | --- | --- | --- |
| `function` | `(symbols >> 6) & 0x0f` | 9..6 | `MODE_*` code 0..13 |
| `scale` | `(symbols >> 3) & 0x07` | 5..3 | SI prefix index (see [prefix table](#decode)) |
| `point` | `symbols & 0x07` | 2..0 | decimal-point position; `6` = "U.L", `7` = "O.L" |

### `measurement` word (`owon-plus.ts:122-141`)

- Low 15 bits = magnitude; bit15 = negative sign.
- The ported C# logic is `value = (raw == (raw & 0x7fff)) ? raw : -1 * (raw & 0x7fff)` (`owon-plus.ts:129`).
- The magnitude is rendered as a digit string padded to at least 4 digits (C# `ToString("0000")`), the sign prepended in front (`owon-plus.ts:132-133`).
- A decimal point is inserted `point` characters from the end of the full string (including any sign), exactly like C# `String.Insert(Length - point, ".")` (`owon-plus.ts:136-139`).
- **Quirk (ported faithfully):** a "negative zero" (`raw == 0x8000`) renders as `"0000"` with *no* sign, because `-1 * 0 == 0` (`owon-plus.ts:119-121`).
- An additional source branch prepends `'-'` when `data[0] == 45` (ASCII `'-'`); this effectively never fires for a real `symbols` low byte (`owon-plus.ts:121`, `:140`).

<a name="decode"></a>

## Decode

### Function code table (`MODE_*` 0..13)

Decoded from `fn = (symbols >> 6) & 0x0f`. The unit/AC-DC/diode/cont/special selection is at `owon-plus.ts:144-182`.

| `fn` | Unit (`displayUnit`) | acdc | Special | `function` key |
| --- | --- | --- | --- | --- |
| 0 | `V` (`:147`) | `DC` (`:154`) | — | `DCV` |
| 1 | `V` (`:147`) | `AC` (`:154`) | — | `ACV` |
| 2 | `A` (`:152`) | `DC` (`:154`) | — | `DCA` |
| 3 | `A` (`:152`) | `AC` (`:154`) | — | `ACA` |
| 4 | `Ω` (`:150`) | — | — | `OHM` |
| 5 | `F` (`:148`) | — | — | `CAP` |
| 6 | `Hz` (`:151`) | — | — | `Hz` |
| 7 | `%` (`:149`) | — | — | `%` |
| 8 | `°C` (`:146`) | — | — | `°C` |
| 9 | `°F` (`:147`) | — | — | `°F` |
| 10 | `V` (`:147`) | — | diode (`:155`) | `DIODE` |
| 11 | `Ω` (`:150`) | — | continuity (`:156`) | `CONT` |
| 12 | `` (cleared, `:181`) | — | hFE | `HFE` (`:193`) |
| 13 | `` (cleared, `:179`) | — | NCV | `NCV` (`:192`) |

`acdc` is set at `owon-plus.ts:154`: `AC` for fn 1/3, `DC` for fn 0/2, otherwise `''`. `diode` is fn 10, `cont` is fn 11 (`owon-plus.ts:155-156`).

The SI prefix from the `scale` field is prepended to the base unit (`displayUnit = PREFIXES[scale]`, `owon-plus.ts:144`) before the per-function suffix is appended.

### SI prefix table (`scale` index)

From the literal `PREFIXES` (`owon-plus.ts:34`), the source's `pre[]`:

| `scale` | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| prefix | `p` | `n` | `µ` | `m` | `` (base) | `k` | `M` | `G` |

Index 4 (`""`) is the unscaled base unit.

> **Note (SI normalization gap):** `unitInfo` in `packages/protocol/src/types.ts:157` only recognizes the prefixes `n µ m k M` (its `PREFIX` map). The `p` (pico) and `G` (giga) prefixes that this table can emit are **not** mapped, so when `scale` is 0 (`p`) or 7 (`G`) the `baseValue` SI normalization (`owon-plus.ts:188-189`) treats the prefixed unit as the base unit (exp 0). `displayUnit`/`displayText` still show the correct prefix; only the normalized `baseValue` would be off. In practice these prefixes are not expected for real multimeter ranges.

### Decimal point insertion

`point` (the low 3 bits of `symbols`) drives both overload detection and the decimal place:

| `point` | Effect |
| --- | --- |
| `0` | no decimal point inserted (`owon-plus.ts:136-139`) |
| `1`–`5` | decimal inserted that many chars from the end of the value string |
| `6` | `displayText = "U.L"` — underload / overload sentinel (`owon-plus.ts:124-125`) |
| `7` | `displayText = "O.L"` — overload sentinel (`owon-plus.ts:126-127`) |

`overload` is `true` when `point === 6 || point === 7` (`owon-plus.ts:184`).

### Mode flag bits (LSB-first, per the vendor app)

`mode = (data[3] << 8 | data[2]) & 0xffff` (`owon-plus.ts:163`). The word is a bitfield numbered **LSB-first**: flag `n` lives at bit `n` — `bit(n) = ((mode >> n) & 1) === 1` (`owon-plus.ts:164`).

| Bit | Flag | `Reading.flags` |
| --- | --- | --- |
| 0 | HOLD | `hold` (`:165`) |
| 1 | REL | `rel` (`:166`) |
| 2 | AUTO (autorange) | `auto` (`:167`) |
| 3 | Battery low | `lowBattery` (`:168`) |
| 4 | MIN | `min` (`:169`) |
| 5 | MAX | `max` (`:170`) |

The full bit map from the vendor app's `MultimeterClient.Status` enum is: `HOLD(0), REL(1), AUTO(2), Bat(3), MIN(4), MAX(5), OL(6), RMR(7), PMIN(8), PMAX(9), UL(10), LPF0(11), LPF1(12), VBAR(13)`.

> **Verified against the OWON Android app (BLE4.0 v1.6.7.0).** `handleReceivedData_common` builds `Integer.toBinaryString(mode)` and right-aligns it against the `Status` enum array (whose last element is `HOLD`), so HOLD = bit 0. This **corrects an earlier port** that indexed an MSB-first padded string and placed HOLD at bit 15 — that reading was wrong for real hardware. The vendor Android app is authoritative; the third-party C# Windows app is not.

Flags **not** surfaced by `owonPlusTypeDecode` and therefore hard-coded `false`:
- `peakMax` / `peakMin` (`owon-plus.ts:171-173`, `:212-213`)
- `hvWarning` (`owon-plus.ts:214`)

`bargraph` is always `0`: VBAR (mode bit 13 in the source enum) is a presence flag only — the frame carries no analog bar count (`owon-plus.ts:206`).

### Special displays

- **NCV (fn 13)** (`owon-plus.ts:177-179`): `displayText = raw > 0 ? '-'.repeat(raw) : 'EF'` — a strength bar of dashes proportional to the field reading, or `EF` ("electric field"/no-field). `displayUnit` is cleared to `''`. `displayValue` is forced `null` (the `numeric` guard excludes `fn === 13`, `owon-plus.ts:185`), and `function` = `NCV`.
- **hFE (fn 12)** (`owon-plus.ts:180-182`): keeps the numeric `displayText` but clears `displayUnit` to `''` (bare gain, no SI unit). `function` = `HFE`.

### Numeric value & SI normalization

- `numeric` is `true` only when not overloaded, `fn !== 13`, and `displayText` matches `/^-?\d*\.?\d+$/` (`NUMERIC`, `owon-plus.ts:94`, `:185`).
- `displayValue = numeric ? Number(displayText) : null` (`owon-plus.ts:186`).
- `unitInfo(displayUnit)` splits the prefix to get `{ base, exp }`; `baseValue = displayValue * 10 ** exp` (`owon-plus.ts:188-189`), or `null` when `displayValue` is null.

### `function` key mapping (range-independent)

`functionFor(baseUnit, acdc, diode, cont)` (`owon-plus.ts:69-92`) maps the *base* unit + AC/DC + diode/cont to a range-independent key, so a range change (mV↔V, kΩ↔MΩ) stays one chart segment while a real mode change splits it. Mirrors `bdm.ts`.

| Condition | Key |
| --- | --- |
| `diode` | `DIODE` |
| `cont` | `CONT` |
| base `V`, with acdc | `${acdc}V` (`DCV`/`ACV`) |
| base `V`, no acdc | `V` |
| base `A`, with acdc | `${acdc}A` (`DCA`/`ACA`) |
| base `A`, no acdc | `A` |
| base `Ω` | `OHM` |
| base `F` | `CAP` |
| base `Hz` | `Hz` |
| base `%` | `%` |
| base `°C` | `°C` |
| base `°F` | `°F` |
| otherwise | `baseUnit \|\| '?'` |

Special overrides set before `functionFor` is consulted: `fn === 13 → 'NCV'`, `fn === 12 → 'HFE'` (`owon-plus.ts:191-194`).

### Blank/degraded reading

When `bytes.length < 6`, decode returns `blank(ts)` (`owon-plus.ts:108`, `:40-64`): `function: '?'`, empty display fields, all flags `false`, `displayValue`/`baseValue` `null`, `overload: false`.

## Controls

**Receive-only — no controls shipped.** The source documents interactive commands (write a `uint16` to FFF3, e.g. `0x0003` = Backlight), but the on-wire byte order is unverified, so the driver omits `controls` rather than ship a guess (`owon-plus.ts:294-296`). The `Driver.controls` map is therefore absent for owon-plus, and `FFF3_WRITE` is declared in the GATT profile only for completeness.

## Verification

`verification: 'app-verified'` (`owon-plus.ts`). The decoder is validated **byte-exact against the vendor app's `handleReceivedData_common`** via the `fake-ble-meter` emulator oracle (a hardware-free bench test) — decode-verified, **not** yet live on a physical meter (the OWON app could not render this meter live due to its own CCCD bug; an Owon OW18E is ordered to validate live). **No driver bug was found** in this pass — unlike its `owon-old` sibling, owon-plus already matched the app.

Confirmed byte-exact against the app (`handleReceivedData_common`, `MultimeterClient.java:1236+`):

- The 6-byte frame layout and the three-word packing.
- The `scale = (symbols & 56) >> 3` SI-prefix index (`p n u m None K M G`) and the `function = (symbols & 960) >> 6` function nibble (0..13) with its per-function unit table — **identical** to the app's two `switch` statements. Caveat: fn 13 is `NCV` only on the OW18/OW20/OW55 series and `ADP` elsewhere; this driver targets the OW18E family, so `NCV` is correct.
- **The flag bit order is LSB-first (HOLD = bit 0)** — the app builds `Integer.toBinaryString(mode)` and right-aligns it against the `Status` enum array, so flag `n` is at bit `n`. This corrected an earlier MSB-first port (HOLD = bit 15) in commit 4506bdc; the app confirms LSB-first.
- The `point == 6 → "U.L"` / `point == 7 → "O.L"` overload sentinels.
- The NCV dash-bar / `EF` rendering and the hFE bare-gain display.
- The negative-zero quirk (`raw == 0x8000` → unsigned `"0000"`).

The pure `decodeOwonPlus` / `looksLikeOwonPlusFrame` functions are unit-tested (no I/O). Live-on-hardware validation is still pending (the OW18E).

## Source

- Driver: `packages/protocol/src/drivers/owon-plus.ts`
- Shared types / `unitInfo`: `packages/protocol/src/types.ts`
- Driver interface: `packages/protocol/src/drivers/types.ts`
- Upstream reference: `webspiderteam/Bluetooth-DMM-For-Windows` — `Utilities.cs` `owonPlusTypeDecode` (`isBDM == 2` / `TestDevice == 6`), plus the inline `BM35_BLE_*` UUID notes and the `MODE_*` function table.
