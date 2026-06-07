import { defineConfig } from 'vitest/config';

// Hooks render under jsdom; the recorder engine persists to IndexedDB (fake-indexeddb).
export default defineConfig({
  test: { environment: 'jsdom', setupFiles: ['./vitest.setup.ts'] },
});
