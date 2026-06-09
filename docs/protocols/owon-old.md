# Owon B35T (legacy text mode) — `owon-old`

> **State:** `untested` (ported, not bench-tested). **Driver:** `packages/protocol/src/drivers/owon-old.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` `Decoders/DecoderOwon.cs` `b35tDecodeOld` (`isBDM == 1`).

The `owon-old` driver decodes the legacy OWON B35T(+) text protocol — older firmware that streams measurements as **plain ASCII** instead of the packed little-endian frame the modern `owon-plus` driver handles. The meter does not handshake or answer requests; the moment a client subscribes to the notify characteristic it free-streams one 14-byte CR/LF-terminated ASCII notification per LCD update. Each frame carries a sign byte, four ASCII value digits, a literal-space separator, and four bitfield bytes encoding the decimal-point position, mode flags (hold/rel/AC/DC/auto), min/max + battery, and the scale-prefix + unit annunciators that are concatenated into a displayed unit (`mV`, `kΩ`, `µA`, `nF`, …). There is no checksum that the driver validates (byte 11 is a vendor status/checksum byte left undecoded). The driver is receive-only — it exposes no controls. Everything below is derived from `owon-old.ts`; byte offsets and bit positions are quoted directly from the code.

## Models

OWON B35T (and B35T+) handhelds running the legacy text firmware. These meters advertise inconsistent BLE names, so discovery leans on the `0xFFF0` service-UUID filter with name prefixes as hints. The driver accepts the prefixes `"BDM"`, `"OWON"`, and `"B35"` (`owon-old.ts:264`).

| Brand | Models | BLE name hints |
| --- | --- | --- |
| OWON | B35T, B35T+ (legacy text firmware) | `BDM`, `OWON`, `B35` |

(The label is `"Owon B35T (legacy)"`, `owon-old.ts:259`.)

## Transport (GATT)

GATT profile (`owon-old.ts:253-255, 265`):

| Role | UUID |
| --- | --- |
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` (`0xFFF0`) |
| Notify | `0000fff4-0000-1000-8000-00805f9b34fb` (`0xFFF4`) |
| Write | `0000fff3-0000-1000-8000-00805f9b34fb` (`0xFFF3`) |

The write characteristic is declared for profile-completeness only; the driver never writes (no handshake, no keep-alive, no controls).

**Routing.** The `0xFFF0` service is shared by several unrelated families (`bdm`, `owon-plus`, `voltcraft`), so service UUID alone is not enough to pick the decoder. `match()` accepts the device when it advertises `0xFFF0` **or** its name starts with `"BDM"` / `"OWON"` / `"B35"` (`owon-old.ts:269-273`), and the session then disambiguates by sniffing the first raw notification frame against each candidate driver's `sniff()` predicate.

**Frame-sniff rule** (`looksLikeOwonOldFrame`, `owon-old.ts:203-216`). `owon-old` is the only `0xFFF0` family that is plain ASCII and CR/LF-terminated, which makes it cheap and unambiguous to recognise. A frame is an owon-old frame iff **all** of:

1. it is exactly 14 bytes (`bytes.length === FRAME_LEN`, `owon-old.ts:204`);
2. byte 0 is an ASCII sign — `'+'` (`0x2B`) or `'-'` (`0x2D`) (`owon-old.ts:205`);
3. byte 5 is an ASCII space `0x20` (`owon-old.ts:206`);
4. the frame ends with CR LF — byte 12 `== 0x0D` and byte 13 `== 0x0A` (`owon-old.ts:207`);
5. the value field (bytes 1..4) is either **four ASCII digits** `'0'..'9'` (`0x30..0x39`), **or** the source's OL sentinel — bytes 1 and 4 both `'?'` (`0x3F`), inner bytes being don't-cares (`owon-old.ts:209-214`).

The driver header (`owon-old.ts:198-201`) records how this distinguishes the siblings: `owon-plus` frames are binary little-endian words (byte 0 rarely `0x2B`/`0x2D`, no `0x20` at byte 5, no CR/LF terminator); `bdm` frames are 11 bytes, XOR-scrambled, and start with the constant `0x1B 0x84` header (never an ASCII sign). So the ASCII-sign + space + CRLF triple is owon-old-exclusive within the collision set.

## Handshake / session start

None. The driver's `handshake()` is a no-op (`owon-old.ts:279-281`) and `onRequest()` is a no-op (`owon-old.ts:284-286`): there is no sync word, no challenge/response, and no request/response keep-alive in this family. Subscribing to the `0xFFF4` notify characteristic is sufficient — the meter streams measurement notifications immediately and continuously.

## Frame format

One BLE notification carries exactly one 14-byte frame (`FRAME_LEN = 14`, `owon-old.ts:28`), terminated by CR LF. The frame is plain ASCII (unlike its XOR-scrambled `bdm` sibling). Byte-by-byte layout (driver header `owon-old.ts:11-22`):

| Byte | Field | Meaning |
| --- | --- | --- |
| 0 | sign | `'+'` (`0x2B`/43) or `'-'` (`0x2D`/45). Only `'-'` flips the sign; anything else is positive (`owon-old.ts:103`). |
| 1..4 | value digits | Four ASCII digits `'0'..'9'`; `'?'` in the outer positions (bytes 1 & 4) means OL. |
| 5 | space | Literal space `0x20`/32 (separator). |
| 6 | decimal-point | `byte6 & 0x07` read as a 4-bit field; index of its first set bit = number of digits after the point (`0` → none). |
| 7 | mode bits | hold / rel / AC / DC / auto. |
| 8 | min/max + battery | min / max / low-battery. |
| 9 | scale-prefix + diode/cont | metric prefix bits (m/µ/M/k/n), `%`, diode, continuity. |
| 10 | unit bits | `°C` / `°F` / `n`(cap) / V / F / Ω / Hz / A. |
| 11 | status/checksum | vendor status/checksum byte — **not decoded**. |
| 12..13 | terminator | CR (`0x0D`) LF (`0x0A`). |

**No sync word.** **No driver-validated checksum** (byte 11 is left undecoded). The CR LF terminator doubles as the framer's sync/validation marker.

**Framer / resync** (`OwonOldFramer`, `owon-old.ts:221-251`). The framer buffers incoming chunks and, although in practice one notification equals one frame, tolerates split/coalesced notifications like the other drivers' framers. On each pass it calls `sync()`, then — if at least 14 bytes are buffered — validates the CR LF terminator at offsets 12/13; if either is wrong it has lost sync, drops one byte, and retries (`owon-old.ts:230-234`). On a valid terminator it emits a `measurement` frame of the first 14 bytes and consumes them (`owon-old.ts:235-236`). `sync()` (`owon-old.ts:246-250`) discards leading bytes until the buffer starts with an ASCII sign (`'+'` / `'-'`). `reset()` clears the buffer (`owon-old.ts:241-243`).

## Decode

`decodeOwonOld(bytes, ts)` (`owon-old.ts:99-183`) is pure and never throws; it degrades gracefully. A frame shorter than 14 bytes returns a `blank` reading (`owon-old.ts:100`, blank shape at `owon-old.ts:38-62`). The OL sentinel (`"?…?"`) is surfaced as overload (→ non-numeric → `displayValue` null) rather than erroring.

### Sign

`text` starts as `'-'` iff byte 0 is `0x2D` (`'-'`); any other value (including `'+'`) leaves it empty / positive (`owon-old.ts:103`).

### Decimal point

`byte6 & 0x07` is rendered as a 4-bit binary string (`padStart(4, '0')`), and `point` is the index of its first `'1'` (`owon-old.ts:107-108`). When no bit is set (`0b000`), `indexOf` returns `-1` and `point` is clamped to `0` → no decimal point (`owon-old.ts:109`). `point` is the count of digits after the point.

### Value digits & OL

The four value digits are assembled as an ASCII string from bytes 1..4 (`owon-old.ts:112`). **Overload** is detected when the digit string both starts and ends with `'?'` (`owon-old.ts:113`); on overload the digits are replaced with the literal `' OL '` (`owon-old.ts:114`).

The decimal point is inserted by slicing: when `point !== 0`, a `.` is spliced `point` characters from the end of the digit string; otherwise the digits are used as-is (`owon-old.ts:116-119`). The result is trimmed to `displayText` (`owon-old.ts:120`) — so an OL frame yields `displayText === 'OL'`.

### Mode flags (byte 7)

Read via `isBitSet(b, pos) = (b & (1 << pos)) !== 0` (`owon-old.ts:35`):

| Flag | Bit | Code ref |
| --- | --- | --- |
| `hold` | 1 | `owon-old.ts:123` |
| `rel` | 2 | `owon-old.ts:124` |
| `acdc` | `'AC'` if bit 3, else `'DC'` if bit 4, else `''` | `owon-old.ts:125` |
| `auto` | 5 | `owon-old.ts:126` |

### Min/Max + battery (byte 8)

| Flag | Bit | Code ref |
| --- | --- | --- |
| `max` | 5 | `owon-old.ts:129` |
| `min` | 4 | `owon-old.ts:130` |
| `lowBattery` | 3 | `owon-old.ts:131` |

### Diode / continuity (byte 9)

| Field | Bit | Code ref |
| --- | --- | --- |
| `diode` | 2 | `owon-old.ts:134` |
| `cont` (continuity) | 3 | `owon-old.ts:135` |

### Scale prefix + unit annunciators (bytes 9 & 10)

`displayUnit` is assembled by concatenation **in the source's exact order**, so metric prefixes land before the base unit (`mV`, `kΩ`, `µA`, `nF`) (`owon-old.ts:139-152`):

| Order | Source bit | Appends | Notes |
| --- | --- | --- | --- |
| 1 | byte10 bit 1 | `°C` | |
| 2 | byte10 bit 0 | `°F` | |
| 3 | byte10 bit 2 **and** `byte9 === 0` | `n` | nano (capacitance); only when **no** byte-9 prefix is present (`owon-old.ts:142`) |
| 4 | byte9 bit 6 | `m` | milli |
| 5 | byte9 bit 7 | `µ` | micro |
| 6 | byte9 bit 4 | `M` | mega |
| 7 | byte9 bit 5 | `k` | kilo |
| 8 | byte10 bit 7 | `V` | |
| 9 | byte10 bit 2 | `F` | farad (capacitance base) |
| 10 | byte9 bit 1 | `%` | |
| 11 | byte10 bit 5 | `Ω` | |
| 12 | byte10 bit 3 | `Hz` | |
| 13 | byte10 bit 6 | `A` | |

So e.g. byte9 bit 6 (`m`) + byte10 bit 7 (`V`) → `mV`; byte9 bit 5 (`k`) + byte10 bit 5 (`Ω`) → `kΩ`; byte9 bit 7 (`µ`) + byte10 bit 6 (`A`) → `µA`; byte10 bit 2 (`n`, since `byte9 === 0`) + byte10 bit 2 (`F`) → `nF`. Note the nano prefix and the farad base **share** byte10 bit 2 — capacitance is signalled by that single bit, with `n` emitted only when no other (byte-9) prefix overrides it, and `F` always emitted when the bit is set.

### Numeric value & normalization

A reading is numeric only when it is **not** overloaded and `displayText` matches the `NUMERIC` regex `^-?\d*\.?\d+$` (`owon-old.ts:92, 154`). `displayValue` is `Number(displayText)` when numeric, else `null` (`owon-old.ts:155`).

`unitInfo(displayUnit)` (`types.ts:168-174`) splits the displayed unit into an SI `base` and a prefix exponent (`n`→−9, `µ`→−6, `m`→−3, `k`→3, `M`→6). `baseUnit` is the SI base (e.g. `Ω` from `kΩ`, `V` from `mV`, `F` from `nF`); `baseValue = displayValue * 10**exp` (`owon-old.ts:157-158`), so range changes (mV↔V, kΩ↔MΩ) keep a continuous normalized curve. `bargraph` is always `0` (`owon-old.ts:170`) — this family has no analog bar.

### Function key

`functionFor(baseUnit, acdc, diode, cont)` (`owon-old.ts:67-90`, mirroring `bdm.ts`) maps the decoded unit + mode to a range-independent function key so range steps stay one chart segment while a real mode change splits:

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

The diode/continuity checks come first, so they win over the unit-based mapping (a continuity reading carries `Ω` but reports `CONT`). The result feeds `quantityKey` (`types.ts:49-51`) as `function|acdc`, which controls chart-segment splitting.

### Flags not surfaced

`hvWarning`, `peakMax`, and `peakMin` are not represented in the owon-old frame and are hard-coded `false` (`owon-old.ts:178-180`).

## Controls

Receive-only. The driver declares no `controls` map (none in `owon-old.ts:257-291`), and the write characteristic, while present in the GATT profile, is never used. There are no soft-button commands (RANGE/SELECT/HOLD/REL/Hz/MAX-MIN) for this family.

## Verification

`verification: 'ported-unverified'` (`owon-old.ts:260`). The decoder was ported from `DecoderOwon.cs` `b35tDecodeOld` (the `isBDM == 1` path) and cross-checked against the synthetic `TestData(dev_type == 5, …)` frames in the source app's `Utilities.cs` (`owon-old.ts:6-9`), but it has **not** been bench-tested on physical hardware.

What is inferred / unverified:
- The exact bit semantics of bytes 7–10 — taken verbatim from the source decoder and validated only against the synthetic TestData frames, not against a live B35T.
- The shared byte10-bit-2 nano/farad encoding (capacitance), believed correct from the source but unconfirmed on hardware.
- Byte 11 (vendor status/checksum) is intentionally not decoded — its meaning is unknown and the driver does not validate it.
- `hvWarning`, `peakMax`, `peakMin` are not present in the 14-byte frame and are hard-coded `false`.
- The framer's split/coalesced-notification handling mirrors the other drivers' parsers defensively; in practice one notification equals one frame, so multi-frame resync is untested against real traffic.

## Source

- Driver: `packages/protocol/src/drivers/owon-old.ts`
- Shared types: `packages/protocol/src/drivers/types.ts` (`Driver`/`DriverFramer`), `packages/protocol/src/types.ts` (`Reading`, `unitInfo`)
- Upstream: `webspiderteam/Bluetooth-DMM-For-Windows` — `Decoders/DecoderOwon.cs` `b35tDecodeOld` (`isBDM == 1` path); verified vs the synthetic `TestData(dev_type == 5)` frames in `Utilities.cs`.
