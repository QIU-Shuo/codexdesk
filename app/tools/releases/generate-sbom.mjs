import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(
  await readFile(path.join(appRoot, "package.json"), "utf8"),
);
const lock = JSON.parse(
  await readFile(path.join(appRoot, "package-lock.json"), "utf8"),
);
const result = spawnSync(
  "npm",
  ["sbom", "--omit=dev", "--sbom-format=spdx", "--json"],
  {
    cwd: appRoot,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  throw new Error("npm could not generate the production SPDX SBOM.");
}

const sbom = JSON.parse(result.stdout);
const rootId = `SPDXRef-Package-codexdesk-${packageJson.version}`;
const rootPackage = sbom.packages.find((entry) => entry.SPDXID === rootId);
if (rootPackage) rootPackage.primaryPackagePurpose = "APPLICATION";

// Electron is intentionally a devDependency for source installs, but its runtime
// is the executable shell distributed in every packaged application.
const electron = lock.packages["node_modules/electron"];
if (!electron) throw new Error("Electron is missing from package-lock.json.");
const electronId = `SPDXRef-Package-electron-${electron.version}`;
sbom.packages.push({
  name: "electron",
  SPDXID: electronId,
  versionInfo: electron.version,
  packageFileName: "Electron.app",
  primaryPackagePurpose: "FRAMEWORK",
  downloadLocation: electron.resolved || "NOASSERTION",
  filesAnalyzed: false,
  licenseDeclared: electron.license || "NOASSERTION",
  comment:
    "Electron is installed as a build dependency but its runtime is distributed with CodexDesk.",
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:npm/electron@${electron.version}`,
    },
  ],
});
sbom.relationships.push({
  spdxElementId: rootId,
  relatedSpdxElement: electronId,
  relationshipType: "DEPENDS_ON",
});

const outputDirectory = path.join(appRoot, "out", "release");
await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(
  outputDirectory,
  `CodexDesk-${packageJson.version}-sbom.spdx.json`,
);
await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
console.log(`Wrote SPDX SBOM: ${outputPath}`);
