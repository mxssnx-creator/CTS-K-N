import { availableParallelism } from "node:os"
import type { Config } from "jest"

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  globalSetup: "<rootDir>/jest.global-setup.js",
  // Per-worker Redis database so real-Redis runs can be parallel.
  setupFiles: ["<rootDir>/__tests__/support/per-worker-redis.cjs"],
  setupFilesAfterEnv: [
    "<rootDir>/__tests__/support/per-file-redis-reset.ts",
    "<rootDir>/__tests__/diagnostic-cleanup.ts",
  ],
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  transform: {
    "^.+\\.mjs$": "<rootDir>/__tests__/support/esm-jest-transform.cjs",
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          // Separate tsconfig for tests — allows test runner globals without
          // polluting the production tsconfig. Inherits all other options.
          types: ["jest", "node"],
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          // Transpile each file on its own instead of type-checking the whole
          // program per test file. Types are enforced by `pnpm typecheck`
          // (tsc --noEmit) in CI; this keeps the suites several times faster.
          isolatedModules: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // Tests that hit the running dev server (e2e / integration) need a longer
  // timeout — the engine can be slow on first compile.
  testTimeout: 30_000,
  // Parallel by default: each worker gets its own Redis database (1-15) and a
  // fresh one per test file, so at most 15 workers. Use the *:serial scripts
  // (--runInBand --detectOpenHandles) to chase leaked handles.
  maxWorkers: Math.max(1, Math.min(15, availableParallelism() - 1)),
}

export default config
