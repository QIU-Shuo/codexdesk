import { execFile } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { PreflightState } from "../shared/ipc";

const run = promisify(execFile);

/**
 * Minimum CLI version validated against our committed generated types
 * (plan §5 step 0.0, §9.7). Bump this in the same change that regenerates
 * `src/protocol/generated` — the two are one workflow, not two.
 */
export const MINIMUM_CODEX_VERSION = "0.144.4";

/** The version the committed bindings were generated from. Anything newer
 * still works, but is untested against these types. */
export const GENERATED_FROM_VERSION = "0.144.4";

/**
 * GUI launches on macOS do not inherit the user's shell PATH. Squirrel's
 * post-update relaunch is similarly minimal, so include the conventional CLI
 * install locations before starting Codex or an integrated terminal.
 */
export function resolveExecutableSearchPath(input: {
  currentPath: string | undefined;
  platform: NodeJS.Platform;
  homeDir: string;
}): string {
  const delimiter = input.platform === "win32" ? ";" : ":";
  const entries = (input.currentPath || "")
    .split(delimiter)
    .filter(Boolean);
  if (input.platform === "darwin") {
    entries.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/opt/local/bin",
      path.join(input.homeDir, ".local", "bin"),
    );
  }
  return [...new Set(entries)].join(delimiter);
}

/** Compare dotted numeric versions. Pre-release suffixes are compared by
 * presence only: `0.143.0-alpha` sorts before `0.143.0`. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return 0;
}

/** `codex --version` prints e.g. `codex-cli 0.144.4`. */
export function parseVersion(stdout: string): string | null {
  const m = stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return m?.[1] ?? null;
}

export async function preflight(): Promise<PreflightState> {
  process.env.PATH = resolveExecutableSearchPath({
    currentPath: process.env.PATH,
    platform: process.platform,
    homeDir: homedir(),
  });

  let stdout: string;
  try {
    ({ stdout } = await run("codex", ["--version"]));
  } catch (err) {
    return {
      kind: "cliMissing",
      detail:
        "`codex` was not found on PATH. Install it with `brew install codex`, " +
        `then restart. (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const version = parseVersion(stdout);
  if (!version) {
    return { kind: "cliMissing", detail: `unrecognized output: ${stdout}` };
  }

  if (compareVersions(version, MINIMUM_CODEX_VERSION) < 0) {
    return { kind: "cliTooOld", found: version, minimum: MINIMUM_CODEX_VERSION };
  }

  const warning =
    compareVersions(version, GENERATED_FROM_VERSION) > 0
      ? `codex ${version} is newer than the ${GENERATED_FROM_VERSION} these ` +
        "protocol bindings were generated from. Run `npm run protocol:generate`."
      : null;

  return { kind: "ready", version, warning };
}
