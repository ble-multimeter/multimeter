# UNI-T UT60BT / UT161 — `uni-t`

> **State:** UT60BT `verified` (live-tested), UT161A–E `expected` (same decoder). **Driver:** `packages/protocol/src/drivers/uni-t.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` (`Decoders/DecoderUni_T.cs`), UT60BT confirmed live.

The `uni-t` driver speaks UNI-T's modern **"iDMM" protocol**: a serial-style link over BLE GATT carrying `0xAB 0xCD`-framed packets. After connecting it runs a small event-driven handshake (GET-NAME → wait for the name frame → GET-DATA), then the meter streams 19-byte `AB CD 10 …` measurement frames a few times a second. Each frame carries a function code, a range digit, the literal LCD string, an analog bargraph, and three flag bytes; the decoder turns that into a `Reading` with both the on-LCD `displayValue`/`displayUnit` and an SI-normalized `baseValue`/`baseUnit` so charts stay continuous across autorange prefix flips. The UT60BT was confirmed against a physical `UT60BTk` unit (GATT enumeration + frame captures, 2026-06-06); the UT161A–E series is routed through the **same** decoder and is expected-but-unverified. This is *not* the older raw-LCD-segment-bitmap family of UNI-T/Aneng meters — that is ignored. Markers below: ✅ confirmed from a working implementation / live capture · ⚠️ present in code but needs verification against the physical unit.

## Models

| Model | BLE name prefix | State |
|---|---|---|
| UT60BT | `UT60BT` (advertises as `UT60BTk`) | ✅ `verified` — live-tested on a physical unit |
| UT161A–E | `UT161` | ⚠️ `expected` — same AB-CD 19-byte frame + decoder, not hardware-verified |

The driver matches on either the advertised ISSC service UUID **or** a `UT60BT`/`UT161` name prefix (`uni-t.ts:24,27-30`). Note: UT171/UT181 share the same ISSC service but use their own protocols and have separate drivers — when those land, this service-based match must become name-based so it stops greedily claiming them (`uni-t.ts:20-23`).

## Transport (GATT)

A Microchip/ISSC **"Transparent UART"** module: one notify characteristic (meter → app, the measurement stream) and one write characteristic (app → meter, commands), with a second write characteristic as a fallback. ✅ Confirmed live on `UT60BTk` (2026-06-06): notify `1e4d` has the `notify` property, write `8841` has `write`/`writeWithoutResponse`.

| Role | Full UUID | Source |
|---|---|---|
| Service (ISSC Transparent UART) | `49535343-fe7d-4ae5-8fa9-9fafd205e455` | `uni-t.ts:11` |
| Notify (meter→app) | `49535343-1e4d-4bd9-ba61-23c647249616` | `uni-t.ts:12` |
| Write (app→meter) | `49535343-8841-43f4-a8d4-ecbe34729bb3` | `uni-t.ts:13` |
| Write fallback | `49535343-6daa-4d02-abf6-19569aca69fe` | `uni-t.ts:14` |

The `gatt` descriptor (`uni-t.ts:25`) lists `write` as an ordered array `[ISSC_WRITE, ISSC_WRITE_FALLBACK]` so the transport can fall back to `6daa` if `8841` is unwritable.

**Routing.** The driver's `match` (`uni-t.ts:27-30`) returns true if the advertised `services` include the ISSC service **or** the device name starts with `UT60BT` **or** `UT161`. The earlier-suspected vendor service `0000d0ff-3c17-d293-8e48-14fe2e4da212` was enumerated but has **no notify characteristic**, so it is not the stream and was dropped. The generic `0xFFF0` profile is **not** present on this unit. Device Information `0x180a` (model/serial/firmware strings) is present and nice-to-have; GAP/GATT `0x1800`/`0x1801` are blocklisted by Web Bluetooth and unreachable.

**Web Bluetooth note.** `requestDevice` must list every service in `optionalServices` or its characteristics are invisible; filter on `namePrefix: "UT60BT"` (and `UT161`) and request the ISSC service (plus `0x180a`). Writes use **Write Without Response** when supported, else Write With Response.

## Handshake / session start

The meter is silent until asked, and it **ignores GET-DATA until it has answered GET-NAME** — so the handshake is event-driven, not timer-driven (`uni-t.ts:36-44`). ✅ Confirmed live (2026-06-06): a blind "wait ~200 ms then GET-DATA" races the name response and loses — if GET-DATA arrives first the meter sends only the name frame and never starts streaming.

Sequence (`handshake(io)`):

1. Subscribe to notifications on the notify characteristic.
2. Write **GET-NAME**.
3. `await io.waitForFrame(k => k === 'control', 1500)` — wait for the name (control) frame, with a 1.5 s timeout fallback.
4. Loop up to **5×**: write **GET-DATA**, then `await io.waitForFrame(k => k === 'measurement', 700)`; return on the first measurement frame. A lone GET-DATA can still be dropped, so it is re-sent until streaming starts.
5. If no measurement arrives after 5 attempts, throw `meter did not start streaming after handshake`.

**Keep-alive / re-arm.** The meter may periodically ask the app to re-identify or re-arm the stream. `onRequest(frame, io)` (`uni-t.ts:47-50`) responds: a `type-request` frame → re-send **GET-NAME**; a `data-request` frame → re-send **GET-DATA**. These request frames were *not* observed in our captures (the meter streamed continuously after handshake) but the responders are kept for safety. The framing layer classifies them by length (`framing.ts:42-47`): 9-byte → `type-request` (`AB CD .. AA AA ..`), 7-byte → `data-request` (`AB CD .. FF 00 ..`).

### Command / control frames

Fixed command frames have the shape `AB CD <len> <cmd> <param> <checksum-16-BE>`, where `<len>` counts the bytes after it and the trailing two bytes are a **16-bit big-endian** sum of the preceding bytes: `0xAB + 0xCD + 0x03 + cmd` (= `cmd + 0x17B`). These are hardcoded in `framing.ts:13-24` (the *command* checksum differs from the *measurement* checksum in §Frame format). Only the handshake commands and the controls below are ever sent.

| Command | Bytes (hex) | cmd | Purpose | Source |
|---|---|---|---|---|
| GET-NAME | `AB CD 03 5F 01 DA` | `0x5F` | request device type / wake the stream | `framing.ts:14` |
| GET-DATA | `AB CD 03 5D 01 D8` | `0x5D` | start streaming measurements | `framing.ts:15` |
| (soft buttons) | see §Controls | `0x41`–`0x4C` | front-panel keys | `framing.ts:16-23` |

### GET-NAME response (name frame)

Right after GET-NAME the meter replies with an **11-byte name frame**: `AB CD 08 55 54 36 30 42 54 03 25` = `AB CD 08 "UT60BT" <chk16>`. ✅ Confirmed on `UT60BTk`. Its length (11) ≠ 19, so the framing layer classifies it as `control` (`framing.ts:46`) and the decoder ignores it. It may also reappear mid-stream; any non-19-byte `AB CD` frame is treated as control.

## Frame format

The 19-byte measurement frame — one frame ≈ one LCD update, a few per second. ✅ Confirmed live: every notification carried exactly one whole frame (never split or coalesced), but the framing layer buffers and resyncs anyway for safety.

```
offset  bytes  field
 0       1     0xAB                      header
 1       1     0xCD                      header
 2       1     0x10 (= len, 16)          payload length; total frame = len + 3 = 19
 3       1     function code             low 7 bits index FUNCTIONS[]; bit7 unused, masked off
 4       1     range, as ASCII digit     '0'..'7'  → (byte − 0x30) indexes the range→unit table
 5       7     display string (ASCII)    e.g. " 0.000", "-OL ", "  0.L"  (trimmed)
12       1     bargraph high             bargraph = byte[12]*10 + byte[13]
13       1     bargraph low
14       1     flags A                   bit3 MAX · bit2 MIN · bit1 HOLD · bit0 REL
15       1     flags B                   bit2 autorange-OFF (0 = autoranging) · bit1 battery-low · bit0 HV-warning
16       1     flags C                   bit3 AC (1=AC, 0=DC) · bit2 peak-max · bit1 peak-min · bit0 bar polarity
17       2     checksum: 16-bit big-endian sum of bytes [0..16]
18
```

**Length / framing.** The parser syncs on `AB CD`, computes `total = buf[2] + 3` (`framing.ts:61`), drops bogus lengths (`< 4` or `> 64`) one byte at a time to resync, and waits if the frame is split across notifications (`framing.ts:62-68`).

**Checksum ✅ (confirmed).** Bytes `[17][18] = Σ(bytes[0..16])` as a 16-bit big-endian value (e.g. a DCV frame Σ=712=`0x02C8` → `… 02 c8`; a Hz frame Σ=754=`0x02F2` → `… 02 f2`). `checksumOk` (`framing.ts:35-40`) validates it; a 19-byte candidate that fails the checksum is treated as a false `AB CD` boundary and the parser shifts one byte and resyncs (`framing.ts:71-73`). Control frames use a different one-byte scheme and are not validated.

**`frame[3]` bit7 ✅** was always 0 in captures; the decoder masks it (`decode.ts:21`). The display string carries the decimal point, so decimal places are never computed from the range — only the unit/prefix is.

## Decode

`decode(bytes, ts)` (`decode.ts:14-66`) is pure (no BLE, no React) and **never throws**: a non-19-byte / wrong-header input returns a `blank` reading (`decode.ts:17-19,68-92`); an unknown function or range falls back to a raw label + `"?"` unit so the hero readout always mirrors the meter.

### Function code table — `FUNCTIONS[]` (index = `frame[3] & 0x7F`)

`types.ts:69-103`. Codes 0–21 were verified on the UT60BT; codes ✓ below were actually seen in `UT60BTk` captures (2026-06-06). Codes 22–30 are ported from `DecoderUni_T.cs` `functionStrings` for other UT-series models and are **unverified on hardware** (present so those meters show a label instead of `#22`). The source reuses ACA/DCA/LPF names across several codes; mirrored verbatim because `decode` keys the unit table off the same name. Source index 31 is a blank placeholder and is intentionally omitted, so an out-of-range code degrades to `#31` (`decode.ts:22`: `FUNCTIONS[fnIndex] ?? '#${fnIndex}'`).

```
 0 ACV ✓    1 ACmV     2 DCV ✓    3 DCmV ✓   4 Hz ✓     5 %
 6 OHM ✓    7 CONT ✓   8 DIODE ✓  9 CAP ✓   10 °C ✓    11 °F
12 DCuA ✓  13 ACuA    14 DCmA ✓  15 ACmA    16 DCA     17 ACA
18 HFE     19 Live    20 NCV ✓   21 LozV    22 ACA     23 DCA
24 LPF     25 AC/DC   26 LPF     27 AC+DC   28 LPFA    29 AC+DC2
30 INRUSH
```
(✓ = code 00,02,03,04,06,07,08,09,0a,0c,0e,14 confirmed in captures; LPF = low-pass-filtered AC voltage, AC/DC / AC+DC = combined modes, INRUSH = inrush capture.)

### Range → unit / prefix table — `RANGE_UNITS[fn]` (index = `frame[4] − 0x30`)

`types.ts:109-139`. The range digit selects both the displayed unit and its metric prefix. Functions whose unit never changes list a single entry; decode falls back to `ranges[rangeIndex] ?? ranges[0] ?? '?'` (`decode.ts:27-28`). `''` = no unit (NCV strength bar, HFE bare gain, Live).

| Function | r0 | r1 | r2 | r3 | r4 | r5 | r6 | r7 |
|---|---|---|---|---|---|---|---|---|
| ACV / DCV / LozV | V | V | V | V | | | | |
| ACmV / DCmV | mV | | | | | | | |
| Hz | Hz | Hz | kHz | kHz | kHz | MHz | MHz | MHz |
| % | % | | | | | | | |
| OHM | Ω | kΩ | kΩ | kΩ | MΩ | MΩ | MΩ | |
| CONT | Ω | | | | | | | |
| DIODE | V | | | | | | | |
| CAP | nF | nF | µF | µF | µF | mF | mF | mF |
| °C / °F | °C / °F | | | | | | | |
| DCuA / ACuA | µA | µA | | | | | | |
| DCmA / ACmA | mA | mA | | | | | | |
| DCA / ACA | A | A | | | | | | |
| HFE / Live / NCV | (none) | | | | | | | |
| LPF / AC/DC / LPFA / INRUSH | V | V | V | V | | | | |
| AC+DC / AC+DC2 | A | A | | | | | | |

**Verification status.** ✅ confirmed by capture: ACV/DCV ranges 0–3 = **V** (range-swept, no prefix change); DCmV = mV; Hz range 0 = Hz; °C, µA, mA as listed; CAP range 0 = nF (~0.011 nF stray). ✅ **OHM kΩ confirmed live** (a 100 kΩ resistor read ~98 kΩ, matching the LCD; ~2% is resistor tolerance). ⚠️ **still unverified:** the OHM **MΩ** step (needs ≥1 MΩ resistor), and the CAP (µF/mF) and Hz (kHz/MHz) **prefix** steps; all Ω captures so far were overload. The LPF/AC-DC/INRUSH rows (codes 22–30) are ported, unverified. Not blocking.

### Two values per reading

`decode` produces both forms via `unitInfo` (`types.ts:157-174`), which splits a displayed unit into base + prefix exponent (`k`=3, `M`=6, `m`=−3, `µ`=−6, `n`=−9; a bare `V`/`Ω`/`%`/`` stays put):

- **`displayValue` / `displayUnit`** — exactly what's on the LCD, e.g. `1.002` / `kΩ`.
- **`baseValue` / `baseUnit`** — SI-normalized: `baseValue = displayValue * 10^exp`, e.g. `1002` / `Ω` (`decode.ts:29,37`). Charting `baseValue` keeps the curve continuous when autorange flips the prefix.

### Display string special cases

- **Overload** is detected **structurally**, not by fixed strings (`decode.ts:11-12,31`): the dot floats with the range (`OL.`, `O.L`, `.OL`, plain `OL`, `-OL`), so decode trims, strips the `.`, and tests `/^-?OL$/`. Overload → `displayValue = null`, `overload = true`.
- **Empty string** is guarded explicitly (`decode.ts:32-36`): `Number('')` is `0`, so an empty display is left as `displayValue = null` rather than a spurious 0. NCV shows `EFLO`/`EF` and `-`/`--`/`---`/`----` (a strength bar) → `Number(...)` is `NaN` → `displayValue = null`.
- Otherwise the trimmed string parses as a signed decimal in the displayed unit; the sign and decimal point are inside the 7 chars.

### Flag bytes

| Flag | Byte | Bit | Decode (`decode.ts`) |
|---|---|---|---|
| `max` | A (`[14]`) | bit3 (`0x08`) | `!!(a & 0x08)` |
| `min` | A | bit2 (`0x04`) | `!!(a & 0x04)` |
| `hold` | A | bit1 (`0x02`) | `!!(a & 0x02)` |
| `rel` | A | bit0 (`0x01`) | `!!(a & 0x01)` |
| `auto` | B (`[15]`) | bit2 (`0x04`) = autorange-**OFF** | `!(b & 0x04)` — auto is the bit **clear** |
| `lowBattery` | B | bit1 (`0x02`) | `!!(b & 0x02)` |
| `hvWarning` | B | bit0 (`0x01`) | `!!(b & 0x01)` |
| `peakMax` | C (`[16]`) | bit2 (`0x04`) | `!!(c & 0x04)` |
| `peakMin` | C | bit1 (`0x02`) | `!!(c & 0x02)` |
| (AC/DC) | C | bit3 (`0x08`) | see below |

**`flags B` bit2 ✅** confirmed = autorange-OFF: set (`0x04`) on non-ranging functions (CONT, °C, µA, NCV) and after a manual RANGE press; clear while autoranging — so `auto = !(b & 0x04)`.

**AC/DC ✅.** `flags C` bit3 (`0x08`) is a **universal** AC/DC indicator (set on ACV and the inherently-AC Hz/NCV; clear on DC functions). The `acdc` field is reported as `'AC'`/`'DC'` only for functions in `ACDC_FUNCTIONS` (`types.ts:143-155`: `ACV, DCV, LozV, ACmV, DCmV, DCuA, ACuA, DCmA, ACmA, DCA, ACA`) via `c & 0x08 ? 'AC' : 'DC'` (`decode.ts:52`); every other function (Hz, OHM, CAP, temp, NCV, combined modes…) reports `''`. (`flags C` bit0 = bar polarity is not decoded.)

### Reading shape

```ts
interface Reading {            // packages/protocol/src/types.ts:5-27
  ts: number;                  // capture time (ms epoch)
  function: string;            // "DCV", "OHM", … or "#<n>" for an unknown code
  displayText: string;         // trimmed LCD string: "1.002", "OL", "EFLO"
  displayValue: number | null; // null when OL / NCV-bar / non-numeric
  displayUnit: string;         // "kΩ", "V", "" (NCV), "?" (unknown function)
  baseValue: number | null;    // SI-normalized: 1002 for 1.002 kΩ
  baseUnit: string;            // "Ω"
  overload: boolean;
  acdc: 'AC' | 'DC' | '';
  bargraph: number;            // raw analog-bar count (byte[12]*10 + byte[13])
  flags: { max; min; hold; rel; auto; lowBattery; hvWarning; peakMax; peakMin };
}
```

## Controls

Front-panel soft buttons, exposed via the driver's `controls` map (`uni-t.ts:56-65`) and sent on the same write characteristic as the handshake. Each is a fixed `AB CD 03 <cmd> 01 <chk16-BE>` frame from `framing.ts:16-23` (chk = `cmd + 0x17B`).

| Control (driver key) | cmd | Bytes (hex) | Source |
|---|---|---|---|
| `backlight` | `0x4B` | `AB CD 03 4B 01 C6` | `framing.ts:16` |
| `maxMin` | `0x41` | `AB CD 03 41 01 BC` | `framing.ts:17` |
| `range` | `0x46` | `AB CD 03 46 01 C1` | `framing.ts:18` |
| `rangeAuto` (RANGE long-press) | `0x47` | `AB CD 03 47 01 C2` | `framing.ts:19` |
| `rel` | `0x48` | `AB CD 03 48 01 C3` | `framing.ts:20` |
| `hzDuty` | `0x49` | `AB CD 03 49 01 C4` | `framing.ts:21` |
| `hold` | `0x4A` | `AB CD 03 4A 01 C5` | `framing.ts:22` |
| `select` (function/mode) | `0x4C` | `AB CD 03 4C 01 C7` | `framing.ts:23` |

> ✅ **The soft buttons work on the UT60BT** with the `AB CD 03 <cmd>` framing in the table above. An *earlier* attempt used the reference repo's generic UNI-T button set (`EA EC 70 <btn> A2 C1 32 71 64 <chk>` framing) and the meter ignored every write — that framing was simply **wrong** (the repo leaves the UT60BT's command slot empty). With the correct `AB CD 03 <cmd>` codes the panel buttons (RANGE/SELECT/HOLD/REL/Hz/MAX-MIN, plus backlight) take effect. The rotary function dial is mechanical and not addressable over BLE, but the soft buttons are.

## Verification

**Confirmed live on a physical `UT60BTk` (2026-06-06):**
- ✅ GATT profile — ISSC Transparent UART; notify `1e4d` (`notify`), write `8841` (`write`/`writeWithoutResponse`). The `0xd0ff` vendor service has no notify char and was dropped.
- ✅ Handshake required — GET-NAME yields an 11-byte `"UT60BT"` name frame, then GET-DATA starts a continuous stream; GET-DATA must follow the name response and may need a re-send (driver retries 5×).
- ✅ Frame layout — 19 bytes `AB CD 10 …` exactly as documented; one whole frame per notification (never split/coalesced) — buffered framing kept anyway.
- ✅ `frame[3]` bit7 always 0; checksum is a 16-bit BE sum of `[0..16]`.
- ✅ Function codes 00,02,03,04,06,07,08,09,0a,0c,0e,14 verified across dial positions.
- ✅ Range→unit for V/mV/Hz(r0)/°C/µA/mA/nF; OHM kΩ confirmed (100 kΩ resistor read ~98 kΩ, matched LCD).
- ✅ Soft buttons (RANGE/SELECT/HOLD/REL/Hz/MAX-MIN + backlight) work with the `AB CD 03 <cmd>` framing. An earlier wrong framing (`EA EC 70 …`, from the reference repo) was ignored, which had mistakenly suggested the meter was read-only; the correct `AB CD 03 <cmd>` codes fixed it.

**Inferred / unverified (⚠️):**
- The OHM **MΩ** step and the CAP (µF/mF) and Hz (kHz/MHz) **metric-prefix** steps — need a known high-value resistor + capacitor; all Ω captures so far were overload. Not blocking; the prefix table comes from the reference impl and the verified cases check out.
- FUNCTIONS codes 22–30 (ACA/DCA dupes, LPF, AC/DC, AC+DC, LPFA, INRUSH) and their RANGE_UNITS rows — ported from `DecoderUni_T.cs` for other UT models, no hardware.
- **UT161A–E** entirely — same decoder and same soft-button codes by lineage, but never live-tested on a UT161.
- Keep-alive `type-request` (9-byte) / `data-request` (7-byte) frames — never observed in captures; responders kept defensively.

## Source

- Driver: `packages/protocol/src/drivers/uni-t.ts`
- Decoder: `packages/protocol/src/decode.ts`, tables in `packages/protocol/src/types.ts`
- Framing + command/control frames: `packages/protocol/src/framing.ts`
- Upstream reference: `webspiderteam/Bluetooth-DMM-For-Windows` — `Decoders/DecoderUni_T.cs` (`Uni_tDecode` / `functionStrings`), `Bluetooth.Dmm/GattMonitor.cs` (DevType 4).
