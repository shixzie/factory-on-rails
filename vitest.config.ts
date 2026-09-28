import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // The Postgres suites reset the same test database, so files run one at a time.
    fileParallelism: false,
  },
});
