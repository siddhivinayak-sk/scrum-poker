import { defineConfig } from 'vitest/config';

// The harness shells out to `helm template`, so it needs a real Node
// environment and a real filesystem - not the browser-like environment the
// client's Vitest project uses.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // One `helm template` spawn costs roughly 100-300 ms and a property runs
    // at least 100 iterations, so a single property test can take minutes.
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Chart renders are independent but every one spawns a process; keep file
    // level parallelism modest so a full run does not thrash the host.
    maxWorkers: 2,
    reporters: ['default'],
  },
});
