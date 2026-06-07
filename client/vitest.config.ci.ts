import { defineConfig } from 'vitest/config';

/**
 * CI-specific vitest configuration.
 * Forces single-fork execution to avoid race conditions with happy-dom
 * worker initialization on GitHub Actions.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
