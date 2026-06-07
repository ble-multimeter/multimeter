import { defineConfig } from 'vitest/config';

// Engine + storage round-trips run in Node against fake-indexeddb (imported per test file).
export default defineConfig({
  test: { environment: 'node' },
});
