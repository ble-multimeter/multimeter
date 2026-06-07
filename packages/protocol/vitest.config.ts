import { defineConfig } from 'vitest/config';

// Pure, I/O-free package — runs in Node.
export default defineConfig({
  test: { environment: 'node' },
});
