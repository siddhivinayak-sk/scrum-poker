import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/../shared'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
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
