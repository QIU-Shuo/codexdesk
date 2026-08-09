import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appRoot = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(
  await readFile(path.join(appRoot, "package.json"), "utf8"),
);
const canaryBuild = process.env.CODEXDESK_BUILD_CHANNEL === "canary";
const arch = process.env.CODEXDESK_UPDATE_ARCH || process.arch;
const profile =
  process.env.CODEXDESK_NOTARY_KEYCHAIN_PROFILE || "CodexDesk-notary";
const apiKeyPath = process.env.CODEXDESK_NOTARY_KEY_PATH;
const apiKeyId = process.env.CODEXDESK_NOTARY_KEY_ID;
const apiIssuer = process.env.CODEXDESK_NOTARY_ISSUER;
const productName = canaryBuild ? "CodexDesk-canary" : "CodexDesk";
const appName = `${productName}.app`;
const appPath = path.join(
  appRoot,
  "out",
  `${productName}-darwin-${arch}`,
  appName,
);
const zipName = `${productName}-darwin-${arch}-${packageJson.version}.zip`;
const makeDir = path.join(
  appRoot,
  "out",
  "make",
  "zip",
  "darwin",
  arch,
);
const updateZip = path.join(makeDir, zipName);

async function run(command, args) {
  const result = await execFileAsync(command, args, {
    cwd: appRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function notaryCredentials() {
  const apiCredentialCount = [apiKeyPath, apiKeyId, apiIssuer].filter(
    Boolean,
  ).length;
  if (apiCredentialCount === 3) {
    return [
      "--key",
      apiKeyPath,
      "--key-id",
      apiKeyId,
      "--issuer",
      apiIssuer,
    ];
  }
  if (apiCredentialCount !== 0) {
    throw new Error(
      "Set CODEXDESK_NOTARY_KEY_PATH, CODEXDESK_NOTARY_KEY_ID, and CODEXDESK_NOTARY_ISSUER together.",
    );
  }
  return ["--keychain-profile", profile];
}

const credentials = notaryCredentials();
const workDir = await mkdtemp(path.join(tmpdir(), "codexdesk-notary-"));
const submissionZip = path.join(workDir, zipName);

try {
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
  await run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    submissionZip,
  ]);

  const submission = await run("xcrun", [
    "notarytool",
    "submit",
    submissionZip,
    ...credentials,
    "--wait",
    "--output-format",
    "json",
  ]);
  const result = JSON.parse(submission.stdout);
  if (result.status !== "Accepted") {
    if (result.id) {
      await run("xcrun", [
        "notarytool",
        "log",
        result.id,
        ...credentials,
      ]).catch(() => undefined);
    }
    throw new Error(
      `Notarization ${result.status || "failed"}; submission ${result.id || "unknown"}`,
    );
  }

  await run("xcrun", ["stapler", "staple", appPath]);
  await run("xcrun", ["stapler", "validate", appPath]);
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);

  await mkdir(makeDir, { recursive: true });
  const notarizedZip = path.join(makeDir, `.${zipName}.notarized`);
  await run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    notarizedZip,
  ]);
  await rename(notarizedZip, updateZip);

  console.log(`Notarization accepted: ${result.id}`);
  console.log(`Stapled app: ${appPath}`);
  console.log(`Notarized update ZIP: ${updateZip}`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
