import { defineConfig } from "vite";
import { resolveBuildUpdateFeed } from "./tools/updates/feed-config.mjs";

const canaryBuild = process.env.CODEXDESK_BUILD_CHANNEL === "canary";
const publicReleaseBuild = process.env.CODEXDESK_PUBLIC_RELEASE === "true";
const updateFeed = resolveBuildUpdateFeed({
  canaryBuild,
  publicReleaseBuild,
  configuredUrl: process.env.CODEXDESK_UPDATE_FEED_URL,
});

export default defineConfig({
  define: {
    // A feed is build metadata, not a runtime credential. Never put tokens or
    // authenticated URLs here: packaged JavaScript can be inspected.
    __CODEXDESK_UPDATE_FEED_URL__: JSON.stringify(updateFeed.feedUrl),
    __CODEXDESK_BUILD_CHANNEL__: JSON.stringify(updateFeed.channel),
  },
  build: {
    rollupOptions: {
      external: ["electron", "node:child_process"],
      output: { entryFileNames: "main.js" },
    },
  },
});
