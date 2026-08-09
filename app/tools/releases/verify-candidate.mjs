import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extractFile } from "@electron/asar";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBuildUpdateFeed } from "../updates/feed-config.mjs";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(
  await readFile(path.join(appRoot, "package.json"), "utf8"),
);
const canaryBuild = process.env.CODEXDESK_BUILD_CHANNEL === "canary";
const publicReleaseBuild = process.env.CODEXDESK_PUBLIC_RELEASE === "true";
const arch = process.env.CODEXDESK_UPDATE_ARCH || process.arch;
const productName = canaryBuild ? "CodexDesk-canary" : "CodexDesk";
const bundleId = canaryBuild
  ? "com.qiushuo.codexdesk.canary"
  : "com.qiushuo.codexdesk";
const appPath = path.join(
  appRoot,
  "out",
  `${productName}-darwin-${arch}`,
  `${productName}.app`,
);
const zipDir = path.join(appRoot, "out", "make", "zip", "darwin", arch);
const zipPath = path.join(
  zipDir,
  `${productName}-darwin-${arch}-${packageJson.version}.zip`,
);

async function run(command, args) {
  const result = await execFileAsync(command, args, {
    cwd: appRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function runBuffer(command, args) {
  const result = await execFileAsync(command, args, {
    cwd: appRoot,
    encoding: null,
    maxBuffer: 200 * 1024 * 1024,
  });
  return result.stdout;
}

async function plistValue(key) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  return (await run("plutil", ["-extract", key, "raw", "-o", "-", plist]))
    .stdout;
}

await stat(appPath);
await stat(zipPath);
await run("codesign", ["--verify", "--deep", "--strict", appPath]);
await run("unzip", ["-tq", zipPath]);

const zippedPaths = [
  {
    label: "main executable",
    appPath: path.join(appPath, "Contents", "MacOS", productName),
    zipPath: `${productName}.app/Contents/MacOS/${productName}`,
  },
  {
    label: "signature resources",
    appPath: path.join(appPath, "Contents", "_CodeSignature", "CodeResources"),
    zipPath: `${productName}.app/Contents/_CodeSignature/CodeResources`,
  },
];
const digest = (contents) =>
  createHash("sha256").update(contents).digest("hex");
for (const item of zippedPaths) {
  const [appContents, zipContents] = await Promise.all([
    readFile(item.appPath),
    runBuffer("unzip", ["-p", zipPath, item.zipPath]),
  ]);
  if (digest(appContents) !== digest(zipContents)) {
    throw new Error(
      `ZIP ${item.label} does not match the inspected application bundle`,
    );
  }
}

const actualBundleId = await plistValue("CFBundleIdentifier");
const actualVersion = await plistValue("CFBundleShortVersionString");
const bundledIconName = await plistValue("CFBundleIconFile");
if (actualBundleId !== bundleId) {
  throw new Error(`Expected bundle ID ${bundleId}, found ${actualBundleId}`);
}
if (actualVersion !== packageJson.version) {
  throw new Error(
    `Expected version ${packageJson.version}, found ${actualVersion}`,
  );
}

const resourcesPath = path.join(appPath, "Contents", "Resources");
const requiredResources = [
  "LICENSE",
  "NOTICE",
  "PRIVACY.md",
  "LICENSES.chromium.html",
  path.join("THIRD_PARTY_LICENSES", "npm-production-notices.txt"),
];
for (const relativePath of requiredResources) {
  await stat(path.join(resourcesPath, relativePath));
}

const sourceNotices = await readFile(
  path.resolve(appRoot, "../THIRD_PARTY_LICENSES/npm-production-notices.txt"),
);
const bundledNotices = await readFile(
  path.join(
    resourcesPath,
    "THIRD_PARTY_LICENSES",
    "npm-production-notices.txt",
  ),
);
if (digest(sourceNotices) !== digest(bundledNotices)) {
  throw new Error("Bundled production dependency notices are stale");
}

if (publicReleaseBuild) {
  const expectedFeed = resolveBuildUpdateFeed({
    canaryBuild: false,
    publicReleaseBuild: true,
    configuredUrl: process.env.CODEXDESK_UPDATE_FEED_URL,
  }).feedUrl;
  const mainBundle = extractFile(
    path.join(resourcesPath, "app.asar"),
    ".vite/build/main.js",
  );
  if (!mainBundle.includes(Buffer.from(expectedFeed))) {
    throw new Error(
      "Packaged main process does not contain the approved update feed URL",
    );
  }
}

const sourceIcon = path.join(appRoot, "assets", "codexdesk.icns");
const bundledIcon = path.join(
  appPath,
  "Contents",
  "Resources",
  bundledIconName,
);
await stat(bundledIcon);
const sourceIconHash = (
  await run("shasum", ["-a", "256", sourceIcon])
).stdout.split(/\s+/)[0];
const bundledIconHash = (
  await run("shasum", ["-a", "256", bundledIcon])
).stdout.split(/\s+/)[0];
if (sourceIconHash !== bundledIconHash) {
  throw new Error("Packaged app icon does not match assets/codexdesk.icns");
}

const signature = await run("codesign", ["-dvvv", appPath]);
const signatureDetails = `${signature.stdout}\n${signature.stderr}`;
if (!signatureDetails.includes("Authority=Developer ID Application:")) {
  throw new Error(
    "Candidate is not signed with a Developer ID Application identity",
  );
}
if (!signatureDetails.includes("runtime")) {
  throw new Error("Candidate signature does not enable hardened runtime");
}

const checksum = (await run("shasum", ["-a", "256", zipPath])).stdout;
const checksumHash = checksum.split(/\s+/)[0];
await writeFile(
  path.join(zipDir, "SHA256SUMS.txt"),
  `${checksumHash}  ${path.basename(zipPath)}\n`,
  "utf8",
);

console.log(`Verified app: ${appPath}`);
console.log(`Bundle ID: ${actualBundleId}`);
console.log(`Version: ${actualVersion}`);
console.log(`Icon: ${bundledIconName} (CodexDesk artwork verified)`);
console.log(
  "Legal resources: privacy, npm, Electron, and Chromium notices verified",
);
if (publicReleaseBuild) {
  console.log(`Stable update feed: ${process.env.CODEXDESK_UPDATE_FEED_URL}`);
}
console.log(`Verified ZIP: ${zipPath}`);
console.log(`SHA-256: ${checksumHash}`);
console.log(
  "Notarization was not checked; notarize only after release approval.",
);
