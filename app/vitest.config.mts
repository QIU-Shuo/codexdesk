import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit tests only by default: `test/live/` needs a signed-in `codex` CLI and
// network, and is subject to upstream flakiness. Run those with
// `npm run test:live`.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/live/**", "node_modules/**"],
    // Renderer tests need a DOM; main-process tests ignore it.
    environment: "jsdom",
  },
});
