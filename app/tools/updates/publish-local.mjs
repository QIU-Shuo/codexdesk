import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createStaticUpdateManifest } from "./manifest.mjs";

const appRoot = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(
  await readFile(path.join(appRoot, "package.json"), "utf8"),
);
const arch = process.env.CODEXDESK_UPDATE_ARCH || process.arch;
const makeDir = path.join(appRoot, "out", "make", "zip", "darwin", arch);
const entries = await readdir(makeDir).catch(() => []);
const candidates = entries.filter(
  (name) =>
    name.includes("CodexDesk-canary") &&
    name.endsWith(`-${packageJson.version}.zip`),
);

if (candidates.length !== 1) {
  throw new Error(
    `Expected one macOS ${arch} ZIP for version ${packageJson.version} in ${makeDir}; found ${candidates.length}. Run npm run make:canary first.`,
  );
}

const feedDir = path.resolve(
  process.env.CODEXDESK_LOCAL_UPDATE_DIR ||
    path.join("/tmp", "CodexDesk-canary-updates"),
);
await mkdir(feedDir, { recursive: true });

const zipName = candidates[0];
const sourceZip = path.join(makeDir, zipName);
const publishedZip = path.join(feedDir, zipName);
await copyFile(sourceZip, publishedZip);

const baseUrl = new URL(
  process.env.CODEXDESK_LOCAL_UPDATE_BASE_URL || "http://127.0.0.1:4319/",
);
if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
const updateUrl = new URL(zipName, baseUrl).href;
const feedUrl = new URL("feed.json", baseUrl).href;

const manifestPath = path.join(feedDir, "feed.json");
const manifest = createStaticUpdateManifest({
  version: packageJson.version,
  url: updateUrl,
  name: `CodexDesk canary ${packageJson.version}`,
  notes:
    process.env.CODEXDESK_UPDATE_NOTES ||
    "Private canary update for local end-to-end testing.",
  publishedAt: new Date().toISOString(),
});
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Published ${publishedZip}`);
console.log(`Feed URL: ${feedUrl}`);
