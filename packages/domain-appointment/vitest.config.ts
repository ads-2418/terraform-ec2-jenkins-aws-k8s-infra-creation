import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/env.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Concurrency test opens many simultaneous connections/transactions on
    // purpose - keep it isolated from other test files running in parallel
    // pools, which could otherwise starve Postgres's connection limit.
    fileParallelism: false,
  },
});
