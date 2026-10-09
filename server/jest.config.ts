import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/../shared'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Only the relative entry here: an absolute entry in `moduleDirectories` is
  // consulted *before* the parent directories are walked (see
  // jest-resolve/nodeModulesPaths), which lets the hoisted `server/node_modules`
  // copy of a package shadow a nested one — e.g. `mime@1.6.0` (via express/send)
  // shadowing the `mime@2.6.0` that `superagent` requires, breaking supertest.
  moduleDirectories: ['node_modules'],
  // `modulePaths` entries are appended *after* the walked-up node_modules dirs,
  // so this stays a pure fallback. It is what lets the `../shared` suites, which
  // live outside this package, resolve devDependencies such as `fast-check`.
  modulePaths: ['<rootDir>/node_modules'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        rootDir: '..',
        baseUrl: '..',
        paths: {
          '*': ['server/node_modules/*']
        }
      }
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};

export default config;
