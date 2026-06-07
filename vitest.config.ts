import { defineConfig } from 'vitest/config';

// Workspace test runner: each package/app provides its own environment (node for the pure
// packages, jsdom for web-bluetooth/recorder/react/vue/app). Coverage aggregates across all.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test-readings.ts',
        '**/vitest.setup.ts',
        'apps/*/src/test/**',
        'apps/*/src/main.tsx',
        '**/*.d.ts',
      ],
      // Ratchet floor: CI fails if coverage regresses below these. The library packages sit at
      // 94-100%; the global is held down by apps/web's UI components, which are intentionally
      // out of unit-test scope (verified in-browser instead). Raise these as coverage grows.
      thresholds: {
        statements: 72,
        branches: 60,
        functions: 64,
        lines: 73,
      },
    },
  },
});
