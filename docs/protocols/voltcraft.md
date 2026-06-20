# Voltcraft VC900-series (R10W) — `voltcraft`

> **State:** `verification: 'app-verified'`. The protocol below was confirmed **byte-for-byte** using a **BLE emulator as a decode oracle**: arbitrary 15-byte frames were streamed to a reference decoder and the value / unit / decimals / sign / over-range / annunciators were read back, and a state-word **bit-sweep** pinned every annunciator bit. This is a hardware-free *bench* verification, **not** yet a physical-meter test. **Driver:** `packages/protocol/src/drivers/voltcraft.ts`.

The `voltcraft` driver decodes the Voltcraft VC900-series (OWON rebadges; this is the **R10W** protocol, models VC915/VC925/VC831/851/871/891). Like `bdm` and the `owon` families it lives behind GATT service `0xFFF0`, so service UUID alone cannot pick the decoder — the orchestrator disambiguates by sniffing the first raw notification. The meter does not handshake or answer requests: the moment a client subscribes to the notify characteristic it free-streams one 15-byte notification per LCD update. There is no scrambling, no AB-CD sync word, and no checksum.

## Protocol corrections (vs the earlier port)

The driver was previously ported from the third-party `webspiderteam/Bluetooth-DMM-For-Windows` `VoltcraftDecode` (FireBird3314's annotations), which described a *different* protocol generation and was wrong in several ways. The oracle test corrected all of them:

| Field | Old (wrong) port | **Corrected (oracle-verified)** |
| --- | --- | --- |
| Word layout | LE **16-bit** halves of a `0xF0`-marked dual-display frame | five **24-bit LITTLE-endian** words at byte offsets **0/3/6/9/12** |
| Markers / checksum | constant `0xF0` at `bytes[2]`/`bytes[8]` | **none** — no markers, no checksum |
| Flag bit order | **MSB-first** (HOLD = bit15) — the headline bug | **LSB-first**, **HOLD = bit0** |
| Function table | even-keyed / power-extended (codes up to 22) | **consecutive** codes **0..13** (0 = V DC … 13 = NCV) |
| Decimal field | "decimal-point position" with `6`=UL / `7`=OL sentinels | the field **IS the decimal-place count**; value = `count / 10**decimals` |
| Over-range | inferred from the decimal-point sentinel | from the value-word **over-range selector** (1=OL, 2=UL, 3=HI) |
| Sign | `bytes[5]` bit7 (still correct) | value-word **bit23** (== `bytes[5]` bit7) |

> The flag-order fix is the same class of bug fixed in `owon-plus` (commit `4506bdc`): these are all OWON gear-word decoders, and the OWON status word is a straight LSB-numbered bitmask.

## Models

The Voltcraft VC900-series handhelds (R10W protocol). The FFF2 series id maps to the model: VC915 = series 91, VC925 = 92, VC831/851/871/891 = 83/85/87/89, all → the R10W 15-byte parser. These meters advertise inconsistent BLE names, so discovery leans on the service-UUID filter, with name prefixes `"VC"` / `"Voltcraft"` as a fallback.

> **Out of scope:** the **VC800 / R2W meters use a SEPARATE 6-byte protocol** (the "R2W" / OWON "B41" parser, 16-bit big-endian fields) and are **not handled by this driver** — future work. The driver decodes only the R10W 15-byte frame.

## Transport (GATT)

| Role | UUID |
| --- | --- |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` (`0xFFF0`) |
| Notify | `0000fff4-0000-1000-8000-00805f9b34fb` (`0xFFF4`) |
| Write | `0000fff3-0000-1000-8000-00805f9b34fb` (`0xFFF3`) |

The write characteristic is declared for profile-completeness only; the driver never writes (no handshake, no keep-alive, no controls).

**Routing.** The `0xFFF0` service is shared by several unrelated families (`bdm`, `owon-plus`, `owon-old`), so `match()` accepts the device when it advertises `0xFFF0` **or** its name starts with `"VC"` **or** `"Voltcraft"`. The session then disambiguates by sniffing the first raw notification frame against each candidate driver's `sniff()` predicate.

**Frame-sniff rule** (`looksLikeVoltcraftFrame`). A frame is a voltcraft frame iff it is at least 15 bytes long **and** its gear-function code (gear-word bits 6..10) is a valid `0..13`:

```ts
bytes.length >= 15 && ((le24(bytes, 0) >> 6) & 0x1f) <= 13;
```

This is the discriminator vs the other `0xFFF0` families: `bdm` is exactly 11 bytes, `owon-plus` is 6 and `owon-old` is 14, so none can satisfy the 15-byte length test; the gear-code check rejects coincidental 15-byte payloads whose function field would be 14..31 (unused). (There are no marker/checksum bytes to test, unlike the old `0xF0`-marker rule.)

## Handshake / session start

None. `handshake()` and `onRequest()` are no-ops: there is no AB-CD sync, no challenge/response, and no request/response keep-alive. Subscribing to the `0xFFF4` notify characteristic is sufficient — the meter streams measurement notifications immediately and continuously. (There is a separate FFF1 MD5 "anti-counterfeit" exchange, but that is not needed to *receive* frames.)

## Frame format

One BLE notification carries exactly one 15-byte R10W frame (`FRAME_LEN = 15`). The frame is five **24-bit LITTLE-endian** words `w = b[i] | b[i+1]<<8 | b[i+2]<<16`, with **no marker bytes and no checksum**:

| Bytes | Word | Meaning |
| --- | --- | --- |
| `[0..2]` | primary gear word | decimals / SI-prefix / gear-function bitfield (+ bit 12 = secondary-display active) |
| `[3..5]` | primary value word | count magnitude / over-range selector / sign |
| `[6..8]` | secondary gear word | only meaningful when primary bit 12 is set (**ignored** by this driver) |
| `[9..11]` | secondary value word | secondary display (**ignored**) |
| `[12..14]` | state word | LSB-numbered annunciator bitmask |

We surface only the **primary** display (the engine has no secondary-display field). The secondary block (`bytes[6..11]`) is ignored; the real meter sends it zero with bit 12 cleared. (Supporting the secondary display is possible future work.)

### Gear word (`bytes[0..2]`, LE)

| Field | Bits | Extract | Meaning |
| --- | --- | --- | --- |
| `decimals` | 0..2 | `g & 0x07` | number of decimal places (value = `count / 10**decimals`) |
| `scale` | 3..5 | `(g >> 3) & 0x07` | SI-prefix index into `PREFIX` |
| `gear` | 6..10 | `(g >> 6) & 0x1f` | gear / function code (table below) |
| (secondary active) | 12 | — | controls whether `bytes[6..11]` are parsed (not modelled) |

**Gear / function table** (consecutive codes, oracle-verified):

| `gear` | Quantity | Base unit | | `gear` | Quantity | Base unit |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | V **DC** | `V` | | 7 | duty cycle | `%` |
| 1 | V **AC** | `V` | | 8 | temperature | `°C` |
| 2 | A **DC** | `A` | | 9 | temperature | `°F` |
| 3 | A **AC** | `A` | | 10 | diode | `V` |
| 4 | resistance | `Ω` | | 11 | continuity | `Ω` |
| 5 | capacitance | `F` | | 12 | hFE | `''` (bare gain) |
| 6 | frequency | `Hz` | | 13 | NCV | `''` (strength bar) |

AC = `{1, 3}`, DC = `{0, 2}` (the gear code is authoritative for the function and for `acdc`; the redundant AC/DC state bits 13/14 are not used). `diode = gear 10`, `cont = gear 11`. hFE/NCV carry no SI unit.

**SI prefix** (`scale`): `PREFIX = ['p', 'n', 'µ', 'm', '', 'k', 'M', 'G']` — all eight codes are expressible. Index 4 (`''`) is the unprefixed unit. `displayUnit = PREFIX[scale] + baseUnit` (empty for hFE/NCV).

> Note: `PREFIX` includes `p` (pico) and `G` (giga), but the shared `unitInfo()` normalizer recognizes only `n µ m k M`. A `p`- or `G`-prefixed display decodes correctly as a string but is treated as exponent 0 during SI normalization.

### Value word (`bytes[3..5]`, LE)

| Field | Bits | Extract | Meaning |
| --- | --- | --- | --- |
| `count` | 0..18 | `v & 0x7FFFF` | magnitude (≤ 524287) |
| `overrange` | 20..22 | `(v >> 20) & 0x07` | `0`=normal, `1`=**OL**, `2`=**UL**, `3`=**HI** |
| `sign` | 23 | `bytes[5] & 0x80` | `1` ⇒ negative |

`displayValue = count / 10**decimals`, negated when `sign`. When `overrange` is non-zero the `displayText` is the sentinel `OL` / `UL` / `HI` and `displayValue` is `null`. `bargraph` is always `0` — the R10W frame has no analog bar.

### hFE and NCV special cases

- **`gear == 12` (hFE):** `displayUnit` forced to `''` (a bare transistor gain); the numeric text is kept; `function` = `HFE`.
- **`gear == 13` (NCV):** `displayText` becomes a strength bar — `'-'.repeat(count)` when `count > 0`, else `'EF'` — with `displayUnit = ''`, `displayValue = null`, `function = NCV`.

### State word (`bytes[12..14]`, LE) — annunciator flags

A straight **LSB-numbered bitmask** (each set bit lights its annunciator). Confirmed by live bit-sweep:

| Bit | Annunciator | | Bit | Annunciator | | Bit | Annunciator |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **0** | **HOLD** | | 7 | RMR | | 14 | DC |
| 1 | REL | | 8 | Loz | | 15 | USB |
| 2 | AUTO | | 9 | LPF | | 16 | Err |
| 3 | Bat (low battery) | | 10 | Peak | | 17 | INRUSH |
| 4 | MIN | | (11) | — (blank) | | 18 | OSC |
| 5 | MAX | | 12 | Cosφ | | | |
| 6 | AVG | | 13 | AC | | | |

The driver surfaces the subset the `Reading.flags` shape carries: `hold` = bit0, `rel` = bit1, `auto` = bit2, `lowBattery` = bit3 (Bat), `min` = bit4, `max` = bit5. `peakMax`/`peakMin`/`hvWarning` are not represented in this frame (Peak is a single bit10, not split max/min) and are hard-coded `false`.

## Decode

`decodeVoltcraft(bytes, ts)` is pure and never throws. A frame shorter than 15 bytes returns a `blank` reading; an unknown gear code renders a `'?'` unit via `functionFor`. `functionFor(baseUnit, acdc, diode, cont)` maps the decoded unit + mode to a range-independent function key (`DCV`/`ACV`/`DCA`/`ACA`/`OHM`/`CAP`/`Hz`/`%`/`°C`/`°F`, plus `DIODE`/`CONT`/`HFE`/`NCV`) so range steps (mV↔V, kΩ↔MΩ) stay one chart segment while a real mode change splits. `unitInfo()` normalizes the displayed unit into SI `base` + exponent for `baseValue`.

### Worked examples (oracle-verified bytes)

| Bytes (hex) | Decode |
| --- | --- |
| `23 00 00 68 10 00 00 00 00 00 00 00 00 00 00` | `4.200 V` DC (gear 0, decimals 3, count 4200) |
| `21 00 00 2a 00 00 00 00 00 00 00 00 01 00 00` | `4.2 V` DC + **HOLD** (decimals 1, count 42, state bit0) |
| `40 00 00 00 00 10 00 00 00 00 00 00 00 00 00` | **OL** V AC (gear 1, over-range 1) |

## Controls

Receive-only. No `controls` map; the write characteristic, while present in the GATT profile, is never used.

## Verification

`verification: 'app-verified'`. The protocol was confirmed **byte-for-byte** via a BLE emulator oracle: a fake peripheral advertised series 91 (VC915), passed the FFF1 MD5 anti-counterfeit gate, and free-streamed arbitrary 15-byte R10W frames on FFF4 while the decoded reading was observed. Setting `4.2 V` showed `0004.2 V`; changing to `230.5 V` changed the display; `1.0 MΩ` showed `MΩ`; the `f hold` toggle lit the **HOLD** annunciator. A state-word bit-sweep mapped every annunciator bit (HOLD = bit0 … OSC = bit18). The function/prefix/decimal/over-range/sign fields and the LSB-first flag order are therefore confirmed.

**Still not verified / future work:**

- **Physical hardware.** This is an emulator bench test, not a real-meter capture — hence `app-verified` rather than `live-tested`.
- **The secondary display** (`bytes[6..11]`, gear bit 12) is present in the frame but not surfaced by this driver.
- **The VC800 / R2W 6-byte protocol** is a separate protocol, not handled by this driver.
- The extended gear codes ≥14 (Power/PF/4-20mA/AC+DC/Motor/Solar) were not swept; the 5-bit field can hold them but they need the secondary block / special parsers — out of scope.
- The framer's split/coalesced-notification handling is defensive; in practice one notification equals one frame.

## Source

- Driver: `packages/protocol/src/drivers/voltcraft.ts` (`decodeVoltcraft`, `looksLikeVoltcraftFrame`, `VoltcraftFramer`)
- Tests: `packages/protocol/src/drivers/voltcraft.test.ts` (vectors derived from the worked examples + the emulator-oracle decoder)
- Shared types: `packages/protocol/src/drivers/types.ts` (`Driver`/`DriverFramer`), `packages/protocol/src/types.ts` (`Reading`, `unitInfo`)
- Ground truth: the `fake-ble-meter` BLE emulator oracle (`tests/decode_voltcraft.py` = the R10W parser port; `fakemeter/profiles/voltcraft.py` = the matching encoder). Confirmed live 2026-06-10.
