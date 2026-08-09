import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changedFiles } from "./sessionDiff";
import {
  nextDeliveryStage,
  type ChangedPath,
  type DeliveryState,
} from "../../application/domains/delivery/DeliveryService";
import { deliveryIssue } from "../../application/domains/delivery/DeliveryIssue";

export type { ChangedPath, DeliveryState };

const run = promisify(execFile);

/**
 * Commit → push → draft PR (plan §7.2).
 *
 * This is **client-side Git and GitHub orchestration, not protocol**. Nothing
 * here talks to app-server; `worktree` and `pull request` appear nowhere in
 * the generated schema.
 *
 * Two properties shape the whole file:
 *
 * **Named blockers, not one disabled button.** A greyed-out control with no
 * reason is not debuggable. Every blocker below carries a human sentence and,
 * where one exists, the action that clears it.
 *
 * **Every step is idempotent.** If commit succeeds and push fails, the retry
 * starts at push — it must not create a second commit. `prepare` is therefore
 * a *observation* of real Git state rather than a memory of what we did, so it
 * survives a restart (the §7.2 exit criterion) without a journal that could
 * disagree with the repository.
 */

export type Runner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Real subprocess runner. Never throws on non-zero — the code is the signal. */
export const execRunner: Runner = async (cmd, args, cwd) => {
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      // A missing binary has no exit code; treat it as a hard failure.
      code: typeof e.code === "number" ? e.code : 127,
    };
  }
};

/**
 * Observe the repository and decide which step is next.
 *
 * Deliberately stateless: it reads Git rather than remembering what we did.
 * That is what makes the flow resume correctly after a restart — a journal
 * could disagree with the repository, and the repository is the truth.
 */
export async function prepare(
  worktreePath: string,
  baseSha: string,
  runner: Runner = execRunner,
): Promise<DeliveryState> {
  const git = (args: string[]) => runner("git", args, worktreePath);

  const rootRes = await git(["rev-parse", "--show-toplevel"]);
  if (rootRes.code !== 0) {
    return {
      ...empty(worktreePath),
      issue: deliveryIssue(
        "inspect",
        "notRepository",
        "unavailable",
        `${worktreePath} is not inside a git repository.`,
      ),
    };
  }
  const repoRoot = rootRes.stdout.trim();

  const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
  const state: DeliveryState = { ...empty(repoRoot), branch };

  if (!branch || branch === "HEAD") {
    state.issue = deliveryIssue(
      "inspect",
      "unsafeBranch",
      "chooseBranch",
      "This worktree has a detached HEAD, so there is no branch to push. " +
        "Create a branch before delivering.",
    );
    return state;
  }

  state.defaultBranch = await readDefaultBranch(git);
  // Committing onto the user's main branch from an agent worktree is exactly
  // the accident the worktree isolation exists to prevent.
  if (state.defaultBranch && branch === state.defaultBranch) {
    state.issue = deliveryIssue(
      "inspect",
      "unsafeBranch",
      "chooseBranch",
      `This worktree is on ${branch}, the default branch. Deliver from a ` +
        "feature branch so the change can be reviewed.",
    );
    return state;
  }

  const remoteRes = await git(["remote"]);
  const remotes = remoteRes.stdout
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  state.remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);

  const upstreamRes = await git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  state.upstream = upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null;

  // What is not yet committed. `--porcelain` is stable across git versions in
  // a way the human-readable output is not.
  //
  // **The index column matters.** Porcelain reports two status characters:
  // index state, then worktree state. A file the *user* staged for their own
  // reasons shows as `A ` or `M ` — staged, clean in the worktree — and
  // including it here would put it in our commit, which §7.2 forbids. Found
  // by driving the real app: the pane said "Commit 3 files", listed three,
  // and committed four. `commit()` honours the list it is given, so the bug
  // was entirely in how the list is built, and a unit test that passes an
  // explicit list could never catch it.
  const statusRes = await git(["status", "--porcelain"]);
  state.changes = describeChanges(statusRes.stdout);
  // Everything changed is a candidate. What actually goes into the commit is
  // the user's choice, made in the commit form — see `describeChanges`.
  state.files = state.changes.map((c) => c.path);

  const counts = await countAgainst(worktreePath, baseSha);
  state.additions = counts.additions;
  state.deletions = counts.deletions;

  // Has anything already been committed on this branch beyond the base?
  const aheadRes = await git(["rev-list", "--count", `${baseSha}..HEAD`]);
  const ahead = aheadRes.code === 0 ? Number(aheadRes.stdout.trim() || 0) : 0;
  if (ahead > 0) {
    const headRes = await git(["rev-parse", "HEAD"]);
    state.committedSha = headRes.code === 0 ? headRes.stdout.trim() : null;
  }

  // Is the branch already pushed and up to date with its upstream?
  if (state.upstream) {
    const cmp = await git([
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...@{upstream}`,
    ]);
    if (cmp.code === 0) {
      const [aheadOfUpstream = "0"] = cmp.stdout.trim().split(/\s+/);
      state.pushed = Number(aheadOfUpstream) === 0;
    }
  }

  state.next = nextDeliveryStage(state);
  return state;
}

function empty(repoRoot: string): DeliveryState {
  return {
    next: "inspect",
    repoRoot,
    branch: null,
    defaultBranch: null,
    remote: null,
    upstream: null,
    files: [],
    changes: [],
    additions: 0,
    deletions: 0,
    committedSha: null,
    pushed: false,
    prUrl: null,
    issue: null,
  };
}

/**
 * Split porcelain output into work we may commit and work the user staged.
 *
 * Porcelain gives `XY path`, where `X` is the index state and `Y` the worktree
 * state. The distinction we need:
 *
 * - `X` is a change *already staged*. If `Y` is clean, the user staged that
 *   file deliberately and nothing since has touched it — it is theirs.
 * - `Y` is an unstaged worktree change, which is what the agent produces, and
 *   `??` is an untracked file it created.
 *
 * A file with both set (`MM`) was staged by the user *and* modified after, so
 * committing the current content would include their staged version too. It
 * goes on their side, because silently folding in something they staged is
 * precisely the failure §7.2 names.
 */
/**
 * Describe every changed path, without guessing who made the change.
 *
 * **This replaced a classifier**, and the reason is worth keeping. The previous
 * version split porcelain into "ours" and "theirs" by reading the index column:
 * a staged file was assumed to be the user's own work and excluded from the
 * commit. That inference was wrong in a way nothing recovered from — a failed
 * pre-commit hook leaves the files we staged still staged, so the retry
 * reclassified the agent's work as the user's and offered nothing to commit.
 *
 * Reporting every changed path and letting the user choose removes the whole
 * failure mode rather than inferring ownership from index state.
 */
export function describeChanges(porcelain: string): ChangedPath[] {
  const out: ChangedPath[] = [];

  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const raw = line.slice(3);
    // Renames read "old -> new"; the new path is the one to act on.
    const path = (
      raw.includes(" -> ") ? (raw.split(" -> ")[1] ?? raw) : raw
    ).replace(/^"|"$/g, "");
    if (!path) continue;

    out.push({
      path,
      untracked: index === "?" && worktree === "?",
      staged: index !== " " && index !== "?",
      unstaged: worktree !== " " && worktree !== "?",
    });
  }

  return out;
}

async function readDefaultBranch(
  git: (args: string[]) => ReturnType<Runner>,
): Promise<string | null> {
  const sym = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0) {
    return sym.stdout.trim().replace("refs/remotes/origin/", "") || null;
  }
  for (const name of ["main", "master"]) {
    const res = await git(["rev-parse", "--verify", name]);
    if (res.code === 0) return name;
  }
  return null;
}

/**
 * Additions and deletions against the base, **including untracked files**.
 *
 * Delegates to `changedFiles`, which stages into a scratch `GIT_INDEX_FILE`.
 * A plain `git diff --numstat` omits untracked files entirely, so a new
 * eight-line file was summarized as `+0 −0` while the changes pane — which
 * already used the scratch index — showed `+8`. Two implementations of "what
 * changed" that disagree is worse than either being wrong, so there is now
 * one.
 */
async function countAgainst(
  worktreePath: string,
  baseSha: string,
): Promise<{ additions: number; deletions: number }> {
  const files = await changedFiles(worktreePath, baseSha);
  return {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}
