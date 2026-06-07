/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Web Bluetooth needs a secure context: localhost (dev) is fine; for phone testing
// over the LAN you'd need HTTPS. `host: true` exposes the dev server on the network.
//
// Hosted as a GitHub Pages project site at ble-multimeter.github.io/multimeter/ (PLAN §9), so
// `base` is the repo subpath and the service-worker scope + manifest start_url/scope all
// mirror it. (Switch to '/' + a CNAME only if it ever moves to a dedicated custom domain.)
export default defineConfig({
  base: '/multimeter/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      // Generates 192/512 + maskable + apple-touch PNGs from the one SVG master and injects
      // the <link rel="apple-touch-icon"> tags and manifest icons array automatically.
      pwaAssets: { image: 'public/icon.svg', preset: 'minimal-2023' },
      manifest: {
        name: 'Multimeter — Bluetooth DMM logger',
        short_name: 'Multimeter',
        description:
          'Live readout, charting, recording and CSV/PNG export for Bluetooth multimeters (UNI-T UT60BT).',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        orientation: 'any',
        start_url: '/multimeter/',
        scope: '/multimeter/',
        categories: ['utilities', 'productivity'],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // SPA: serve the app shell for any in-scope navigation when offline.
        navigateFallback: '/multimeter/index.html',
      },
    }),
  ],
  server: { host: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      // Exclude entry point, generated types, and tests.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
});
