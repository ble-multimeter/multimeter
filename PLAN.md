# web-dmm — Plan

A browser-based companion for Bluetooth multimeters — **no install, no account, runs from a URL** on
a laptop, phone, or tablet. The **UNI-T UT60BT** is the first supported meter (Phases 0–4); **Phase 5**
generalizes to a driver-based app covering many BLE DMMs (see §6 Phase 5 and §9).

---

## 1. Why this exists (the cause)

A multimeter shows **one number, right now**. That's its limitation, not a feature. The moment you
want to answer a question that involves *time* or *records*, a bare meter fails you:

- "Is this rail actually stable, or does it sag when the motor kicks in?"
- "How fast is this battery discharging? Will it last the night?"
- "This fault is intermittent — it only flickers for half a second. Did you see that?"
- "I need a graph of the cooldown curve for the repair report."
- "I'm under the bench with both hands on the probes — I can't also read a tiny LCD."

The UT60BT has Bluetooth precisely so it can be *logged*. But the official app is mobile-only,
clunky, and locks your data inside it. This tool's job is to turn the meter's live stream into the
three things a meter can't give you on its own:

1. **A readout you can actually see** — full-screen, from across the room.
2. **History** — a live chart and a recorded log of how the value moved over time.
3. **Portable data** — export to CSV / PNG so the measurement leaves with you.

Everything in this plan serves those three. If a feature doesn't help someone *see*, *record*, or
*take away* a measurement, it's out of scope.

### Who uses it

- **Hobbyist / maker** debugging a circuit — wants to watch a rail or sensor live and graph it.
- **Repair tech** — capturing intermittent faults and documenting before/after for a job.
- **Battery / solar / power tinkerer** — multi-hour discharge and charge curves.
- **Educator / student** — a big live graph to project in class.

What they have in common: they need the *shape of the measurement over time*, hands-free, and they
need to keep it.

---

## 2. Platform reality (constraints we design around)

- **Web Bluetooth** works only in **Chromium browsers** (Chrome, Edge, Brave, Opera) on desktop and
  Android. **Not** Firefox, **not** iOS Safari. We detect this and show a clear, friendly
  "open this in Chrome/Edge" screen rather than a broken page. (iOS users: note the Bluefy browser.)
- Requires a **secure context** — HTTPS in production, `localhost` in dev.
- Connecting **must** be triggered by a user gesture (a button click). No auto-connect on load.
- A tab in the background may be throttled; long unattended logging is best with the tab focused.
  We surface this expectation rather than pretend otherwise.
- Pure SPA, browser-only. No backend. Data lives in the browser (and in files the user exports).

---

## 3. The product

### 3.1 Core screens / states

1. **Welcome / unsupported-browser** — one-line pitch + a single **Connect** button, or the
   "use a Chromium browser" message if Web Bluetooth is missing.
2. **Connecting** — native pairing chooser fires; we show progress and handle
   cancel / timeout / "device not found" gracefully.
3. **Live** (the main screen) — see below.
4. **Disconnected / reconnect** — meter out of range or powered off; offer reconnect, keep the
   recorded data intact.

### 3.2 Live screen layout

- **Hero readout** — the value, large, with unit and mode (e.g. `12.47 V  DC`). Annunciators shown
  as quiet badges: `HOLD` `REL` `AUTO` `MAX` `MIN` `AC/DC`, plus **low-battery** and **HV-warning**
  as prominent alerts. Overload (`OL`) renders clearly as "overload", not a fake number.
- **Live chart** — value vs. time, auto-scaling, scrolling window with a "fit all / last N min"
  toggle. Charts the normalized **`baseValue`** (see §5) so autoranging doesn't create cliffs.
  Overload / non-numeric samples render as **gaps**, not zeros.
- **Statistics panel** — for the current recording (or the visible window): **min, max, average,
  peak-to-peak, sample count, duration, current/last**. This is the meter's MIN/MAX/REL, but better
  and reset-able on demand.
- **Recording controls** — **Record / Pause / Stop**, a session name field, and a sample counter.
  Live view always shows the latest reading; *recording* is the explicit act of keeping it.
- **Export** — **Download CSV** and **Download chart PNG** for the current session.
- **Connection chip** — device name, link status, battery flag, and **Disconnect**.

### 3.3 Recording model

- A **session** = a named, timestamped series of `Reading`s with summary stats.
- Sampling: keep every frame the meter sends (a few Hz). For very long sessions, **decimate the
  in-memory chart series** (e.g. cap at ~N points via downsampling) while the **CSV export keeps
  full resolution**. Never silently drop data without saying so in the UI.
- Sessions persist to **IndexedDB** so a reload or accidental disconnect doesn't lose hours of data;
  a **Sessions list** lets the user reopen, re-export, or delete past recordings.
- **CSV export reads full-resolution samples from IndexedDB**, not the decimated in-memory chart
  series — the in-memory cap is a render concern only and must never bound export fidelity.

### 3.4 Handling mode & range changes

The semantics of the value change when the user turns the dial or autorange shifts:

- **Range change within a mode** (e.g. kΩ ↔ MΩ): no break — `baseValue` is normalized, so the curve
  stays continuous.
- **Mode/function change** (e.g. DCV → OHM): the quantity itself changed. We **end the current chart
  segment and start a new one**, label it with the new mode, and reset the live statistics window.
  The recording can either auto-split into per-mode segments or prompt to start a fresh session
  (default: auto-segment, clearly delimited in the chart and the CSV). The segment-split trigger must
  also fire on changes that aren't a function-code change but still change the quantity: **°C ↔ °F**
  and the combined-mode **AC ↔ DC** flip (`frame[16]` bit3, §PROTOCOL 3).

---

## 4. Architecture

Vite + React + TypeScript + **TailwindCSS**. Browser-only SPA. Routing is **react-router-dom with
`HashRouter`** (`/` live · `/recordings` list · `/recordings/:id` one session) — hash-based because a
GitHub Pages project subpath has no SPA fallback, so deep links / refresh would 404 with clean URLs
before the service worker is cached (§9). This gives a working Back button and bookmarkable sessions.

```
src/
  ble/
    transport.ts     Web Bluetooth: requestDevice (with name filter + both services in
                     optionalServices), connect, subscribe, write, reconnect. Knows both
                     candidate GATT profiles (§PROTOCOL 1) and picks whichever the device
                     exposes. Emits raw notification chunks (Uint8Array) — does NOT assume
                     one notification == one frame.
    protocol.ts      Buffered framing state machine: accumulates notification chunks, syncs on
                     AB CD, reads the <len> byte to slice exact frames, and validates the
                     trailing checksum to detect/recover from desync. Classifies 19-byte
                     measurement vs 7/9-byte keep-alive; sends GET-NAME / GET-DATA / keep-alive
                     replies (§PROTOCOL 2). One notification != one frame: frames may be split
                     or coalesced, so never key on chunk length.
    decode.ts        Pure function: Uint8Array → Reading (§PROTOCOL 3-4). Fully unit-tested
                     against captured frames; no BLE deps so it runs in Node tests. Degrades
                     gracefully: unknown function/range codes fall back to the raw display
                     string + "?" unit and never throw — the hero readout always shows what the
                     LCD shows even before the tables are complete.
    types.ts         Reading, Session, FUNCTIONS[], unit tables.
  hooks/
    useMeter.ts      Orchestrates transport+protocol: connection state machine, latest reading,
                     keep-alive handling, reconnect. The one hook the UI consumes.
    useRecorder.ts   Recording state, sample buffer, stats, IndexedDB persistence.
  lib/
    stats.ts         min/max/avg/p2p/stddev over a series (pure, tested).
    csv.ts           Session → CSV.
    storage.ts       IndexedDB session store.
  components/        HeroReadout, LiveChart, StatsPanel, RecordControls, ConnectionChip,
                     SessionsList, UnsupportedBrowser, FlagBadges.
  App.tsx
```

**Key boundaries**
- `decode.ts` and `stats.ts` are **pure and tested** — the byte-parsing is where bugs hide, so it's
  isolated from React and BLE and verified against real captured frames.
- All BLE quirks live behind `useMeter`; components never touch Web Bluetooth APIs.
- **Reconnect re-runs the full handshake**, not just `gatt.connect()`: after any drop we must
  re-`startNotifications`, then GET-NAME → wait → GET-DATA again (§PROTOCOL 2). The connection state
  machine treats this as one atomic "bring the stream back" step, not a transport-only concern.
- Charting: **uPlot** — built for streaming time-series; SVG/re-render libs (Recharts) struggle with
  multi-hour series. Kept behind `<LiveChart>` so the choice is cheap to revisit.

---

## 5. Data handling decisions (from PROTOCOL)

- Chart and stats operate on **`baseValue`** (normalized SI: always Ω, always V, …) so autorange is
  invisible on the graph. The hero readout shows the **`displayValue` + displayUnit** exactly as the
  LCD does — users trust what matches their meter.
- **Overload / NCV / non-numeric** → `value = null` → chart gap, excluded from stats (but counted and
  shown as an "overload" marker).
- CSV columns: `timestamp, function, displayValue, displayUnit, baseValue, baseUnit, acdc, flags…`.

---

## 6. Build phases

> **Status:** Phases 0–4 ✅ done, **single-device (UT60BT only)**. Phase 4 complete: theme +
> a11y + reconnect + responsive double-header, PWA/offline install (`vite-plugin-pwa`, base
> `/web-dmm/`), chart-color picker, and themed accessible confirm/prompt dialogs. Multi-device
> support is **Phase 5** (see below). See `HANDOFF.md` for the full state.


**Phase 0 — Validate protocol (one capture session with the meter on the desk).**
Minimal connect + console-dump of the GATT table and raw frames. Resolve PROTOCOL §5 open questions:
which profile, **the advertised device name** (needed for the `requestDevice` filter), handshake
needed?, confirm the 19-byte layout, **observe whether notifications arrive one-frame-per-chunk or
split/coalesced** (informs the framing buffer), and collect real function/range codes across all dial
positions. Save the raw captures as fixtures for the `decode.ts` tests. This is throwaway scaffolding
/ dev tooling — *not* a shipped screen.

**Phase 1 — Live readout.** `transport` + `protocol` + `decode`, `useMeter`, HeroReadout + flags +
ConnectionChip. Connect → see the live value matching the LCD. Decode unit-tested against Phase-0
captures.

**Phase 2 — Chart + stats.** LiveChart (segmented by mode, gaps for OL), StatsPanel, mode/range
handling per §3.4.

**Phase 3 — Recording + export.** useRecorder, RecordControls, CSV + PNG export, IndexedDB
persistence, Sessions list.

**Phase 4 — Polish (single device: UT60BT).** Unsupported-browser screen, reconnect UX, dark mode,
PWA/offline install, responsive layout for phone/tablet, friendly empty/error states. Plus two QoL
items: a **chart-color picker** (preset swatches, global preference persisted like the theme,
auto-adjusted per theme for contrast — drives the line and therefore the PNG export) and a
**themed, accessible confirmation/input dialog** to replace the native `window.confirm()` (delete)
and `window.prompt()` (rename) in `SessionsList` — focus-trapped, Esc-to-cancel, ARIA, theme-aware.

**Phase 5 — Multi-device (generic `web-dmm`).** Generalize beyond the UT60BT into a driver-based BLE
multimeter app, porting protocols from the source Windows app
(`webspiderteam/Bluetooth-DMM-For-Windows`, C#). Everything above `decode` is already device-agnostic
(chart/stats/recording/export operate on the normalized `Reading`), so this touches **only
`src/ble/`**:

- `src/ble/drivers/` — a `Driver` interface `{ match, services, handshake?, frame(), decode() }` and
  a registry. Today's transport+protocol+decode become the `ut60bt` driver; each driver keeps a pure,
  unit-tested `decode()` (project discipline).
- `transport.ts` offers **every** driver's service UUID in `optionalServices` + every name filter to
  `requestDevice`, then selects the matching driver post-connect. `useMeter` and everything above it
  stay unchanged.

**Device-type selection (design point):** the Windows app makes the user pick the type from a
dropdown. On the web we can auto-detect by advertised GATT service where it's unambiguous
(`0xFE7D`→Uni-T, `0xFFB0`→AICARE), but **four families share `0xFFF0`** (BDM, Owon-old, Owon-plus,
Voltcraft) and differ only in frame decoding — so for those, either sniff the frame format or fall
back to a manual "device type" chooser. Decide in Phase 5.

**Verification honesty:** only devices physically on hand can be live-verified. Others are ported
from the source and tested against whatever sample frames it carries; each driver advertises its
verification status (live-tested vs. ported-unverified) rather than implying all are bench-tested.

**Device catalog** (6 protocol families = 6 drivers; grouped by shared decoder + GATT service):

| Driver (source decoder) | GATT service | Device families | Effort |
|---|---|---|---|
| **uni-t** (DevType 4) — *done* | Transparent UART `FE7D/1E4D/8841` | UNI-T BLE: UT60BT ✓; other UT-series with built-in BT + meters via the UT-D07A/B adapter | **near-free** — same service/handshake/framing; only per-model function & range tables need confirming |
| **bdm** (DevType 0) | `FFF0/FFF4/FFF3` | Aneng V05B/AN9002/ST207/AN999S, BSIDE ZT-5B/ZT-300AB/ZT-5BQ, ZOYI ZT-5B/ZT-300AB/ZT-5BQ/ZT-5566SE, BABATools AD900 | **highest value** — one decoder unlocks ~12 rebadged clones |
| **owon-plus** (DevType 2) | `FFF0` | Owon B35T+, B41T+, OW18E, CM2100B | medium |
| **owon-old** (DevType 1) | `FFF0` | Owon B35T | medium |
| **ai-care** (DevType 3) | `FFB0/FFB2/FFB1` | AICARE clamp meters (e.g. AP-570C) | medium |
| **voltcraft** (DevType 5) | `FFF0` | Voltcraft VC800 / VC900 series | medium |

Suggested order: **bdm first** (most models per unit of work), then expand Uni-T coverage, then
Owon / AICARE / Voltcraft as hardware and captures become available.

**Phase 6 — Multiple meters at once + derived channels.** Today the app pairs **one** meter
(`useMeter` holds a single connection). Phase 6 generalizes to **several simultaneous connections**
and lets the user **combine their live values into a computed quantity** — the headline case being
**power**: connect a volt meter and an amp meter and chart/record **P = V × I (W)** as a first-class
channel alongside the raw two. This builds directly on the Phase 5 driver work (each physical meter
is an independent driver instance) and the device-agnostic `Reading` (a derived channel is just a
synthesized `Reading` stream the chart/stats/recorder/export already handle).

- **Multi-connection transport:** `requestDevice` once per meter (each is its own user gesture);
  keep a keyed map of connections. `useMeter` → `useMeters` returning per-device readings; the
  framing/handshake/reconnect logic is per-connection and unchanged.
- **Derived channels:** a small expression layer that takes N input streams + a formula
  (`watts = a.baseValue * b.baseValue`, also `Ω = V/I`, efficiency, deltas) and emits a synthetic
  `Reading`. Time-align by nearest-sample (meters tick independently at a few Hz); a derived sample
  is emitted when any input updates, using each input's latest value. Define base-unit sanity
  (V·A→W) and surface a clear "stale input" state when one meter drops.
- **UI:** assign a role/label per connected meter (e.g. "V source", "I source"), a derived-channel
  builder, and a multi-series chart. Recording/CSV/PNG gain the derived column.
- **Honesty:** derived values are only as time-correct as the slowest meter's sample rate — show the
  alignment window and per-input timestamps so a fast transient isn't mistaken for synchronized.

**Later / maybe (only if they serve the cause):**
- **Threshold alarms** — visual/audio alert when a value crosses a limit ("tell me when the battery
  drops below 11 V") — strong fit for unattended logging.
- **Markers/annotations** on the chart timeline.
- **Control commands** back to the meter: **only BACKLIGHT works** — the `EA EC` button-command set
  (range/function/hold/etc.) was tested against the physical UT60BT and the meter ignores it, and the
  function dial is mechanical (§PROTOCOL 2). So a backlight toggle is the one viable control; nice-to-have.

---

## 7. Out of scope

- No native/mobile app, no backend, no cloud sync, no accounts.
- Not a generic "Bluetooth GATT explorer" — the raw-frame dump exists only as a dev aid in Phase 0.
- Other meters: out of scope **through Phase 4** (UT60BT only); multi-device support is **Phase 5**
  (§6), not abandoned — the decode layer was isolated precisely to make that a driver swap.

---

## 8. Open product questions

- Default chart window length and the in-memory point cap (tune after seeing real sample rate).
- Auto-segment on mode change vs. prompt for a new session (plan assumes **auto-segment**).
- Which charting lib (uPlot vs Recharts) — decide in Phase 2.

---

## 9. Naming & deployment

- **Name:** `multimeter` — a generic browser BLE multimeter app; the UT60BT is its first driver and
  Phase 5 adds the rest. (Earlier working name `web-dmm`; "ohmie" was rejected for prior-art.)
- **Home:** GitHub **`mbtech-nl/multimeter`**, sibling to the separate LAN-instrument app
  `mbtech-nl/lxi-web`. npm scope `@mbtech-nl/*` only if the pure protocol/decode layer is ever
  published as a package (not planned yet).
- **Hosting:** GitHub Pages **project site** at **`mbtech-nl.github.io/multimeter/`**. Vite `base`,
  the service-worker scope, and the manifest `start_url`/`scope` are all **`/multimeter/`**. Deploy
  via the `.github/workflows/deploy.yml` Pages Action (Settings → Pages source = GitHub Actions).
  **No custom domain** — deliberately avoided `mbtech.nl` to keep that zone (home IP / private
  services) out of public CT logs and repo files; a dedicated domain could be added later (set
  `base` to `/` + a `public/CNAME`). Routing is `HashRouter` — Pages has no SPA fallback (§4).
