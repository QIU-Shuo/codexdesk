import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { releaseArtifactNames } from "../releases/artifact-names.mjs";

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
const signingIdentity = process.env.CODEXDESK_MAC_SIGN_IDENTITY?.trim();
const productName = canaryBuild ? "CodexDesk-canary" : "CodexDesk";
const appName = `${productName}.app`;
const appPath = path.join(
  appRoot,
  "out",
  `${productName}-darwin-${arch}`,
  appName,
);
const { dmg: dmgName, zip: zipName } = releaseArtifactNames({
  productName,
  arch,
  version: packageJson.version,
});
const zipDir = path.join(
  appRoot,
  "out",
  "make",
  "zip",
  "darwin",
  arch,
);
const dmgDir = path.join(appRoot, "out", "make", "dmg", "darwin", arch);
const updateZip = path.join(zipDir, zipName);
const installerDmg = path.join(dmgDir, dmgName);

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

async function submitForNotarization(inputPath, label) {
  const submission = await run("xcrun", [
    "notarytool",
    "submit",
    inputPath,
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
      `${label} notarization ${result.status || "failed"}; submission ${result.id || "unknown"}`,
    );
  }
  return result;
}

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

  const appSubmission = await submitForNotarization(
    submissionZip,
    "Application",
  );

  await run("xcrun", ["stapler", "staple", appPath]);
  await run("xcrun", ["stapler", "validate", appPath]);
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);

  await mkdir(zipDir, { recursive: true });
  const notarizedZip = path.join(zipDir, `.${zipName}.notarized`);
  await run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    notarizedZip,
  ]);
  await rename(notarizedZip, updateZip);

  const dmgRoot = path.join(workDir, "dmg-root");
  await mkdir(dmgRoot);
  await run("ditto", [appPath, path.join(dmgRoot, appName)]);
  await symlink("/Applications", path.join(dmgRoot, "Applications"));
  await mkdir(dmgDir, { recursive: true });
  const unsignedDmg = path.join(workDir, dmgName);
  await run("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    dmgRoot,
    "-ov",
    "-format",
    "UDZO",
    unsignedDmg,
  ]);
  if (!signingIdentity) {
    throw new Error(
      "Set CODEXDESK_MAC_SIGN_IDENTITY before notarizing the installer DMG.",
    );
  }
  await run("codesign", [
    "--force",
    "--sign",
    signingIdentity,
    "--timestamp",
    unsignedDmg,
  ]);
  const dmgSubmission = await submitForNotarization(unsignedDmg, "DMG");
  await run("xcrun", ["stapler", "staple", unsignedDmg]);
  await run("xcrun", ["stapler", "validate", unsignedDmg]);
  await run("hdiutil", ["verify", unsignedDmg]);
  await rename(unsignedDmg, installerDmg);

  console.log(`Application notarization accepted: ${appSubmission.id}`);
  console.log(`DMG notarization accepted: ${dmgSubmission.id}`);
  console.log(`Stapled app: ${appPath}`);
  console.log(`Notarized update ZIP: ${updateZip}`);
  console.log(`Notarized installer DMG: ${installerDmg}`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
