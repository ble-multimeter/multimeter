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
    },
  },
});
