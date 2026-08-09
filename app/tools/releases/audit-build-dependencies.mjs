import { spawnSync } from "node:child_process";

// These six names are one development-server-only advisory chain rooted in
// nanoid. The registry currently reports nanoid <3.3.17 as affected but does
// not publish 3.3.17. Keep the exception exact so a new high/critical advisory
// anywhere else in the build graph fails release verification.
const acceptedBuildOnlyChain = new Set([
  "@vitejs/plugin-react",
  "@vitest/mocker",
  "nanoid",
  "postcss",
  "vite",
  "vitest",
]);

const audit = spawnSync("npm", ["audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr);
  throw new Error("npm audit did not return valid JSON");
}

if (report.error) {
  throw new Error(report.error.summary ?? "npm audit failed");
}

const vulnerabilities = report.vulnerabilities ?? {};
const severe = Object.entries(vulnerabilities).filter(([, issue]) =>
  ["high", "critical"].includes(issue.severity),
);
const unexpected = severe.filter(
  ([name, issue]) =>
    issue.severity === "critical" || !acceptedBuildOnlyChain.has(name),
);

if (unexpected.length > 0) {
  for (const [name, issue] of unexpected) {
    console.error(`${name}: ${issue.severity} (${issue.range})`);
  }
  throw new Error("Unaccepted high or critical build dependency advisory");
}

const accepted = severe.map(([name]) => name).sort();
console.log(
  accepted.length === 0
    ? "Build dependency audit is clean."
    : `Accepted build-only nanoid advisory chain: ${accepted.join(", ")}`,
);
