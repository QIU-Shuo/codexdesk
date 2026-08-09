import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const run = promisify(execFile);

/**
 * Git worktree orchestration (plan §6, 3.4).
 *
 * **None of this is in the protocol** — `worktree` appears nowhere in the
 * generated schema. It is entirely client-side git, and it is what makes
 * `workspace-write` safe: agent edits land in an isolated checkout rather
 * than the user's working tree.
 *
 * The safety rule that shapes this file: **never silently fall back to the
 * user's checkout.** If worktree setup fails, the caller is told and the
 * thread does not start there. A silent fallback would violate the model the
 * whole sandbox posture rests on.
 */
export type GitInfo = {
  root: string;
  branch: string | null;
  defaultBranch: string | null;
  headSha: string | null;
};

export type GitBranchInfo = {
  root: string;
  currentBranch: string | null;
  defaultBranch: string | null;
  branches: string[];
  dirtyCount: number;
};

export type WorktreeResult =
  | { ok: true; path: string; branch: string; baseSha: string }
  | { ok: false; reason: WorktreeFailure; detail: string };

/** Specific failure reasons keep recovery actions precise. */
export type WorktreeFailure =
  | "not-a-repo"
  | "no-commits"
  | "branch-exists"
  | "worktree-exists"
  | "git-failed";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    let branch: string | null = null;
    let headSha: string | null = null;
    try {
      branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      headSha = await git(root, ["rev-parse", "HEAD"]);
    } catch {
      // A repo with no commits has no HEAD. Not fatal for reads.
    }
    return { root, branch, defaultBranch: await defaultBranch(root), headSha };
  } catch {
    return null;
  }
}

/**
 * Return the primary checkout that owns a Git working directory.
 *
 * `rev-parse --show-toplevel` returns the linked checkout itself when `cwd`
 * is a worktree. That is useful for running commands, but wrong for sidebar
 * project attribution: a managed worktree should stay under the project it
 * came from. `git worktree list --porcelain` is rooted at the common Git
 * directory and lists the primary checkout first, so it answers the latter
 * question for both ordinary repositories and linked worktrees.
 */
export async function readGitProjectRoot(cwd: string): Promise<string | null> {
  try {
    const worktrees = await git(cwd, ["worktree", "list", "--porcelain"]);
    const first = worktrees
      .split("\n")
      .find((line) => line.startsWith("worktree "));
    if (first) return first.slice("worktree ".length).trim() || null;
  } catch {
    // Older or unusual Git layouts may not expose the worktree inventory.
    // Fall back to the current checkout rather than losing all attribution.
  }
  return (await readGitInfo(cwd))?.root ?? null;
}

/** Composer-facing branch inventory. Local branches only: selecting one is a
 * local starting point, not an implicit fetch or remote mutation. */
export async function readGitBranches(
  cwd: string,
): Promise<GitBranchInfo | null> {
  const info = await readGitInfo(cwd);
  if (!info) return null;
  try {
    const [rawBranches, rawStatus] = await Promise.all([
      git(info.root, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ]),
      git(info.root, ["status", "--porcelain"]),
    ]);
    const branches = rawBranches
      .split("\n")
      .map((branch) => branch.trim())
      .filter(Boolean);
    return {
      root: info.root,
      currentBranch: info.branch,
      defaultBranch: info.defaultBranch,
      branches,
      dirtyCount: rawStatus ? rawStatus.split("\n").length : 0,
    };
  } catch {
    return {
      root: info.root,
      currentBranch: info.branch,
      defaultBranch: info.defaultBranch,
      branches: [],
      dirtyCount: 0,
    };
  }
}

/** Best-effort: origin's HEAD, then common names, then current branch. */
async function defaultBranch(root: string): Promise<string | null> {
  try {
    const ref = await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.replace("refs/remotes/origin/", "") || null;
  } catch {
    for (const name of ["main", "master"]) {
      try {
        await git(root, ["rev-parse", "--verify", name]);
        return name;
      } catch {
        // try the next candidate
      }
    }
    try {
      return await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      return null;
    }
  }
}

/**
 * Create a readable, namespaced branch without accepting Git syntax from
 * display text. The random suffix is a path segment so uniqueness remains
 * visible even when a long title is shortened.
 */
export function worktreeBranchName(label: string, suffix: string): string {
  const words = label.match(/[A-Za-z0-9]+/g) ?? [];
  const readable = words
    .slice(0, 6)
    .map((word) => word.toLocaleLowerCase("en-US"))
    .join("_")
    .substring(0, 28);
  const safeSuffix = [...suffix]
    .filter((character) => /[A-Za-z0-9]/.test(character))
    .join("")
    .substring(0, 12);
  return `codexdesk/work/${safeSuffix || "local"}/${readable || "task"}`;
}

/**
 * Create a worktree for a thread, branched from the current HEAD.
 *
 * Returns the base SHA so a later diff can be computed against the exact
 * commit the thread started from — §7.1 needs this, and recording it at
 * creation is the only moment it is unambiguous.
 */
export async function createWorktree(
  repoCwd: string,
  label: string,
  suffix: string,
  containerDir: string,
  baseBranch?: string,
): Promise<WorktreeResult> {
  const info = await readGitInfo(repoCwd);
  if (!info) {
    return {
      ok: false,
      reason: "not-a-repo",
      detail: `${repoCwd} is not inside a git repository.`,
    };
  }
  if (!info.headSha) {
    return {
      ok: false,
      reason: "no-commits",
      detail:
        "This repository has no commits yet. Make an initial commit before " +
        "running a thread in a worktree.",
    };
  }

  let baseSha = info.headSha;
  if (baseBranch) {
    try {
      // Validate as a branch name, then resolve an explicit refs/heads path.
      // The renderer is not a trust boundary; never pass an unchecked value
      // where Git could interpret it as an option or arbitrary revision.
      await git(info.root, ["check-ref-format", "--branch", baseBranch]);
      baseSha = await git(info.root, [
        "rev-parse",
        "--verify",
        `refs/heads/${baseBranch}^{commit}`,
      ]);
    } catch {
      return {
        ok: false,
        reason: "git-failed",
        detail: `Branch ${baseBranch} does not exist in this repository.`,
      };
    }
  }

  const branch = worktreeBranchName(label, suffix);
  const target = path.join(containerDir, `${suffix}`);

  // Git creates the worktree directory itself but not an absent parent.
  // A first-ever worktree must not fail merely because userData/worktrees has
  // not been materialized by an earlier thread.
  mkdirSync(containerDir, { recursive: true });

  if (existsSync(target)) {
    return {
      ok: false,
      reason: "worktree-exists",
      detail: `${target} already exists.`,
    };
  }

  try {
    await git(info.root, ["rev-parse", "--verify", branch]);
    return {
      ok: false,
      reason: "branch-exists",
      detail: `Branch ${branch} already exists.`,
    };
  } catch {
    // Expected: the branch should not exist yet.
  }

  try {
    await git(info.root, ["worktree", "add", "-b", branch, target, baseSha]);
  } catch (err) {
    return {
      ok: false,
      reason: "git-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, path: target, branch, baseSha };
}

/**
 * Remove a worktree. Refuses when it holds uncommitted work unless forced —
 * the agent's output is the entire point of the isolation, so discarding it
 * silently would be worse than leaving a stale directory behind.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force = false,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    if (!force) {
      const dirty = await git(worktreePath, ["status", "--porcelain"]);
      if (dirty) {
        return {
          ok: false,
          detail: "Worktree has uncommitted changes; not removing.",
        };
      }
    }
    await git(repoRoot, [
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      worktreePath,
    ]);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Unified diff of the worktree against the commit it was created from. */
export async function diffAgainstBase(
  worktreePath: string,
  baseSha: string,
): Promise<string> {
  try {
    // Include untracked files: an agent that creates a new file has done
    // work the user needs to see.
    const tracked = await git(worktreePath, ["diff", baseSha]);
    const untracked = await git(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    if (!untracked) return tracked;
    const parts = [tracked];
    for (const file of untracked.split("\n").filter(Boolean)) {
      try {
        parts.push(
          await git(worktreePath, [
            "diff",
            "--no-index",
            "/dev/null",
            file,
          ]).catch((e: { stdout?: string }) => e.stdout ?? ""),
        );
      } catch {
        // A binary or unreadable file should not break the whole diff.
      }
    }
    return parts.filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

export async function listWorktrees(repoRoot: string): Promise<string[]> {
  try {
    const out = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  } catch {
    return [];
  }
}
