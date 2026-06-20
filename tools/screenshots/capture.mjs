#!/usr/bin/env node
// README screenshot capture — Playwright, hardware-free via demo mode.
//
// Drives the web app in headless Chromium against `?demo` (single meter) and `?demo=power` (the
// combined V + I + P=V×I multi-device bench view) and writes the PNG/GIF assets the README embeds.
// No Bluetooth, no physical meter — the demo streams synthetic readings, so this is fully repeatable
// in CI or locally.
//
// Prereqs:
//   * the dev server running:  pnpm dev   (serves http://localhost:5173/multimeter/)
//     — or point BASE at a `pnpm preview` of a build.
//   * Chromium for Playwright:  pnpm exec playwright install chromium
//   * (optional) ffmpeg on PATH for the .gif outputs; without it the raw .webm is kept and a note
//     is printed.
//
// Usage:
//   pnpm screenshots                       # all shots → ./assets
//   BASE=http://localhost:4173/multimeter/ pnpm screenshots
//   OUT=/tmp/shots NO_GIF=1 pnpm screenshots
//
// Theme is forced deterministically by seeding localStorage `theme` before the app boots (see
// useTheme.ts) and matching the context `colorScheme`. Each shot is independent and best-effort:
// a failure is logged and the run continues, so one broken shot never sinks the rest.

import { chromium, devices } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE || 'http://localhost:5173/multimeter/').replace(/\/?$/, '/');
const OUT = path.resolve(process.env.OUT || 'assets');
const WANT_GIF = !process.env.NO_GIF;
const SETTLE_MS = Number(process.env.SETTLE_MS || 2500); // let the demo stream + the chart draw
const GIF_MS = Number(process.env.GIF_MS || 4000);
const GIF_W = Number(process.env.GIF_W || 600); // gif width cap (keeps README assets lean)
const GIF_FPS = Number(process.env.GIF_FPS || 10);

const DESKTOP = { width: 1440, height: 900 };
const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const optipng = spawnSync('optipng', ['-v'], { stdio: 'ignore' }).status === 0; // lossless PNG shrink

const url = (query = '', hash = '') => `${BASE}${query}${hash}`;
const log = (...a) => console.log('•', ...a);
const ok = [];
const failed = [];

// Open the app at a given theme + query, wait until the demo is live and settled.
async function openApp(context, { query = '', hash = '' } = {}) {
  const page = await context.newPage();
  await page.goto(url(query, hash), { waitUntil: 'networkidle' }).catch(() => {});
  // The connection chip flips to a "live" label once the demo streams; fall back to a timed settle.
  await page
    .waitForFunction(() => document.body.innerText.match(/live|recording|hold/i), { timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  return page;
}

// A context with the theme seeded before any app script runs (useTheme reads localStorage `theme`).
async function themedContext(browser, theme, extra = {}) {
  const context = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2, ...extra });
  await context.addInitScript(t => window.localStorage.setItem('theme', t), theme);
  return context;
}

async function shot(page, name, { fullPage = false } = {}) {
  const file = path.join(OUT, name);
  try {
    await page.screenshot({ path: file, fullPage, animations: 'disabled' });
    if (optipng) spawnSync('optipng', ['-quiet', '-o2', file], { stdio: 'ignore' }); // lossless shrink
    ok.push(name);
    log('shot', name);
  } catch (e) {
    failed.push(`${name}: ${e.message}`);
    console.warn('  ✗', name, '—', e.message);
  }
}

// Record a short clip of the live readout and convert webm → gif (if ffmpeg is present).
async function gif(browser, name, { query, device } = {}) {
  if (!WANT_GIF) return;
  const dir = path.join(OUT, `.vid-${name}`);
  await mkdir(dir, { recursive: true });
  const context = await themedContext(browser, 'dark', {
    ...(device ? devices[device] : { viewport: DESKTOP }),
    recordVideo: { dir, size: device ? undefined : DESKTOP },
  });
  try {
    const page = await openApp(context, { query });
    await page.waitForTimeout(GIF_MS); // capture the value wandering + the chart scrolling
    await context.close(); // flush the video
    const webm = (await readdir(dir)).find(f => f.endsWith('.webm'));
    if (!webm) throw new Error('no video produced');
    const webmPath = path.join(dir, webm);
    const gifPath = path.join(OUT, `${name}.gif`);
    if (ffmpeg) {
      // Lean README gif: cap width + fps, bayer dither keeps the palette small (smaller file).
      const pal = `fps=${GIF_FPS},scale=iw*min(1\\,${GIF_W}/iw):-1:flags=lanczos`;
      const r = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-i',
          webmPath,
          '-vf',
          `${pal},split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
          gifPath,
        ],
        { stdio: 'ignore' },
      );
      if (r.status === 0) {
        ok.push(`${name}.gif`);
        log('gif', `${name}.gif`);
      } else throw new Error('ffmpeg failed');
      await rm(dir, { recursive: true, force: true });
    } else {
      await rename(webmPath, path.join(OUT, `${name}.webm`));
      await rm(dir, { recursive: true, force: true });
      failed.push(`${name}.gif: ffmpeg not found — kept ${name}.webm; convert manually`);
      console.warn('  ⚠ ffmpeg not found — kept', `${name}.webm`);
    }
  } catch (e) {
    await context.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    failed.push(`${name}.gif: ${e.message}`);
    console.warn('  ✗', `${name}.gif`, '—', e.message);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  log(`base ${BASE}`);
  log(`out  ${OUT}`);
  log(`gif  ${WANT_GIF ? (ffmpeg ? 'on (ffmpeg ok)' : 'on (no ffmpeg — webm fallback)') : 'off'}`);

  const browser = await chromium.launch();
  try {
    // --- desktop, dark: single live + the combined multi-device bench view ---
    {
      const ctx = await themedContext(browser, 'dark', { viewport: DESKTOP });
      let page = await openApp(ctx, { query: '?demo' });
      await shot(page, 'live-dark.png');

      page = await openApp(ctx, { query: '?demo=power' });
      await shot(page, 'power-dark.png'); // NEW: V + I + P=V×I, the headline two-device scenario

      // Record a short session so the Recordings list + a session page have content to show.
      try {
        await page.keyboard.press('r'); // start recording
        await page.waitForTimeout(4000);
        await page.keyboard.press('r'); // stop
        await page.goto(url('?demo=power', '#/recordings'), { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
        await shot(page, 'recordings-dark.png');
        const openBtn = page.getByRole('button', { name: /open/i }).first();
        if (await openBtn.count()) {
          await openBtn.click();
          await page.waitForLoadState('networkidle').catch(() => {});
          await page.waitForTimeout(1500);
          await shot(page, 'session-dark.png');
        } else {
          failed.push('session-dark.png: no recording to open');
        }
      } catch (e) {
        failed.push(`recordings/session: ${e.message}`);
      }
      await ctx.close();
    }

    // --- desktop, light ---
    {
      const ctx = await themedContext(browser, 'light', { viewport: DESKTOP });
      const page = await openApp(ctx, { query: '?demo' });
      await shot(page, 'live-light.png');
      await ctx.close();
    }

    // --- mobile (iPhone 13), dark + light + full-page stats ---
    {
      const ctxDark = await themedContext(browser, 'dark', devices['iPhone 13']);
      let page = await openApp(ctxDark, { query: '?demo' });
      await shot(page, 'mobile-live.png');
      await shot(page, 'mobile-stats.png', { fullPage: true }); // captures stats/recording below the fold
      await ctxDark.close();

      const ctxLight = await themedContext(browser, 'light', devices['iPhone 13']);
      page = await openApp(ctxLight, { query: '?demo' });
      await shot(page, 'mobile-light.png');
      await ctxLight.close();
    }

    // --- motion clips → gifs ---
    await gif(browser, 'live', { query: '?demo=power' }); // the multi-device view in motion
    await gif(browser, 'mobile', { query: '?demo', device: 'iPhone 13' });
  } finally {
    await browser.close();
  }

  console.log(`\n${ok.length} written → ${OUT}`);
  if (failed.length) {
    console.log(`${failed.length} skipped:`);
    for (const f of failed) console.log('  -', f);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
