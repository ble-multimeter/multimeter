# Handoff — UT60BT web app

Status as of this handoff. Read alongside `PLAN.md` (product/architecture) and `PROTOCOL.md`
(byte format). **Phases 0–4 are complete (single-device, UT60BT only).** The next agent's job is
Phase 5 (multi-device drivers) — see `PLAN.md` §6/§9.

## Build / verify

```bash
npm run dev        # localhost dev server (host:true for LAN/phone testing)
npm run test       # vitest — 78 tests, all green
npm run typecheck  # tsc --noEmit — clean
npm run build      # tsc && vite build — clean
```

End-to-end behavior needs the **physical meter + a Chromium browser** (Web Bluetooth). The pure
logic (decode, stats, decimate, csv, storage) is unit-tested headless; UI/theme/contrast must be
eyeballed in the browser in both themes — that has **not** been done yet (no display in the build env).

## What's done

- **Phase 0–1** — BLE transport/framing/decode, `useMeter`, live `HeroReadout` + `FlagBadges` +
  connection UI. Decode is pure + tested against captured frames (`captures/`).
- **Phase 2+3 (merged)** — one rolling history buffer feeds chart + stats + recording. See the
  data-flow note below. Live chart (uPlot), stats panel, Record/Pause/Stop, CSV+PNG export,
  IndexedDB persistence, Sessions list with read-only reopen/rename/delete/re-export.
- **Phase 4 (partial)**:
  - ✅ Unsupported-browser screen (`UnsupportedBrowser.tsx`)
  - ✅ Light/dark theme + toggle (see theming note) — **dark stays pixel-identical to before**
  - ✅ Reconnect UX (manual button; full handshake re-run in `useMeter`)
  - ✅ Accessibility pass: focus-visible rings, reduced-motion, ARIA (aria-current tabs,
    aria-pressed toggles, role=group, decorative dots/glyphs aria-hidden, input labels),
    accessible shortcuts dialog, polite live region for on-demand reading announcement
  - ✅ Keyboard shortcuts (see `ShortcutsHelp.tsx` `SHORTCUTS` + handler in `App.tsx`)
  - ✅ Single top header (merged the old status bar + nav bar into one)
  - ✅ **Responsive double-header** — `App.tsx` renders the view tabs (`tabs()` helper) inline on
    `sm:`+ and as a full-width second row under the status/actions bar on narrow screens.
  - ✅ **Chart-color picker** — `ChartColorPicker` (header popover) + `useChartColor` (persisted
    like the theme) + `lib/chartColors.ts` (per-theme hex presets). The resolved stroke threads
    `App → LiveChart` (live) and `App → SessionsList → SessionViewer → LiveChart` (reopened), so it
    drives the line and therefore the PNG export. `LiveChart` rebuilds on stroke change (added to
    the build effect deps alongside `dark`).
  - ✅ **Themed accessible dialogs** — `components/Dialog.tsx` (`Modal` focus-trap shell +
    `ConfirmDialog` + `PromptDialog`) replaces the native `confirm()`/`prompt()` in `SessionsList`
    (delete / rename now drive React state).
  - ✅ **PWA / offline install** — `vite-plugin-pwa` (generateSW, `registerType: autoUpdate`) +
    `@vite-pwa/assets-generator` rendering icons from `public/icon.svg`. Vite `base`, SW scope, and
    manifest `start_url`/`scope` are all **`/multimeter/`** (GitHub Pages project site at
    `mbtech-nl.github.io/multimeter/`; PLAN §9 — no custom domain, to keep `mbtech.nl` private).
    `npm run build` emits `sw.js` + `manifest.webmanifest` + PNG icon set. **The SW is build-only**
    (no `devOptions.enabled`), so the install prompt does NOT appear under `npm run dev` — use
    `npm run build && npm run preview` (or the live site) to test install/offline.

## Phase 4 — verification still owed

The pure logic is unit-tested (78 green) and the production build + preview serve cleanly, but
**nothing below has been eyeballed in a real browser** (no display in this env):
- Both themes + all 5 chart colors on the live chart and PNG export.
- The responsive header (and hero/stats/sessions) at phone widths and landscape.
- A real PWA install + offline load — needs an **HTTPS deploy** (GitHub Pages not yet set up; no
  git repo exists here — `git init` + Pages is the remaining deploy step, PLAN §9).
- The themed dialogs (focus trap, Esc, backdrop) with a keyboard and a screen reader.

## Optional (PLAN §6 "later") — don't start unless asked

Auto-reconnect on unexpected drop; threshold alarms; chart markers.

## Architecture notes the next agent must know

- **Data flow:** `useMeter` (BLE → `Reading | null`) → `useRecorder(reading)` builds the bounded
  current-segment `Sample[]` (chart) + live `Stats`, and on Record persists full `Reading`s to
  IndexedDB in batches. `useSessions` reads them back. Components never touch BLE or storage
  directly. Pure libs in `src/lib/` (`stats`, `decimate`, `csv`, `storage`, `exporters`, `download`).
- **Segments (PLAN §3.4):** quantity key = `` `${function}|${acdc}` `` (`src/ble/types.ts`
  `quantityKey`). Range changes stay one segment; mode / °C↔°F / AC↔DC start a new one. `csv.ts`
  and `SessionsList` both re-derive segments from this — keep them consistent.
- **Theming trick (IMPORTANT):** the UI is written dark-first with literal `zinc-*` classes. In
  Tailwind v4 those compile to `var(--color-zinc-*)`, so `index.css` themes by **mirroring the zinc
  ramp** (light = 950↔50, …) under `:root`, restoring the real ramp under `.dark`. Consequence:
  **only `zinc-500` is stable across themes — every other zinc shade flips.** So:
  - For neutral text that must read in both themes, `zinc-400` works well (lands dark in light mode,
    light in dark mode). Avoid `zinc-600`+ for body text.
  - Accent text (red/emerald/amber) on translucent surfaces uses explicit `dark:` variants
    (e.g. `text-red-700 dark:text-red-300`).
  - A control that needs a *fixed* light/dark color (not mirrored) must use literal hex —
    see `ThemeToggle.tsx`.
  - **`<LiveChart>` colors are JS, not classes**, so they can't ride the variable swap — it takes a
    `dark` prop (threaded from `App` through `SessionsList`) and rebuilds uPlot on theme change.
- **Keyboard shortcuts** live in `App.tsx` (`onKey`, bound once via a ref so it always sees fresh
  state) and are listed in `ShortcutsHelp.tsx` `SHORTCUTS` (single source of truth for the help
  dialog — keep the two in sync). Ignored while typing / with modifiers.
- **Export** logic is shared in `lib/exporters.ts` (used by `ExportButtons` and the `e`/`i`
  shortcuts). CSV is **full-resolution from IndexedDB**, never the decimated chart series (§3.3).
- **Storage size:** ~3–5 MB/hour (full `Reading` per frame at ~2–3 Hz). Fine for browser quota.
  If it ever matters, the lever is a compact tuple row format in `storage.ts` (~3–4× smaller).

## Post-Phase-4 additions (single-device QoL)

- **Status doubles as the connect control.** `ConnectionChip` exports `connectionAction(meter)`
  (the one action for the current state); the status cluster is a button that runs it (verb pill +
  hover), and App's `c` shortcut calls the same helper. The separate Connect/Reconnect/Disconnect
  buttons are gone.
- **Device menu (Backlight).** `DeviceMenu` (in `ConnectionChip`) is a kebab next to the status,
  live-only, holding meter commands — currently just Backlight (the one command the meter honors).
  Replaced the standalone Backlight button so meter controls sit under the connected device.
- **Fake HOLD.** The meter ignores button commands (§PROTOCOL 2), so HOLD is UI-side: App keeps a
  `held: Reading | null` snapshot; the hero shows `held ?? meter.reading` and an amber HOLD chip.
  Chart/stats/recording keep running on the live stream. The Hold toggle lives **next to the
  measurement** (under the hero, live only) or `h`; auto-released when leaving the live state.
- **Pin session (per-item capture).** Reframed: a pin is one appended `Reading` in a normal
  recording `Session`, not a separate list. `usePinSession` (writes via `storage.ts`: create on
  first pin → `appendSamples` per pin → `updateSession` metadata; `deleteSample` for undo; finalize
  on Stop). `PinSession` component = Pin button (auto-starts) + running list + match-spread summary
  + Undo/CSV/Stop. Finished pin sessions appear in **Recordings** like any recording and export via
  the normal session CSV. Pin = **Space** (guarded so it still activates a focused button/link).
  Trade-off vs the old design: no per-item label/delete (it's a recording) — Undo-last covers fat-
  fingers, rename the whole session in Recordings.
- **SEO** — `index.html` has title/description, canonical, Open Graph + Twitter tags (absolute URLs
  at `https://mbtech-nl.github.io/multimeter/`), and a `<noscript>` fallback. Update those absolute
  URLs if the deploy origin ever changes (e.g. a dedicated domain).

- **Routing** — `react-router-dom` + `HashRouter` (in `main.tsx`). Routes: `/` (live),
  `/recordings` (list), `/recordings/:id` (one session). Hash-based on purpose — a GH Pages project
  subpath has no SPA fallback, so clean URLs would 404 on deep-link/refresh before the SW caches.
  `App` owns the `<Routes>`; the live dashboard is the `/` element. `SessionsList` (list) navigates
  to `/recordings/:id`; `SessionViewer` reads `:id` via `useParams` and calls `sessions.open(id)`
  itself (driven by the URL, not internal state), so a session is bookmarkable and Back works.
  Header tabs derive active state from `useLocation`; the `v` shortcut toggles via `navigate`.

## New files since Phase 1

```
src/lib/        stats.ts decimate.ts csv.ts storage.ts download.ts exporters.ts chartColors.ts (+ *.test.ts)
src/hooks/      useRecorder.ts useSessions.ts useTheme.ts useChartColor.ts usePinSession.ts
src/components/  LiveChart.tsx StatsPanel.tsx RecordControls.tsx ExportButtons.tsx
                 SessionsList.tsx ThemeToggle.tsx ShortcutsHelp.tsx ChartColorPicker.tsx
                 Dialog.tsx (Modal + ConfirmDialog + PromptDialog) PinSession.tsx
                 (ConnectionChip.tsx exports ConnectionStatus + DeviceMenu + connectionAction)
deps added:     uplot + react-router-dom (runtime), fake-indexeddb (dev),
                vite-plugin-pwa + @vite-pwa/assets-generator (dev, PWA)
```
