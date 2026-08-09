import { defineConfig } from "vite";

// The preload must not collide with the main bundle: forge's vite plugin
// defaults both to `.vite/build/index.js`, so the second build silently
// overwrites the first and `preload.js` is never found at runtime.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["electron"],
      output: {
        format: "cjs",
        codeSplitting: false,
        entryFileNames: "preload.js",
      },
    },
  },
});
