# Multimeter

[![CI](https://github.com/ble-multimeter/multimeter/actions/workflows/ci.yml/badge.svg)](https://github.com/ble-multimeter/multimeter/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/ble-multimeter/multimeter/graph/badge.svg)](https://codecov.io/gh/ble-multimeter/multimeter)

A browser companion for the **UNI-T UT60BT** Bluetooth multimeter: a live, full-screen
readout with charting, statistics, recording, and CSV/PNG export. It runs entirely in your
browser over [Web Bluetooth](https://developer.mozilla.org/docs/Web/API/Web_Bluetooth_API) —
no install, no account, no data leaves your machine — and installs as an offline PWA.

**▶︎ [Open the app](https://ble-multimeter.github.io/multimeter/)** &nbsp;·&nbsp;
[Try the demo](https://ble-multimeter.github.io/multimeter/?demo) (no meter needed)

<p align="center">
  <img src="assets/live-dark.png" alt="Live readout with chart and statistics" width="100%">
</p>

## Features

- **Live readout** — a big, glanceable hero value with function, AC/DC, and range badges.
- **Charting** — a rolling live chart (uPlot) with Fit-all / 1m / 5m / 30m windows and a
  pick of five line colors; range changes (kΩ↔MΩ) stay continuous because values are
  normalized to SI.
- **Statistics** — current, min, max, average, peak-to-peak, std-dev, sample count, duration.
- **Recording** — capture sessions to IndexedDB; they survive a reload. Pause / resume / stop.
- **Export** — download any session as **CSV**, or the chart as a **PNG**.
- **Hold, Pin & Copy** — freeze the readout, pin a value to read hands-free while the stream
  runs, or copy the current reading to the clipboard.
- **All UT60BT functions** — V / A / Ω, continuity, diode, capacitance, frequency, duty %,
  temperature, and NCV.
- **PWA** — installable, works offline, light/dark theme that also drives the system UI bars.
- **Keyboard-driven & accessible** — full shortcut set and a screen-reader announce key.

## Screenshots

<p align="center">
  <img src="assets/live.gif" alt="Live readout updating" width="70%">
</p>

<p align="center">
  <img src="assets/mobile-live.png" alt="Mobile live readout" width="30%">
  &nbsp;&nbsp;
  <img src="assets/mobile-stats.png" alt="Mobile statistics and recording" width="30%">
  &nbsp;&nbsp;
  <img src="assets/mobile.gif" alt="Mobile live demo" width="30%">
</p>

<p align="center">
  <img src="assets/recordings-dark.png" alt="Saved recordings" width="49%">
  <img src="assets/session-dark.png" alt="A recorded session" width="49%">
</p>

**Light theme too** — toggle with one tap (or the `t` key); line color is a preset as well
(violet and sky shown here):

<p align="center">
  <img src="assets/live-light.png" alt="Live readout, light theme" width="62%">
  &nbsp;&nbsp;
  <img src="assets/mobile-light.png" alt="Mobile, light theme" width="24%">
</p>

## Requirements

Web Bluetooth is required, which means a **Chromium-based browser** in a secure context
(HTTPS or `localhost`):

| Platform                                | Works | Notes                                                          |
| --------------------------------------- | ----- | -------------------------------------------------------------- |
| Chrome / Edge / Brave / Opera (desktop) | ✅    | Linux, macOS, Windows, ChromeOS                                |
| Chrome (Android)                        | ✅    | Connect the meter directly from the phone                      |
| Firefox / Safari                        | ❌    | No Web Bluetooth                                               |
| iOS / iPadOS                            | ❌    | No Web Bluetooth (works only via a WebBLE browser like Bluefy) |

Power on the meter, then click **Connect** and choose it in the browser's device chooser.

## Getting started

This is a [pnpm](https://pnpm.io) workspace: the app lives in `apps/web` and the reusable logic
is split into packages under `packages/` (see [Packages](#packages)).

```bash
pnpm install
pnpm dev         # Vite dev server for apps/web (also on the LAN for phone testing)
pnpm build       # build every package + the app
pnpm test        # all unit tests (vitest)
pnpm typecheck   # tsc across the workspace
pnpm lint        # eslint across the workspace
```

> **No meter handy?** Append `?demo` to the URL (e.g. `localhost:5173/multimeter/?demo`)
> to drive the whole UI from a synthetic measurement stream — handy for development and the
> screenshots above. Demo mode needs no Bluetooth, so it runs in any browser (Firefox and
> Safari included).

## Keyboard shortcuts

| Key     | Action                   | Key | Action                   |
| ------- | ------------------------ | --- | ------------------------ |
| `c`     | Connect / disconnect     | `e` | Export CSV               |
| `b`     | Toggle backlight         | `i` | Export chart PNG         |
| `h`     | Hold / release           | `v` | Switch Live / Recordings |
| `Space` | Pin current reading      | `s` | Announce reading (a11y)  |
| `r`     | Start / stop recording   | `t` | Toggle light / dark      |
| `p`     | Pause / resume recording | `?` | Show this help           |

## How it works

The UT60BT speaks a simple BLE protocol: the app subscribes to a notify characteristic,
runs the meter's handshake, and decodes each 19-byte measurement frame into a reading
(function, value, unit, flags). The protocol was reverse-engineered from the device; decode
logic is pure and unit-tested against captured frames. Decode + framing sit behind a `Driver`
interface in the protocol package, so other BLE multimeters can be added as drivers without
touching the transport, recording, or UI (a later phase).

## Supported meters & protocols

The app targets the UT60BT, but the protocol package ships drivers for a range of UNI-T and generic
Bluetooth multimeters (Aneng / BSIDE / ZOYI, Owon, Voltcraft, AICARE). See the
**[hardware support list](docs/HARDWARE.md)** for every model and its verification state, and
**[docs/protocols/](docs/protocols/README.md)** for a per-driver protocol spec.

## Packages

The app is a thin shell over framework-agnostic packages, so you can build your own
BLE-multimeter UI (in React **or** Vue) or a headless Node tool on top:

| Package                               | What it is                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ble-multimeter/protocol`      | Pure, I/O-free core: the `Reading` model + unit tables, the uni-t decode/framing, stats/decimate/CSV, and the device-`Driver` interface + registry. Zero deps; Node-safe. |
| `@ble-multimeter/web-bluetooth` | Web Bluetooth `Transport` + the framework-agnostic `MeterSession` engine (connect · handshake · keep-alive · reconnect · demo).                                           |
| `@ble-multimeter/recorder`      | Bluetooth-independent `RecorderSession` · `SessionsStore` · `PinRecorder` engines + the IndexedDB session store.                                                          |
| `@ble-multimeter/react`         | React hooks: `useMeter` · `useRecorder` · `useSessions` · `usePinSession`.                                                                                                |
| `@ble-multimeter/vue`           | The same four as Vue composables.                                                                                                                                         |

`apps/web` consumes `@ble-multimeter/react`, so the app dogfoods the binding it ships.
The packages are structured to be publishable (per-package build → ESM + types) but aren't on
npm yet.

## Tech stack

React 19 · Vue 3 · TypeScript · Vite · Tailwind CSS · uPlot · vite-plugin-pwa · Web Bluetooth ·
IndexedDB · pnpm workspace.

## License

[MIT](LICENSE)
