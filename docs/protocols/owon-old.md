# Owon B35T (legacy text mode) — `owon-old`

> **State:** `app-verified` — decode-verified byte-exact via the `fake-ble-meter` emulator oracle (a hardware-free bench test), **not yet live on a physical meter** (this is decode-verified, not live-hardware-verified). That validation **fixed two real driver bugs** vs. the third-party C# port — see [Verification](#verification): **byte 6 is an ASCII decimal-point digit, not a first-set-bit bitmask**, and **the nano prefix is byte 8 bit 1, not byte 10 bit 2 gated on `byte9 == 0`**. **Driver:** `packages/protocol/src/drivers/owon-old.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` `Decoders/DecoderOwon.cs` `b35tDecodeOld` (`isBDM == 1`).

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
| 6 | decimal-point | **ASCII digit** (switches on the char): `'1'` (`0x31`) → 3 decimals, `'2'` (`0x32`) → 2, `'4'` (`0x34`) → 1, anything else → 0. (Was decoded as a first-set-bit bitmask in the old C# port — a bug; see Verification.) |
| 7 | mode bits | hold / rel / AC / DC / auto. |
| 8 | min/max + battery + nano | min / max / low-battery, plus the **nano prefix** at bit 1 (`BIT_NANO`). |
| 9 | scale-prefix + diode/cont | metric prefix bits (m/µ/M/k), `%`, diode, continuity. (No nano here — it's byte 8 bit 1.) |
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

Byte 6 is read as an **ASCII digit** via a char switch: `point = byte6 === 0x31 ? 3 : byte6 === 0x32 ? 2 : byte6 === 0x34 ? 1 : 0`. `point` is the count of digits after the point. **(Corrected from the old C#-port logic, which read `byte6 & 0x07` as a first-set-bit bitmask — that gave the right answer only for the canonical `'1'/'2'/'4'` codes and diverged for any other byte-6 value; see [Verification](#verification).)**

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
| 3 | byte8 bit 1 (`BIT_NANO`) | `n` | nano. **Corrected:** read from byte 8 bit 1, independent of the farad bit. (The old port emitted `n` from byte10 bit 2 gated on `byte9 === 0`, which only rendered `nF` correctly by coincidence; see [Verification](#verification).) |
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

So e.g. byte9 bit 6 (`m`) + byte10 bit 7 (`V`) → `mV`; byte9 bit 5 (`k`) + byte10 bit 5 (`Ω`) → `kΩ`; byte9 bit 7 (`µ`) + byte10 bit 6 (`A`) → `µA`; byte8 bit 1 (`n`) + byte10 bit 2 (`F`) → `nF`. The nano prefix (byte 8 bit 1, `BIT_NANO`) and the farad base (byte 10 bit 2) are now **separate** bits — so e.g. a nano-amp frame (byte 8.1 + byte 10.6) correctly renders `nA`, which the old byte10.2-gated logic could not. See [Verification](#verification).

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

`verification: 'app-verified'` (`owon-old.ts`). The decoder is now validated **byte-exact** via the `fake-ble-meter` emulator oracle (a hardware-free bench test) — decode-verified, **not** yet live on a physical meter (this is decode-verified, not live-hardware-verified). Two independent implementations now agree on this decoder, after two driver bugs were fixed:

1. The original port from `DecoderOwon.cs` `b35tDecodeOld` (the `isBDM == 1` path), cross-checked against the synthetic `TestData(dev_type == 5, …)` frames in the source's `Utilities.cs`.
2. The reference 14-byte ASCII decode for the B35 chip family, mirrored in the emulator's `fakemeter/profiles/owon_old.py` encoder and its decode oracle `tests/decode_owon_old.py`.

**Two driver bugs found and fixed by this validation:**

- **byte 6 (decimal point) is an ASCII digit, not a bitmask.** Byte 6 reads as a char: `'1'`(`0x31`)→3 decimals, `'2'`(`0x32`)→2, `'4'`(`0x34`)→1, else 0. The old driver decoded `byte6 & 0x07` as a first-set-bit bitmask — equivalent only for the canonical `'1'/'2'/'4'` codes, but wrong for any other byte-6 value the meter sends. **Fixed** to the ASCII-digit switch.
- **nano prefix is byte 8 bit 1 (`BIT_NANO`), not byte 10 bit 2 gated on `byte9 == 0`.** Nano is emitted from byte 8 bit 1 (`BIT_NANO=2`), independent of the farad bit. The old driver inferred nano from the farad bit (byte 10.2) when no byte-9 prefix was present — rendering `nF` correctly only by coincidence and mis-prefixing e.g. nano-amp. **Fixed** to read byte 8 bit 1.

The cross-check confirmed the GATT profile, the frame layout, the sign/value math, and **every byte-7…byte-10 prefix/base-unit/mode/min-max bit**. Two divergent items remain (the `?`-sentinel OL handling and the `lowBattery` bit) — see below.

### Bit-semantics cross-check

The 14-byte ASCII path is dispatched for the B35 chip family (`series == 35 && !isSupportFlashRecord`); the 6-byte binary path is the `owon-plus` decoder. So `owon-old` ↔ the **B35** decode.

- **GATT — exact.** Service `0xFFF0`, notify/read `0xFFF4`, write `0xFFF3` (plus FFF1 secure / FFF2 info characteristics the driver ignores). Matches `owon-old.ts` byte-for-byte.
- **Framing — exact.** Fixed 14-byte records: byte 0 must be `'+'`(43)/`'-'`(45) else resync to the next sign byte, byte 5 must be `0x20`, bytes 12/13 must be `0x0D`/`0x0A`; a remainder is buffered across notifications. This is exactly `OwonOldFramer`'s sign-sync + space + CRLF validation.
- **Sign — exact.** 45 → negate, 43 → positive, same as `owon-old.ts:103`.
- **Decimal point (byte 6) — now exact (fixed).** Byte 6 reads as an **ASCII char** and switches: `'1'`(49)→`X.XXX`, `'2'`(50)→`XX.XX`, `'4'`(52)→`XXX.X`, else→`XXXX`. `owon-old.ts` now uses the same char switch. The old port computed `(byte6 & 0x07)` first-set-bit index, which matched for `'1'/'2'/'4'` but diverged for any other byte-6 value — that bitmask was a bug, **now corrected** to the char switch.
- **Mode bits (byte 7) — exact.** `&2`→HOLD, `&4`→REL, `&8`→AC, `&16`→DC, `&32`→AUTO. Identical to `owon-old.ts` byte-7 bits 1/2/3/4/5. (`BIT_HOLD=2, BIT_REL=4, BIT_DC=16, BIT_AUTO=32`.)
- **Min/Max (byte 8) — exact.** `&32`→MAX, `&16`→MIN (`BIT_MAX=32, BIT_MIN=16`). Identical to `owon-old.ts` byte-8 bits 5/4.
- **Prefix + diode/cont + % (byte 9) — exact.** `&128`→µ, `&64`→m, `&32`→k, `&16`→M, `&4`→DIODE, `&8`→BEEP(continuity), `&2`→%. Identical to `owon-old.ts` byte-9 bits 7/6/5/4/2/3/1.
- **Base unit (byte 10) — exact.** `&128`→V, `&64`→A, `&32`→Ω, `&8`→Hz, `&4`→F, `&2`→°C, `&1`→°F. Identical to `owon-old.ts` byte-10 bits 7/6/5/3/2/1/0. (`&16`→hFE is additionally defined but `owon-old.ts` does not surface it — a missing function, not a wrong bit.)

  Frame-byte ↔ bit map (byte numbers are 0-based from the sign byte):

  | Frame byte | Bit | Meaning | owon-old.ts |
  | --- | --- | --- | --- |
  | 7 | .1/.2/.3/.4/.5 | HOLD / REL / AC / DC / AUTO | ✅ exact |
  | 8 | .5/.4 | MAX / MIN | ✅ exact |
  | 8 | .1 | **nano prefix** (`BIT_NANO=2`) | ✅ exact (corrected: driver now reads nano from byte8.1) |
  | 8 | .2 | (`BIT_BAT=4` defined but **unused** in B35) | ⚠️ driver reads lowBattery here |
  | 9 | .7/.6/.5/.4 | µ / m / k / M | ✅ exact |
  | 9 | .2/.3 | diode / continuity (BEEP) | ✅ exact |
  | 9 | .1 | % | ✅ exact |
  | 10 | .7/.6/.5/.3/.2/.1/.0 | V / A / Ω / Hz / F / °C / °F | ✅ exact |
  | 10 | .4 | hFE | ⚠️ not surfaced by driver |

**Bugs found and fixed (this is the value of the cross-check):**

- **Decimal point: byte 6 ASCII digit, not bitmask — FIXED** (see the byte-6 bullet above).
- **Nano prefix: byte 8 bit 1, not byte 10 bit 2 — FIXED.** Nano is emitted from **byte 8** bit 1 (`BIT_NANO=2`). The old `owon-old.ts:142` emitted `n` from `byte10 bit 2` (the farad bit) gated on `byte9 === 0` — rendering `"nF"` correctly only by coincidence, and mis-prefixing any frame that sets byte 8.1 without byte 10.2 (e.g. nano-amp) or byte 10.2 with byte 9 ≠ 0. **The driver now reads nano from byte 8 bit 1**: byte 10.2 is *only* farad.

**Still divergent / unconfirmed:**

- **`lowBattery` (byte 8 bit 3) is not corroborated.** The B35 decode reads no battery bit; `BIT_BAT=4` (byte-?.2) is defined but **unused**. So `owon-old.ts:131`'s `lowBattery = byte8 bit3` is unverified — keep as inferred/likely-wrong.
- **OL handling differs.** `owon-old.ts` detects overload from a `'?'` (0x3F) sentinel in the digit field (inherited from the C# `TestData`). The reference decode has **no `?` sentinel** — it computes OL by **range-clamping the value**: for Ω (byte9 & 32) the threshold is set by the byte-6 decimal code (6/60/600/6000), for continuity (byte9.3) `> 60`, for diode (byte9.2) `> 6`, then prints `"OL"`. The driver's `'?'` test will not fire on real range-clamped frames, and the driver does no range-clamp. Whether a physical B35T actually sends `'?'` chars or relies on the host clamp is **unconfirmed without hardware**; treat both OL paths as plausible-but-unverified.

**Confirmed (moved out of "inferred"):** GATT, framing/sync, sign, decimal-point, value assembly, and the full byte-7…byte-10 bit semantics for mode / min-max / prefixes / diode-cont-% / base units.

Still inferred / not confirmable from this cross-check:
- The `'?'`-sentinel overload path (the reference uses host-side range-clamping instead; neither confirmed on hardware).
- `lowBattery` (byte 8 bit 3) — not read by the B35 decode.
- Byte 11 is **read but never used** in the B35 decode — consistent with `owon-old.ts` leaving it undecoded. Its meaning (status/checksum) remains unknown; neither implementation validates it.
- `hFE` (byte 10 bit 4) is a real annunciator but is not surfaced by `owon-old.ts` (it would fall through to the `baseUnit || '?'` default).
- `hvWarning`, `peakMax`, `peakMin` are not present in the 14-byte frame and are hard-coded `false`.
- The framer's split/coalesced-notification handling mirrors the other drivers' parsers defensively; a remainder is buffered, so the behaviour is directionally confirmed, but exact multi-frame resync is untested against real traffic.

## Source

- Driver: `packages/protocol/src/drivers/owon-old.ts`
- Shared types: `packages/protocol/src/drivers/types.ts` (`Driver`/`DriverFramer`), `packages/protocol/src/types.ts` (`Reading`, `unitInfo`)
- Upstream: `webspiderteam/Bluetooth-DMM-For-Windows` — `Decoders/DecoderOwon.cs` `b35tDecodeOld` (`isBDM == 1` path); verified vs the synthetic `TestData(dev_type == 5)` frames in `Utilities.cs`.
