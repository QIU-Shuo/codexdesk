import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const LEGACY_DEBT_LIMIT = 37;
const legacyDebtEdges = new Set([
  "src/main/orchestrator.ts -> ../protocol/generated/v2/Thread",
  "src/main/orchestrator.ts -> ../protocol/generated/v2/ApprovalsReviewer",
  "src/main/orchestrator.ts -> ../protocol/generated/v2/LoginAccountParams",
  "src/main/orchestrator.ts -> ../protocol/generated/v2/LoginAccountResponse",
  "src/main/orchestrator.ts -> ../protocol/generated/v2/UserInput",
  "src/main/orchestrator.ts -> ../protocol/generated/ReasoningEffort",
  "src/renderer/main_window/ItemView.tsx -> ../../protocol/generated/v2/ThreadItem",
  "src/renderer/main_window/ItemView.tsx -> ../../protocol/generated/v2/UserInput",
  "src/renderer/main_window/ItemView.tsx -> ../../protocol/generated/v2/CommandAction",
  "src/renderer/main_window/ModelPicker.tsx -> ../../protocol/generated/ReasoningEffort",
  "src/renderer/main_window/RequestCard.tsx -> ../../protocol/generated/v2/CommandExecutionApprovalDecision",
  "src/renderer/main_window/RequestCard.tsx -> ../../protocol/generated/v2/FileChangeApprovalDecision",
  "src/renderer/main_window/RequestCard.tsx -> ../../protocol/generated/v2/FileSystemPath",
  "src/shared/ipc.ts -> ../protocol/generated/v2/ThreadItem",
  "src/shared/ipc.ts -> ../protocol/generated/v2/Turn",
  "src/shared/ipc.ts -> ../protocol/generated/v2/TurnError",
  "src/shared/ipc.ts -> ../protocol/generated/v2/Account",
  "src/shared/ipc.ts -> ../protocol/generated/v2/CommandExecutionRequestApprovalParams",
  "src/shared/ipc.ts -> ../protocol/generated/v2/FileChangeRequestApprovalParams",
  "src/shared/ipc.ts -> ../protocol/generated/v2/PermissionsRequestApprovalParams",
  "src/shared/ipc.ts -> ../protocol/generated/v2/ToolRequestUserInputParams",
  "src/shared/ipc.ts -> ../protocol/generated/v2/McpServerElicitationRequestParams",
  "src/shared/ipc.ts -> ../protocol/generated/v2/CommandExecutionApprovalDecision",
  "src/shared/ipc.ts -> ../protocol/generated/v2/FileChangeApprovalDecision",
  "src/shared/ipc.ts -> ../protocol/generated/v2/PermissionGrantScope",
  "src/shared/ipc.ts -> ../protocol/generated/v2/McpServerElicitationAction",
  "src/shared/ipc.ts -> ../protocol/generated/v2/TurnPlanStep",
  "src/shared/ipc.ts -> ../protocol/generated/v2/ThreadTokenUsage",
  "src/shared/ipc.ts -> ../protocol/generated/v2/RateLimitSnapshot",
  "src/shared/ipc.ts -> ../protocol/generated/v2/GuardianApprovalReview",
  "src/shared/ipc.ts -> ../protocol/generated/v2/GuardianApprovalReviewAction",
  "src/shared/ipc.ts -> ../protocol/generated/FuzzyFileSearchResult",
  "src/shared/ipc.ts -> ../protocol/generated/v2/Model",
  "src/shared/ipc.ts -> ../protocol/generated/v2/PermissionProfileSummary",
  "src/shared/ipc.ts -> ../protocol/generated/v2/ApprovalsReviewer",
  "src/shared/ipc.ts -> ../protocol/generated/v2/ReviewTarget",
  "src/shared/ipc.ts -> ../protocol/generated/ReasoningEffort",
]);

if (legacyDebtEdges.size !== LEGACY_DEBT_LIMIT) {
  throw new Error(
    `Legacy debt configuration has ${legacyDebtEdges.size} edges; ` +
      `update LEGACY_DEBT_LIMIT when intentionally removing an edge.`,
  );
}

const importPatterns = [
  /(?:import|export)\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (absolute.includes(`${path.sep}protocol${path.sep}generated`)) {
        continue;
      }
      files.push(...(await filesUnder(absolute)));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function relative(absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function resolveImport(source, specifier) {
  if (!specifier.startsWith(".")) return null;
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(source), specifier),
  );
}

function layer(file) {
  if (file.startsWith("src/contracts/")) return "contracts";
  if (file.startsWith("src/application/")) return "application";
  if (file.startsWith("src/infrastructure/")) return "infrastructure";
  if (file.startsWith("src/renderer/")) return "renderer";
  if (file.startsWith("src/protocol/")) return "protocol";
  if (file.startsWith("src/main/")) return "legacy-main";
  return "legacy-shared";
}

const errors = [];
const debt = new Set();
for (const absolute of await filesUnder(sourceRoot)) {
  const source = relative(absolute);
  const text = await readFile(absolute, "utf8");
  const specifiers = importPatterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1]),
  );
  for (const specifier of specifiers) {
    const target = resolveImport(source, specifier);
    const sourceLayer = layer(source);
    const targetLayer = target ? layer(target) : null;
    const edge = `${source} -> ${specifier}`;

    if (
      sourceLayer === "contracts" &&
      ((targetLayer && targetLayer !== "contracts") ||
        specifier === "electron" ||
        specifier.startsWith("node:"))
    ) {
      errors.push(`${source}: contracts cannot import ${specifier}`);
    }

    if (
      sourceLayer === "application" &&
      (specifier === "electron" ||
        specifier.startsWith("node:") ||
        ["infrastructure", "renderer", "protocol", "legacy-main"].includes(
          targetLayer,
        ))
    ) {
      errors.push(`${source}: application cannot import ${specifier}`);
    }

    if (sourceLayer === "infrastructure" && targetLayer === "renderer") {
      errors.push(`${source}: infrastructure cannot import ${specifier}`);
    }

    if (
      sourceLayer === "renderer" &&
      ["application", "infrastructure", "legacy-main"].includes(targetLayer)
    ) {
      if (legacyDebtEdges.has(edge)) {
        debt.add(edge);
      } else {
        errors.push(`${source}: renderer cannot import ${specifier}`);
      }
    }

    if (target?.startsWith("src/protocol/generated")) {
      const allowedAdapter =
        source.startsWith("src/infrastructure/app-server/") ||
        source === "src/main/appServer/client.ts";
      if (!allowedAdapter) {
        if (legacyDebtEdges.has(edge)) {
          debt.add(edge);
        } else {
          errors.push(
            `${source}: generated protocol types belong behind an app-server adapter`,
          );
        }
      }
    }
  }
}

for (const edge of legacyDebtEdges) {
  if (!debt.has(edge)) {
    errors.push(
      `stale legacy debt edge: ${edge}; remove it and lower LEGACY_DEBT_LIMIT`,
    );
  }
}

if (debt.size > LEGACY_DEBT_LIMIT) {
  errors.push(
    `legacy debt grew from ${LEGACY_DEBT_LIMIT} to ${debt.size} edges`,
  );
}

if (errors.length > 0) {
  console.error("Architecture boundary violations:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Architecture boundaries pass (${debt.size} exact legacy imports remain).`,
);
