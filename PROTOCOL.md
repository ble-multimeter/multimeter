# UT60BT BLE Protocol

Reverse-engineered protocol for the **UNI-T UT60BT** digital multimeter over Bluetooth
Low Energy. This is the engineering reference for the parsing/transport layer of the app.

> **Sources.** Derived from the open-source
> [`webspiderteam/Bluetooth-DMM-For-Windows`](https://github.com/webspiderteam/Bluetooth-DMM-For-Windows)
> (`Decoders/DecoderUni_T.cs`, `Bluetooth.Dmm/GattMonitor.cs`), which lists the UT60BT as a
> supported device. Cross-checked against the device's own `Binary raw data.md` capture notes.
>
> **Status legend:** ✅ confirmed from a working implementation · ⚠️ confirmed in code but
> **must be verified against our physical unit on first connect** (the repo supports several
> meters that differ here).

The UT60BT uses UNI-T's modern **"iDMM" protocol**: a serial-style link over BLE GATT with
`0xAB 0xCD`-framed packets. (An *older* family of UNI-T/Aneng meters instead streams raw
LCD-segment bitmaps — the UT60BT does **not** use that, and we ignore it.)

---

## 1. Transport: GATT layout

A "transparent UART" BLE module: one **notify** characteristic (meter → app, the measurement
stream) and one **write** characteristic (app → meter, commands).

✅ **Confirmed against our physical `UT60BTk` (GATT enumeration, 2026-06-06).** The meter uses the
**Microchip/ISSC "Transparent UART"** service. The "16-bit IDs" in earlier notes (`0xFE7D`,
`0x1E4D`, `0x8841`, `0x6DAA`) were never 16-bit services — they are *fragments of the full 128-bit
ISSC UUIDs*. The generic `0xFFF0` profile is **not present** on our unit.

Candidate A — **ISSC Transparent UART** `49535343-fe7d-4ae5-8fa9-9fafd205e455` (enumerated chars):

| Role | Full UUID |
|---|---|
| Notify (meter→app) | `49535343-1e4d-4bd9-ba61-23c647249616` ⚠️ confirm `notify` property |
| Write (app→meter) | `49535343-8841-43f4-a8d4-ecbe34729bb3` ⚠️ confirm `write`/`writeWithoutResponse` |
| Write fallback | `49535343-6daa-4d02-abf6-19569aca69fe` |
| Other | `49535343-aca3-481c-91ec-d85e28a60318` |

Candidate B — vendor service `0000d0ff-3c17-d293-8e48-14fe2e4da212` (enumerated chars: `ffd1 ffd2
ffd3 ffd4 ffd5 ffd8 fff1 fff2 ffe0`). The `fff1`/`fff2` pair echoes UNI-T's generic `0xFFFx` serial
family and `ffe0` is the classic HM-10 notify char, so this is a *plausible alternate* stream path.

The strong bet is **Candidate A** (the webspiderteam decoder matched `1e4d`/`8841` for this device
class). The Phase-0 tool reads the `properties` of every char to find which is notify vs write, then
tries the handshake on A first, B second.

Device also exposes Device Information `0x180a` (standard chars `2a23–2a2a`, `2a50` — model/serial/
firmware strings, nice-to-have). GAP/GATT `0x1800`/`0x1801` are **blocklisted by Web Bluetooth** and
unreachable — ignore. (A `0xff12` service was seen in advertisement but did not enumerate
characteristics; low priority.)

**Web Bluetooth note:** `requestDevice` must list every service we might talk to in
`optionalServices`, or the characteristics are invisible. Filter on `namePrefix: "UT60BT"` (our unit
reports the name `UT60BTk`). Request both candidate services: `49535343-fe7d-4ae5-8fa9-9fafd205e455`
and `0000d0ff-3c17-d293-8e48-14fe2e4da212` (plus `0x180a` for device info).

---

## 2. Handshake / session start ✅

The meter is silent until asked. After connecting:

1. Subscribe to notifications on the notify characteristic (write the CCCD / `startNotifications()`).
2. Write **GET-NAME** to the write characteristic.
3. **Wait for the meter's name-frame response** (the 11-byte `"UT60BT"` control frame), not a
   fixed delay — see below.
4. Write **GET-DATA**. The meter now streams measurement frames continuously.

> **⚠️ GET-DATA must follow the name response, and may need a retry (confirmed live, 2026-06-06).**
> A blind "wait ~200 ms then GET-DATA" **races the name response and loses**: if GET-DATA reaches the
> meter before it has answered GET-NAME, the meter sends only the name frame and **never starts
> streaming**. Drive the handshake off the event, not a timer: send GET-NAME, wait for the control
> frame (with a ~1.5 s timeout fallback), then send GET-DATA — and if no measurement frame arrives
> within ~700 ms, **resend GET-DATA** (a lone GET-DATA can still be dropped). Our `useMeter` retries
> up to 5×. The old fixed-delay handshake worked only by luck of timing.

Writes use **Write Without Response** when the characteristic supports it, else Write With Response.

### Command frames (fixed — just send these bytes)

| Command | Bytes (hex) | Purpose |
|---|---|---|
| GET-NAME | `AB CD 03 5F 01 DA` | request device type / wake the stream |
| GET-DATA | `AB CD 03 5D 01 D8` | start streaming measurements |
| BACKLIGHT | `AB CD 03 4B 01 C6` | toggle the meter's backlight |

Frame shape: `AB CD <len> <cmd> <param> <checksum>`, where `<len>` counts the bytes after it.
Command checksum is a single byte `(sum of all preceding bytes − 1) & 0xFF` (this differs from the
*measurement* checksum, §3). We only ever send the three fixed commands above, so **hardcode them**.

**Control commands — only backlight works. ❌ (tested 2026-06-06).** The reference repo also defines a
generic UNI-T button-command set with `EA EC 70 <btn> A2 C1 32 71 64 <chk>` framing (Auto Range,
HOLD, AC/DC, mV, OHM, Cap, Diode, NCV, A/mA, °C/°F, Min/Max, REL/ZERO). We sent all 14 to our
UT60BT (writes succeeded) and the meter **ignored every one** — consistent with the repo leaving the
UT60BT's command slot (`commandDatas[4]`) empty. The rotary function dial is mechanical and not
addressable over BLE regardless. **Conclusion: the UT60BT is read-only except for BACKLIGHT.**

### GET-NAME response & keep-alive ✅ (confirmed on `UT60BTk`)

Right after GET-NAME the meter replies with an **11-byte name frame**:
`AB CD 08 55 54 36 30 42 54 03 25` = `AB CD 08 "UT60BT" <chk16>`. It's not a measurement (length
≠ 19) and may also reappear mid-stream. The decoder ignores it; the framing layer just treats any
non-19-byte `AB CD` frame as control.

The docs also list short request frames the meter *may* send (re-send the matching command to
answer). We did **not** observe these in our captures — the meter streamed continuously after the
GET-NAME/GET-DATA handshake — but keep the responders in for safety:

| Received | Meaning | Respond with |
|---|---|---|
| 9 bytes, `AB CD .. AA AA ..` | "TypeRequest" | re-send **GET-NAME** |
| 7 bytes, `AB CD .. FF 00 ..` | "DataRequest" | re-send **GET-DATA** |

---

## 3. Measurement frame (19 bytes) ✅

The payload we care about. One frame ≈ one LCD update (a few per second).

```
offset  bytes  field
 0       1     0xAB                      header
 1       1     0xCD                      header
 2       1     0x10 (= len, 16)          payload length
 3       1     function code             low 7 bits index FUNCTIONS[]; bit7 unknown (mask it off)
 4       1     range, as ASCII digit     '0'..'7'  → (byte − 0x30) indexes the unit table
 5       7     display string (ASCII)    e.g. " 0.000", "-OL ", "  0.L"  (trim spaces)
12       1     bargraph high             progress = byte[12]*10 + byte[13]
13       1     bargraph low
14       1     flags A                   bit3 MAX · bit2 MIN · bit1 HOLD · bit0 REL
15       1     flags B                   bit2 autorange-OFF (0 = autoranging) · bit1 battery-low · bit0 HV-warning
16       1     flags C                   bit3 AC (1=AC, 0=DC — holds for ALL modes) · bit2 peak-max · bit1 peak-min · bit0 bar polarity
17       2     checksum: 16-bit big-endian sum of bytes [0..16]
18
```

**Checksum ✅ (confirmed).** Bytes [17][18] = `Σ(bytes[0..16])` as a 16-bit big-endian value
(e.g. DCV frame Σ=712=`0x02C8` → `… 02 c8`; Hz frame Σ=754=`0x02F2` → `… 02 f2`). Validate it to
detect framing desync and resync on the next `AB CD`.

**`flags B` bit2 ✅** confirmed = autorange-OFF: set (`0x04`) on non-ranging functions (CONT, °C,
µA, NCV) and after a manual RANGE press; clear while autoranging. **`flags C` bit3 ✅** = AC: set
(`0x08`) on ACV and the inherently-AC functions Hz and NCV; clear on all DC functions — so it's a
universal AC/DC indicator, not "only in combined mode."

**Anything other than 19 bytes is a control/keep-alive frame** (see §2), not a measurement.

### `FUNCTIONS[]` (index = `frame[3] & 0x7F`) ✅

Codes marked ✓ were seen and verified in our `UT60BTk` captures (2026-06-06).

```
 0 ACV ✓   1 ACmV    2 DCV ✓   3 DCmV ✓  4 Hz ✓    5 %
 6 OHM ✓   7 CONT ✓  8 DIODE ✓ 9 CAP ✓  10 °C ✓   11 °F
12 DCuA ✓ 13 ACuA   14 DCmA ✓ 15 ACmA   16 DCA    17 ACA
18 HFE    19 Live   20 NCV ✓  21 LozV   ...       (extras: LPF, AC/DC, INRUSH)
```

`frame[3]` bit7 was always **0** in captures; keep masking it. The display string carries the
decimal point, so we never compute decimal places from the range — only the unit/prefix.

### Range → unit (index = `frame[4] − 0x30`) ✅

The range digit selects the displayed unit *and* the metric prefix. Examples:

| Function | range 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| OHM | Ω | kΩ | kΩ | kΩ | MΩ | MΩ | MΩ | |
| CAP | nF | nF | µF | µF | µF | mF | mF | mF |
| Hz | Hz | Hz | kHz | kHz | kHz | MHz | MHz | MHz |
| ACV/DCV/LozV | V | V | V | V | | | | |
| ACmV/DCmV | mV | | | | | | | |
| DCuA/ACuA | µA | µA | | | | | | |
| DCmA/ACmA | mA | mA | | | | | | |
| DCA/ACA | (range 1) A | | | | | | | |
| °C / °F | °C / °F | | | | | | | |

**Verification status:** ✅ confirmed by capture — `ACV`/`DCV` ranges 0–3 all = **V** (range-swept,
no prefix change); `DCmV` = mV; `Hz` range 0 = Hz; `°C`, `µA`, `mA` as listed; `CAP` range 0 = nF
(read ~0.011 nF stray). ✅ **`OHM` kΩ confirmed live (2026-06-06):** a 100 kΩ resistor read ~98 kΩ —
the app's readout matched the meter LCD exactly (the ~2% is just resistor tolerance). ⚠️ **still
unverified** — the `OHM` **MΩ** step (needs a ≥1 MΩ resistor) and `CAP` (µF/mF) and `Hz` (kHz/MHz)
*prefix* steps. Confirming these needs a known high-value resistor + capacitor (see §5). Not blocking.

AC vs DC and true-RMS are implied by the function name (`ACV`, `DCV`, … are distinct codes);
only the combined `AC/DC` function reads `frame[16]` bit3 to decide.

### Display string special cases ✅

- **Overload:** all four forms confirmed in real frames — `OL.` (OHM/CONT @ range 0), `O.L`
  (OHM @ range 5), `.OL` (DIODE/CAP), plain `OL` (µA/temp). The dot position moves with the range,
  so **detect overload structurally**: trim spaces, strip the `.`, and test for `OL` (allowing a
  leading `-`) → no numeric value. Don't match fixed strings.
- **NCV (non-contact voltage):** shows `EFLO`/`EF`, and `-`/`--`/`---`/`----` (a strength bar, not a
  number). Captured `"  EFLO "` and `"     - "` on fn 20.
- Otherwise the string parses as a signed decimal in the **displayed** unit (with the prefix from
  the range table). The sign and decimal point are inside the 7 chars.

### Two values per reading

For each measurement compute both:

- **`displayValue`** — exactly what's on the LCD, in the displayed unit (e.g. `1.002 kΩ`).
- **`baseValue`** — normalized to the SI base unit by applying the prefix exponent
  (k=10³, M=10⁶, m=10⁻³, µ=10⁻⁶, n=10⁻⁹) and dropping the prefix (e.g. `1002 Ω`).

`baseValue` is what we chart, so the curve stays continuous when **autoranging** flips the prefix
(0.998 kΩ → 1.002 kΩ, or kΩ → MΩ) — see PLAN.md §"Handling mode & range changes".

---

## 4. Decoded reading — the shape the app consumes

```ts
type Reading = {
  ts: number;            // capture time (ms epoch)
  function: string;      // "DCV", "OHM", ...
  displayText: string;   // raw "1.002"
  displayValue: number | null;  // null when OL / NCV-bar / non-numeric
  displayUnit: string;   // "kΩ"
  baseValue: number | null;     // 1002  (normalized SI)
  baseUnit: string;      // "Ω"
  overload: boolean;
  acdc: "AC" | "DC" | "";
  bargraph: number;      // 0..~. raw bar count
  flags: { max:boolean; min:boolean; hold:boolean; rel:boolean;
           auto:boolean; lowBattery:boolean; hvWarning:boolean;
           peakMax:boolean; peakMin:boolean };
};
```

---

## 5. Open questions — resolve on first connect with the real unit

The app's first job on its very first successful connection is to **log the full GATT table and a
handful of raw notification frames to the console** (developer aid, not a user-facing feature), so
we can confirm:

1. **Which GATT profile** (`0xFFF0` vs `0xFE7D`) the UT60BT exposes, and the exact char UUIDs.
2. Whether the **handshake is required**, or the meter streams as soon as notifications are enabled.
3. That frames are **19 bytes, `AB CD 10 …`** as documented above.
4. The meaning of `frame[3]` bit7 and the trailing checksum bytes (currently ignored).
5. Real `function`/`range` code values across every dial position (turn the knob through all modes
   while capturing) — to fill any gaps in the tables above.

Until verified, treat ✅ items as high-confidence and ⚠️ items as needing one capture session.

### Progress (2026-06-06, `UT60BTk`) — Phase 0 essentially complete

- ✅ **Q1 GATT profile** — ISSC Transparent UART (§1). Notify = `1e4d` (`notify`), write = `8841`
  (`write`/`writeWithoutResponse`); properties confirmed live. `0xd0ff` has no notify char → not the
  stream. Drop it from the app and request only the ISSC service (+ `0x180a`).
- ✅ **Q2 handshake** — required; GET-NAME → 200 ms → GET-DATA, then continuous stream. GET-NAME
  yields an 11-byte `"UT60BT"` name frame.
- ✅ **Q3 frame layout** — 19 bytes `AB CD 10 …` exactly as documented. Each notification carried
  one whole frame in our captures (never split/coalesced) — but keep the buffered framing for safety.
- ✅ **Q4** — `frame[3]` bit7 always 0; checksum is a 16-bit BE sum (§3).
- ✅ **Q5 function codes** — verified 00,02,03,04,06,07,08,09,0a,0c,0e,14 (see `FUNCTIONS[]`).
- ⚠️ **Remaining:** physically verify the OHM/CAP/Hz *metric-prefix* range steps with a known
  resistor + capacitor (all Ω captures so far were overload). Not blocking Phase 1 — the prefix
  table is from the reference impl and the V/mV/Hz/°C/µA/mA/nF cases check out.

**Captured fixtures** for the decode tests live in the chat capture dumps (DCV/ACV/DCmV/Hz/OHM/CONT/
DIODE/CAP/°C/µA/mA/NCV frames, incl. overload + range sweeps).

---

## 6. Multi-device source map (Phase 5 — `web-dmm`)

The source app routes by a **user-picked `DevType`** (the index of the device-type dropdown), not by
auto-detection. `Utilities.cs` `ParseGattValue(data, LogData, isBDM)` switches on that index into one
of six decoders, and `GattMonitor.cs` holds the matching GATT service per index in `deviceUUIDs[]`.
Our UT60BT is **DevType 4** (`Uni_tDecode`, the protocol documented above).

| DevType | Dropdown label | Decoder (`Decoders/*.cs` + `Utilities.cs` fn) | GATT service / notify / write | Device families (from README) |
|---|---|---|---|---|
| 0 | "Aneng, B-Side, Zoyi Type" | `DecoderBluetoothDMM` → `BDMDecode` (11-byte) | `FFF0 / FFF4 / FFF3` | Aneng V05B, AN9002, ST207, AN999S · BSIDE ZT-5B, ZT-300AB, ZT-5BQ · ZOYI ZT-5B, ZT-300AB, ZT-5BQ, ZT-5566SE · BABATools AD900 |
| 1 | "Owon Old Type (B35T e.g)" | `DecoderOwon` → `b35tDecodeOld` | `FFF0 / FFF4 / FFF3` | Owon B35T |
| 2 | "Owon Plus Type (B35t+, B41t+ e.g)" | `DecoderOwon` → `owonPlusTypeDecode` | `FFF0 / FFF4 / FFF3` | Owon B35T+, B41T+, OW18E, CM2100B |
| 3 | "AICARE Devices (AP-570C-APP e.g)" | `DecoderAI_Care` → `aiCareDecode` | `FFB0 / FFB2 / FFB1` | AICARE intelligent clamp meters |
| **4** | **"Uni-T Device With Bluetooth"** | **`DecoderUni_T` → `Uni_tDecode`** | **`FE7D / 1E4D / 8841` (+`6DAA` alt write)** | **UNI-T BLE meters — UT60BT ✓; other UT-series w/ built-in BT + meters via the UT-D07A/B adapter** |
| 5 | "Voltcraft VC800 and VC900 Series" | `DecoderVoltcraft` → `VoltcraftDecode` | `FFF0 / FFF4 / FFF3` | Voltcraft VC800, VC900 series |

**Notes for the Phase-5 driver work:**

- These `0xFFFx` / `0xFFBx` "16-bit IDs" are the *short forms* the C# app matches by; the real
  characteristics are 128-bit Bluetooth-SIG base UUIDs (`0000FFF0-0000-1000-8000-00805f9b34fb`,
  etc.). For Web Bluetooth, list each full UUID in `optionalServices`. None are on the Web Bluetooth
  blocklist (`0x1800/0x1801` are, but those aren't data services here).
- **`DevType` is user-selected in the source app.** On the web, auto-detect by advertised service
  works only to split `FE7D`→uni-t and `FFB0`→ai-care; **families 0, 1, 2, 5 all share `0xFFF0`** and
  differ only in frame decoding, so they need a frame-format sniff or a manual device-type chooser.
- Each decoder is a pure byte→reading function (same shape as our `decode.ts`), so porting one =
  adding one `Driver`. Start with **DevType 0 (`BDMDecode`)** — one port covers ~12 rebadged clones.
- **Verification:** only meters physically on hand can be live-checked; ports from this source are
  validated against its own logic + any sample frames, and each driver should advertise its status
  (live-tested vs. ported-unverified). Same ⚠️/✅ discipline as §3 above.
