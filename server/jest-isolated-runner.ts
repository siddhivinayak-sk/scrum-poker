import TestRunner from 'jest-runner';
import type { Test, TestRunnerOptions, TestWatcher } from 'jest-runner';

/**
 * Test files that measure wall-clock latency and must not share the CPU with
 * other suites. Matched against the absolute test path, with either separator.
 */
export const ISOLATED_TEST_PATTERN = /[\\/]src[\\/]__tests__[\\/]integration[\\/]chat-fanout\.spec\.ts$/;

/**
 * The default Jest runner, in two phases inside one `jest` invocation:
 * every other test file first, in parallel workers as usual, then the files
 * matching `ISOLATED_TEST_PATTERN` in band, after the workers have ended.
 *
 * Keeping both phases in one run means `npm test` stays a single command and
 * a failure in either phase makes it exit non-zero (R22.6), with no change to
 * `package.json` (R26.7). The latency bound of the isolated spec is unchanged.
 */
export default class IsolatedLatencyRunner extends TestRunner {
  override async runTests(tests: Array<Test>, watcher: TestWatcher, options: TestRunnerOptions): Promise<void> {
    const isolated = tests.filter((test) => ISOLATED_TEST_PATTERN.test(test.path));
    const others = tests.filter((test) => !ISOLATED_TEST_PATTERN.test(test.path));

    if (others.length > 0) {
      await super.runTests(others, watcher, options);
    }
    if (isolated.length > 0 && !watcher.isInterrupted()) {
      await super.runTests(isolated, watcher, { ...options, serial: true });
    }
  }
}
