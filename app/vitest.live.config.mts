import { defineConfig } from "vitest/config";

// Live tests against a real `codex app-server`. Needs a signed-in CLI and
// network; run deliberately, not in a tight loop.
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 120000,
    fileParallelism: false,
  },
});
