# UNI-T UT202BT (AC clamp) — `ut202bt`

> **State:** `expected` (rides the `verified` UT60BT decoder; no clamp hardware tested). **Driver:** `packages/protocol/src/drivers/ut202bt.ts`. **Source:** ported from `webspiderteam/Bluetooth-DMM-For-Windows` / UNI-T "deviceType 1"; reuses the UT60BT decode path.

## (overview)

The UT202BT is a UNI-T AC clamp meter. In UNI-T's Smart Measure app it is a **"deviceType 1"** device, which means it speaks the **exact same iDMM protocol as the UT60BT**: the same `0xAB 0xCD`-framed BLE link, the same GET-NAME → GET-DATA handshake, the same 19-byte measurement frame, and the same decoder. The `ut202bt` driver therefore does not implement any of that itself — it imports `decode()`, `FrameParser`, and the shared `COMMANDS` table and wires them up (`ut202bt.ts:13-14`).

What is genuinely UT202BT-specific is small and physical: it is a clamp, so the live ranges are the clamp's current/voltage/resistance functions (ACA/DCA/ACV/Ω) rather than a handheld DMM's, and its front panel has **dedicated function-select keys** (ACA / ACV / Ω / NCV) that the UT60BT panel does not have. Those keys are documented in the driver as raw command bytes but are **deliberately not exposed** through the generic control set (`ut202bt.ts:6-8,56-61`).

For everything shared — frame layout, function/range tables, flag bytes, checksum, the full handshake rationale — see **[`./uni-t.md`](./uni-t.md)**. This doc only covers the deltas.

## Models

| Model | BLE name prefix | State |
|---|---|---|
| UT202BT | `UT202BT` | `expected` (`ported-unverified`) — rides the verified UT60BT decoder; clamp-specific keys + no hardware test |

The driver declares `id: 'ut202bt'`, `label: 'UNI-T UT202BT Clamp'`, `verification: 'ported-unverified'`, and `namePrefixes: ['UT202BT']` (`ut202bt.ts:24-28`).

## Transport (GATT)

Same Microchip/ISSC **"Transparent UART"** module as the rest of the UNI-T handheld family — one notify characteristic (meter → app stream), one write characteristic (app → meter commands), and a second write characteristic as a fallback (`ut202bt.ts:19-22,29`).

| Role | Full UUID | Source |
|---|---|---|
| Service (ISSC Transparent UART) | `49535343-fe7d-4ae5-8fa9-9fafd205e455` | `ut202bt.ts:19` |
| Notify (meter→app) | `49535343-1e4d-4bd9-ba61-23c647249616` | `ut202bt.ts:20` |
| Write (app→meter) | `49535343-8841-43f4-a8d4-ecbe34729bb3` | `ut202bt.ts:21` |
| Write fallback | `49535343-6daa-4d02-abf6-19569aca69fe` | `ut202bt.ts:22` |

The `gatt.write` field is the ordered array `[ISSC_WRITE, ISSC_WRITE_FALLBACK]` (`ut202bt.ts:29`) so the transport can fall back to `6daa` if `8841` is unwritable.

**Routing — name-only.** The UT202BT shares the ISSC service UUID with the whole UNI-T handheld family, so the service alone cannot tell them apart, and the advertised name is the only thing available before the handshake. The driver's `match` is therefore strictly name-based: `ctx.name?.startsWith('UT202BT') ?? false` (`ut202bt.ts:31-33`). The session registry routes by advertised name so the drivers in this family don't fight over the shared service.

## Handshake / session start

Identical to the UT60BT — ask for the name (control) frame first, then nudge GET-DATA until the measurement stream starts (`ut202bt.ts:37-47`). The meter ignores GET-DATA until it has answered GET-NAME, so the sequence is event-driven, not timer-driven (full rationale in [`./uni-t.md`](./uni-t.md)).

Sequence (`handshake(io)`):

1. Write **GET-NAME** = `AB CD 03 5F 01 DA` (`COMMANDS.GET_NAME`, `framing.ts:14`).
2. `waitForFrame(k => k === 'control', 1500)` — wait up to 1.5 s for the name/control frame (`ut202bt.ts:41`).
3. Up to 5 attempts: write **GET-DATA** = `AB CD 03 5D 01 D8` (`COMMANDS.GET_DATA`, `framing.ts:15`), then `waitForFrame(k => k === 'measurement', 700)`; return as soon as a measurement frame arrives (`ut202bt.ts:42-45`).
4. If no measurement frame after 5 attempts, throw `'meter did not start streaming after handshake'` (`ut202bt.ts:46`).

**Re-request handling.** `onRequest` mirrors the UT60BT: a `type-request` frame triggers a re-send of GET-NAME, a `data-request` frame re-sends GET-DATA (`ut202bt.ts:49-52`). These are the meter's "poll me again" frames classified by length in `framing.ts:42-47` (9-byte `type-request`, 7-byte `data-request`).

## Frame format

The UT202BT streams the **same `AB CD` 19-byte measurement frame as the UT60BT** — header `AB CD 10`, function code, range digit, the 7-char LCD string, bargraph, three flag bytes, and a 16-bit big-endian checksum. The driver constructs the parser with `createFramer: () => new FrameParser()` (`ut202bt.ts:35`), i.e. the shared `FrameParser` from `framing.ts` with no clamp-specific changes.

The shared function table already covers the clamp's live functions — **ACA / DCA / ACV / OHM (Ω)** are entries in the same `FUNCTIONS` / `RANGE_UNITS` tables the UT60BT uses, so no new decode logic is needed for the clamp. NCV (non-contact voltage) is a front-panel mode, not a numeric measurement.

For the byte-by-byte frame layout, the function/range tables, the bargraph computation, and the checksum, see **[`./uni-t.md`](./uni-t.md)** — it is the canonical reference and `ut202bt.ts` adds nothing to it.

## Decode

`decode: (bytes, ts) => decode(bytes, ts)` (`ut202bt.ts:54`) — a thin pass-through to the shared decoder in `decode.ts`. There is **no UT202BT-specific decode path**.

The shared `decode()` (`decode.ts:14-66`) validates the 19-byte `AB CD` frame, masks `bit7` off the function byte (`decode.ts:21`), looks up the function name and per-range unit, parses the LCD string into `displayValue` plus an SI-normalized `baseValue`, detects overload (`OL`), and unpacks the three flag bytes into `{ max, min, hold, rel, auto, lowBattery, hvWarning, peakMax, peakMin }`. AC/DC is derived from flag byte C bit3 for functions in `ACDC_FUNCTIONS` (`decode.ts:52`) — which is exactly how the clamp's ACA/DCA and ACV/DCV are distinguished. See **[`./uni-t.md`](./uni-t.md)** for the field-by-field semantics.

## Controls

Only the controls shared with the UT60BT front panel are exposed through the generic `MeterControl` set (`ut202bt.ts:56-61`):

| Control | Command | Bytes | Source |
|---|---|---|---|
| `range` | `COMMANDS.RANGE` | `AB CD 03 46 01 C1` (cmd `0x46` — step manual range) | `ut202bt.ts:59`, `framing.ts:18` |
| `hold` | `COMMANDS.HOLD` | `AB CD 03 4A 01 C5` (cmd `0x4A` — data hold) | `ut202bt.ts:60`, `framing.ts:22` |

**Clamp front-panel function-select keys — documented but NOT wired.** The UT202BT panel has dedicated function-select keys (reverse-engineered from `Anjianview2`) that the generic UT60BT control set has no slot for. They are recorded in the driver's header comment as raw command codes but are **intentionally left out of the `controls` map** and the `MeterControl` union (`ut202bt.ts:6-8,56-57`):

| Front-panel key | Command code | Source |
|---|---|---|
| ACA (AC current) | `0x31` | `ut202bt.ts:8` |
| ACV (AC voltage) | `0x33` | `ut202bt.ts:8` |
| Ω (resistance) | `0x35` | `ut202bt.ts:8` |
| NCV (non-contact voltage) | `0x36` | `ut202bt.ts:8` |

These four codes are **not** present in the shared `COMMANDS` table (`framing.ts:13-24`); that table holds only the `0x41–0x4C` soft-button block plus GET-NAME/GET-DATA. The clamp keys live in the `0x31–0x36` range and would need to be added as raw frames (with their own checksums) before they could be sent — the driver does not do this today, so there is no wired way to drive the clamp's function selection from the app.

## Verification

**`expected` (`ported-unverified`).** The decode path is the live-tested UT60BT one, so the frame parsing, decoding, and the RANGE/HOLD/handshake commands are as trustworthy as the UT60BT's (`ut202bt.ts:10-11`). What is **not** verified:

- No physical UT202BT clamp was bench-tested; clamp function/range behaviour is inferred from the shared tables.
- The clamp-specific function-select key codes (ACA `0x31` / ACV `0x33` / Ω `0x35` / NCV `0x36`) are taken from the Smart Measure app decompile and have not been confirmed against hardware — and are not wired up, so they cannot even be exercised through the current driver.

## Source

`packages/protocol/src/drivers/ut202bt.ts` (driver) · `packages/protocol/src/decode.ts` (shared decoder) · `packages/protocol/src/framing.ts` (shared `FrameParser` + `COMMANDS`). Cross-reference: [`./uni-t.md`](./uni-t.md) for the shared frame/decode/handshake detail.
