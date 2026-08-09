import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePublicAssetBaseUrl } from "./feed-config.mjs";
import { createStaticUpdateManifest } from "./manifest.mjs";

const appRoot = path.resolve(import.meta.dirname, "../..");
const repositoryRoot = path.resolve(appRoot, "..");
const packageJson = JSON.parse(
  await readFile(path.join(appRoot, "package.json"), "utf8"),
);
const arch = process.env.CODEXDESK_UPDATE_ARCH || process.arch;
const makeDir = path.join(appRoot, "out", "make", "zip", "darwin", arch);
const expectedZip = `CodexDesk-darwin-${arch}-${packageJson.version}.zip`;
const candidates = (await readdir(makeDir).catch(() => [])).filter(
  (name) => name === expectedZip,
);

if (candidates.length !== 1) {
  throw new Error(
    `Expected ${expectedZip} in ${makeDir}. Build and notarize the public release candidate first.`,
  );
}

const assetBaseUrl = resolvePublicAssetBaseUrl(
  process.env.CODEXDESK_UPDATE_ASSET_BASE_URL,
);
const notesPath = path.join(repositoryRoot, "RELEASE_NOTES.md");
const notes = await readFile(notesPath, "utf8");
const publishedAt =
  process.env.CODEXDESK_RELEASE_PUBLISHED_AT || new Date().toISOString();
if (Number.isNaN(Date.parse(publishedAt))) {
  throw new Error("CODEXDESK_RELEASE_PUBLISHED_AT must be an ISO-8601 date.");
}

const manifest = createStaticUpdateManifest({
  version: packageJson.version,
  url: new URL(expectedZip, assetBaseUrl).href,
  name: `CodexDesk ${packageJson.version}`,
  notes,
  publishedAt,
});
const manifestPath = path.join(makeDir, "feed.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Prepared update manifest: ${manifestPath}`);
console.log(`Release asset: ${manifest.releases[0].updateTo.url}`);
