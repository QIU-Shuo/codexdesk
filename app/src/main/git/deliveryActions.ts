import path from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execRunner } from "./delivery";
import type { Runner } from "./delivery";
import {
  deliveryIssue,
  type DeliveryIssue,
  type DeliveryStage,
} from "../../application/domains/delivery/DeliveryIssue";

/**
 * The mutating half of the delivery flow (plan §7.2): commit, push, open PR.
 *
 * Separate from `delivery.ts` on purpose. That file only *observes* — it is
 * safe to call at any time, including on a timer. Everything here changes
 * state in the user's repository or on their GitHub account, and each function
 * is written so that running it twice is not worse than running it once.
 *
 * Invariants taken directly from §7.2, each with a test:
 *
 * - **Never commit unrelated pre-existing changes.** Commits stage an explicit
 *   pathspec, never `-a` and never a bare `git add .`. A user with something
 *   already staged from their own work must not find it in our commit.
 * - **No force-push, no auto-merge, no history rewriting.** Push is plain and
 *   fast-forward-only; a rejection is reported, not "fixed".
 * - **Idempotent.** Commit refuses when there is nothing to commit rather than
 *   creating an empty one; push is a no-op when already up to date; PR
 *   creation returns the existing PR instead of opening a second.
 */

export type StepResult<T> =
  { ok: true; value: T } | { ok: false; issue: DeliveryIssue };

function fail(
  stage: DeliveryStage,
  cause: DeliveryIssue["cause"],
  recovery: DeliveryIssue["recovery"],
  detail: string,
): { ok: false; issue: DeliveryIssue } {
  return { ok: false, issue: deliveryIssue(stage, cause, recovery, detail) };
}

/**
 * Commit the listed files.
 *
 * `files` comes from `prepare`, which lists the worktree's own changes. They
 * are staged explicitly so that anything the user had staged for their own
 * reasons stays out of the commit.
 */
export async function commit(
  worktreePath: string,
  files: string[],
  message: string,
  runner: Runner = execRunner,
): Promise<StepResult<{ sha: string }>> {
  const git = (args: string[]) => runner("git", args, worktreePath);

  if (files.length === 0) {
    return fail(
      "commit",
      "noChanges",
      "unavailable",
      "There are no changes in this worktree to commit.",
    );
  }
  if (!message.trim()) {
    return fail(
      "commit",
      "unknown",
      "userAction",
      "A commit message is required.",
    );
  }

  // What was already staged before we touched anything. If the commit fails,
  // the index has to go back to exactly this — see the restore below.
  const before = await git(["diff", "--cached", "--name-only"]);
  const previouslyStaged = new Set(
    before.code === 0 ? before.stdout.split("\n").filter(Boolean) : [],
  );

  // `--` separates pathspecs from revisions, so a file named like a branch
  // cannot be misread as one.
  const add = await git(["add", "--", ...files]);
  if (add.code !== 0) {
    return fail(
      "commit",
      "unknown",
      "retry",
      add.stderr.trim() || "git add failed.",
    );
  }

  /**
   * Put the index back the way we found it.
   *
   * `git add` stages the files, and a *failed* commit leaves them staged.
   * Without this, a rejected pre-commit hook left the agent's work sitting in
   * the index, and every later read of `git status` reported those files as
   * already staged — which is exactly the state the old ownership heuristic
   * misread. Restoring makes a failed commit a no-op, so retrying is possible.
   */
  const restoreIndex = async () => {
    const toUnstage = files.filter((f) => !previouslyStaged.has(f));
    if (toUnstage.length === 0) return;
    // `reset -q -- <paths>` unstages without touching the working tree.
    await git(["reset", "-q", "--", ...toUnstage]);
  };

  // Commit only what we just staged. `--only` with an explicit pathspec is the
  // difference between "our change" and "everything the user had staged".
  const res = await git(["commit", "--only", "-m", message, "--", ...files]);
  if (res.code !== 0) {
    await restoreIndex();
    const text = `${res.stdout}\n${res.stderr}`;
    if (/nothing to commit|no changes added/i.test(text)) {
      return fail(
        "commit",
        "noChanges",
        "unavailable",
        "There are no changes in this worktree to commit.",
      );
    }
    // A failing pre-commit hook is a distinct, actionable case: the user's own
    // tooling rejected the change, and its output is the useful part.
    //
    // Detection has to be **structural**, not textual. Verified against a real
    // repo: git prints only the hook's own output and exits 1 — no "hook" or
    // "pre-commit" appears anywhere, so matching on those words silently
    // misclassified every real hook failure as a generic git error.
    if (await hasHook(worktreePath, "pre-commit", runner)) {
      return fail(
        "commit",
        "hook",
        "userAction",
        firstLines(text) || "A git hook rejected the commit.",
      );
    }
    return fail(
      "commit",
      "unknown",
      "retry",
      firstLines(text) || "git commit failed.",
    );
  }

  const head = await git(["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    return fail(
      "commit",
      "unknown",
      "retry",
      "Committed, but could not read the new commit.",
    );
  }
  return { ok: true, value: { sha: head.stdout.trim() } };
}

/**
 * Push the branch, setting upstream on first push.
 *
 * Never forced. A non-fast-forward means the remote has commits we do not, and
 * resolving that is the user's decision — §7.2 forbids doing it for them.
 */
export async function push(
  worktreePath: string,
  branch: string,
  remote: string | null,
  hasUpstream: boolean,
  runner: Runner = execRunner,
): Promise<StepResult<{ upstream: string }>> {
  const git = (args: string[]) => runner("git", args, worktreePath);

  if (!remote) {
    return fail(
      "push",
      "missingRemote",
      "userAction",
      "This repository has no remote, so there is nowhere to push. " +
        "Add one with `git remote add origin <url>`.",
    );
  }

  const args = hasUpstream
    ? ["push", remote, branch]
    : ["push", "--set-upstream", remote, branch];
  const res = await git(args);

  if (res.code !== 0) {
    const text = `${res.stdout}\n${res.stderr}`;
    if (/non-fast-forward|fetch first|rejected/i.test(text)) {
      return fail(
        "push",
        "rejected",
        "userAction",
        "The remote has commits this branch does not. Pull or rebase before " +
          "pushing — CodexDesk will not force-push.",
      );
    }
    if (
      /authentication|permission denied|could not read username|403/i.test(text)
    ) {
      return fail(
        "push",
        "authentication",
        "userAction",
        "Git rejected the push as unauthenticated. Check your credentials " +
          "for this remote.",
      );
    }
    if (await hasHook(worktreePath, "pre-push", runner)) {
      return fail(
        "push",
        "hook",
        "userAction",
        firstLines(text) || "A pre-push hook rejected the push.",
      );
    }
    return fail(
      "push",
      "unknown",
      "retry",
      firstLines(text) || "git push failed.",
    );
  }

  return { ok: true, value: { upstream: `${remote}/${branch}` } };
}

/**
 * Create a **draft** PR, or return the one that already exists.
 *
 * Draft is deliberate: agent-produced work should land in front of a human
 * for review, not as a ready-to-merge pull request.
 */
export async function createDraftPr(
  worktreePath: string,
  opts: { title: string; body: string; baseBranch: string | null },
  runner: Runner = execRunner,
): Promise<StepResult<{ url: string; existed: boolean }>> {
  const gh = (args: string[]) => runner("gh", args, worktreePath);

  const version = await gh(["--version"]);
  if (version.code === 127) {
    return fail(
      "pullRequest",
      "missingTool",
      "unavailable",
      "The GitHub CLI (`gh`) is not installed, so CodexDesk cannot open a pull " +
        "request. Install it from cli.github.com.",
    );
  }

  const auth = await gh(["auth", "status"]);
  if (auth.code !== 0) {
    return fail(
      "pullRequest",
      "authentication",
      "userAction",
      "`gh` is installed but not signed in. Run `gh auth login` and retry.",
    );
  }

  // An existing PR must be reused, not duplicated — the idempotence rule.
  const existing = await gh(["pr", "view", "--json", "url"]);
  if (existing.code === 0) {
    const url = readJsonUrl(existing.stdout);
    if (url) return { ok: true, value: { url, existed: true } };
  } else if (/no git remotes|not a git repository/i.test(existing.stderr)) {
    return fail(
      "pullRequest",
      "missingRemote",
      "unavailable",
      "This repository has no GitHub remote, so there is no place to open a " +
        "pull request.",
    );
  }

  const args = [
    "pr",
    "create",
    "--draft",
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];
  if (opts.baseBranch) args.push("--base", opts.baseBranch);
  const res = await gh(args);

  if (res.code !== 0) {
    const text = `${res.stdout}\n${res.stderr}`;
    if (/already exists/i.test(text)) {
      // A race, or a PR opened outside the app between our check and create.
      const again = await gh(["pr", "view", "--json", "url"]);
      const url = again.code === 0 ? readJsonUrl(again.stdout) : null;
      if (url) return { ok: true, value: { url, existed: true } };
    }
    if (/must first push|no upstream|has no upstream/i.test(text)) {
      return fail(
        "pullRequest",
        "missingUpstream",
        "userAction",
        "The branch is not on the remote yet. Push it before opening a pull " +
          "request.",
      );
    }
    return fail(
      "pullRequest",
      "unknown",
      "retry",
      firstLines(text) || "gh pr create failed.",
    );
  }

  // `gh pr create` prints the URL on success.
  const url = firstUrl(res.stdout) ?? firstUrl(res.stderr);
  if (!url) {
    return fail(
      "pullRequest",
      "unknown",
      "retry",
      "The pull request was created but gh did not report its URL.",
    );
  }
  return { ok: true, value: { url, existed: false } };
}

/** Existing PR for the current branch, if any. Used by `prepare`. */
export async function findExistingPr(
  worktreePath: string,
  runner: Runner = execRunner,
): Promise<string | null> {
  const res = await runner("gh", ["pr", "view", "--json", "url"], worktreePath);
  return res.code === 0 ? readJsonUrl(res.stdout) : null;
}

/**
 * Whether an executable hook of this name would run.
 *
 * `git rev-parse --git-path` resolves the hooks directory correctly for
 * worktrees (where `.git` is a file, not a directory) and honours a
 * `core.hooksPath` override — both verified against a real repo.
 */
async function hasHook(
  cwd: string,
  name: string,
  runner: Runner,
): Promise<boolean> {
  const res = await runner(
    "git",
    ["rev-parse", "--git-path", `hooks/${name}`],
    cwd,
  );
  if (res.code !== 0) return false;
  const rel = res.stdout.trim();
  if (!rel) return false;
  const full = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
  try {
    await access(full, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readJsonUrl(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { url?: string };
    return parsed.url ?? null;
  } catch {
    return null;
  }
}

function firstUrl(text: string): string | null {
  const m = /https:\/\/\S+/.exec(text);
  return m ? m[0].trim() : null;
}

/** Keep error text useful but bounded — a 200-line hook dump is not a message. */
function firstLines(text: string, max = 4): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max)
    .join("\n");
}
