import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseUnifiedDiff, type ParsedDiff } from "./diff";

const run = promisify(execFile);

/**
 * Session-scope diff for the changes pane (plan §7.1).
 *
 * Two scopes matter and they are not the same thing:
 *
 * - **turn** — what one turn changed. `turn/diff/updated` already gives us
 *   this, streamed from app-server.
 * - **session** — everything in the worktree since the thread started, which
 *   is what a user actually reviews before committing. It must come from Git,
 *   **not** from concatenating turn diffs: turns overlap, later turns revert
 *   earlier ones, and edits made in the terminal never appear as turn diffs at
 *   all. §7.1 says this explicitly and it is the whole reason this file exists.
 *
 * The base SHA is passed in rather than recomputed. It is recorded when the
 * worktree is created (`createWorktree` returns it) and persisted, so a later
 * branch move cannot silently change what the user is approving — §7.1 again.
 */

export type DiffScope = "session" | "turn";

export type SessionDiff = {
  scope: DiffScope;
  /** The commit everything is compared against. Echoed back so the UI can
   * show exactly what the review is relative to. */
  baseSha: string;
  parsed: ParsedDiff;
  /** Raw unified text, kept for commit-message generation and for comments
   * that quote it. */
  raw: string;
};

export type GitRunner = (
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

/** Default runner. Exposed so tests can drive the logic without a real repo. */
export const execGit: GitRunner = async (cwd, args, env) => {
  const { stdout } = await run("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
};

/**
 * Complete worktree diff against the base commit, including untracked files.
 *
 * **Why a temporary index.** Untracked files do not appear in `git diff` at
 * all. The obvious fixes are both wrong:
 *
 * - `git diff --no-index /dev/null <file>` per file — N subprocesses, and it
 *   exits non-zero on difference, so the error path has to be swallowed to
 *   read stdout. Fragile, and it loses rename detection across the set.
 * - `git add -N .` — one clean diff, but it **mutates the user's index**.
 *   Verified: the file then shows as `A` in `git status`, which violates
 *   §7.2's "never commit unrelated pre-existing changes" invariant.
 *
 * Pointing `GIT_INDEX_FILE` at a scratch file gives the single-call diff with
 * no effect on the real index — verified against a real repo, the file is
 * still `??` afterwards.
 */
export async function sessionDiff(
  worktreePath: string,
  baseSha: string,
  git: GitRunner = execGit,
): Promise<SessionDiff> {
  const dir = await mkdtemp(path.join(tmpdir(), "codexdesk-idx-"));
  const indexFile = path.join(dir, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    // Seed the scratch index from the base commit, then stage everything in
    // the working tree into it. `--cached` against the base then describes the
    // full change set in one pass, with rename detection intact.
    await git(worktreePath, ["read-tree", baseSha], env);
    await git(worktreePath, ["add", "-A", "."], env);
    const raw = await git(
      worktreePath,
      ["diff", "--cached", "-M", "--find-renames", baseSha],
      env,
    );
    return { scope: "session", baseSha, parsed: parseUnifiedDiff(raw), raw };
  } catch (err) {
    // A diff we cannot compute must not take the pane down with it; the user
    // still needs the rest of the UI. The empty result is distinguishable from
    // "no changes" by the caller only via the error log, which is deliberate:
    // silently showing "no changes" for a broken repo would be worse.
    throw new DiffError(errText(err));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export class DiffError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DiffError";
  }
}

/**
 * Files changed since the base, with status and counts but no hunk bodies.
 *
 * Cheap enough to call on every file-watcher tick; the full diff is only
 * needed when the pane is open on a file.
 */
export async function changedFiles(
  worktreePath: string,
  baseSha: string,
  git: GitRunner = execGit,
): Promise<{ path: string; additions: number; deletions: number }[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "codexdesk-idx-"));
  const indexFile = path.join(dir, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    await git(worktreePath, ["read-tree", baseSha], env);
    await git(worktreePath, ["add", "-A", "."], env);
    const out = await git(
      worktreePath,
      ["diff", "--cached", "--numstat", "-M", baseSha],
      env,
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, ...rest] = line.split("\t");
        return {
          // Binary files report "-" rather than a count.
          additions: add === "-" ? 0 : Number(add ?? 0),
          deletions: del === "-" ? 0 : Number(del ?? 0),
          path: rest.join("\t"),
        };
      })
      .filter((f) => f.path);
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    // execFile errors carry stderr, which is the part worth surfacing.
    const stderr = (err as { stderr?: string }).stderr;
    return stderr ? `${err.message}: ${stderr}`.trim() : err.message;
  }
  return String(err);
}
