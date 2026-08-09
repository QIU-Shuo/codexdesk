import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepare, execRunner, type Runner } from "../src/main/git/delivery";
import { commit, push, createDraftPr } from "../src/main/git/deliveryActions";

const run = promisify(execFile);

/**
 * Git behavior is tested against **real repositories**; GitHub is tested with
 * a fake runner. That split is deliberate: the risky, easy-to-get-wrong part
 * is what git actually does to the index and to history, and no fake would
 * have caught the `--only` pathspec question. Opening real pull requests from
 * a test suite, by contrast, has no upside and touches an account.
 */

let repo: string;
let remote: string;
let base: string;

async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout;
}

async function write(rel: string, body: string, cwd = repo): Promise<void> {
  const full = path.join(cwd, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

beforeEach(async () => {
  // A bare repo to act as `origin`, so push is exercised for real.
  remote = await mkdtemp(path.join(tmpdir(), "codexdesk-remote-"));
  await run("git", ["init", "-q", "--bare", "."], { cwd: remote });

  repo = await mkdtemp(path.join(tmpdir(), "codexdesk-del-"));
  await git(["init", "-q", "-b", "main", "."]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Test"]);
  await write("file.txt", "base\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "base"]);
  await git(["remote", "add", "origin", remote]);
  await git(["push", "-q", "--set-upstream", "origin", "main"]);
  base = (await git(["rev-parse", "HEAD"])).trim();
  // Work happens on a feature branch, as the real flow requires.
  await git(["checkout", "-q", "-b", "codexdesk/feature"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});

describe("prepare", () => {
  it("reports commit as the next step when there is uncommitted work", async () => {
    await write("file.txt", "changed\n");
    const state = await prepare(repo, base);
    expect(state.next).toBe("commit");
    expect(state.files).toContain("file.txt");
    expect(state.issue).toBeNull();
  });

  it("lists untracked files as part of the change set", async () => {
    await write("new.txt", "hello\n");
    const state = await prepare(repo, base);
    expect(state.files).toContain("new.txt");
  });

  it("blocks on the default branch rather than committing onto it", async () => {
    // The exact accident worktree isolation exists to prevent.
    await git(["checkout", "-q", "main"]);
    await write("file.txt", "changed\n");
    const state = await prepare(repo, base);
    expect(state.issue).toMatchObject({
      stage: "inspect",
      cause: "unsafeBranch",
      recovery: "chooseBranch",
    });
  });

  it("blocks on a detached HEAD, which has no branch to push", async () => {
    await git(["checkout", "-q", "--detach"]);
    const state = await prepare(repo, base);
    expect(state.issue).toMatchObject({
      stage: "inspect",
      cause: "unsafeBranch",
      recovery: "chooseBranch",
    });
  });

  it("reports a non-repository working directory", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "codexdesk-plain-"));
    try {
      const state = await prepare(plain, base);
      expect(state.issue).toMatchObject({
        stage: "inspect",
        cause: "notRepository",
        recovery: "unavailable",
      });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("moves to push once work is committed but not pushed", async () => {
    await write("file.txt", "changed\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "work"]);

    const state = await prepare(repo, base);
    expect(state.next).toBe("push");
    expect(state.committedSha).not.toBeNull();
    expect(state.pushed).toBe(false);
  });

  it("moves to pr once the branch is pushed — the restart case", async () => {
    // §7.2's exit criterion: after a restart, a flow whose commit succeeded
    // and whose push succeeded must resume at PR creation, not re-commit.
    await write("file.txt", "changed\n");
    await git(["add", "-A"]);
    await git(["commit", "-qm", "work"]);
    await git(["push", "-q", "--set-upstream", "origin", "codexdesk/feature"]);

    const state = await prepare(repo, base);
    expect(state.next).toBe("pullRequest");
    expect(state.pushed).toBe(true);
    expect(state.upstream).toBe("origin/codexdesk/feature");
  });

  it("detects the remote and the absence of an upstream", async () => {
    await write("file.txt", "changed\n");
    const state = await prepare(repo, base);
    expect(state.remote).toBe("origin");
    expect(state.upstream).toBeNull();
  });

  it("counts additions and deletions against the base", async () => {
    await write("file.txt", "one\ntwo\nthree\n");
    const state = await prepare(repo, base);
    expect(state.additions).toBeGreaterThan(0);
  });

  it("counts untracked files, so the summary matches the file list", async () => {
    // Plain `git diff --numstat` omits untracked files, so a new eight-line
    // file was summarized as "+0 -0" while the changes pane — which stages
    // into a scratch index — showed "+8". Two implementations of "what
    // changed" that disagree is worse than either being wrong.
    await write("brand-new.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    const state = await prepare(repo, base);
    expect(state.files).toContain("brand-new.txt");
    expect(state.additions).toBe(8);
  });
});

describe("commit", () => {
  it("lists every changed path as a candidate, with its git state", async () => {
    // **This replaced an ownership heuristic.** The previous design read git's
    // index column to decide which files were the agent's and which were the
    // user's, and excluded the user's. That inference was unrecoverable after
    // a failed hook — see the restore test below. The UI asks instead
    // ("Include unstaged changes"), so `prepare` now reports state and the
    // commit form carries the choice.
    await write("agent.txt", "the agent wrote this\n");
    await write("mine.txt", "I staged this myself\n");
    await git(["add", "mine.txt"]);

    const state = await prepare(repo, base);
    expect(state.files).toEqual(
      expect.arrayContaining(["agent.txt", "mine.txt"]),
    );
    const mine = state.changes.find((c) => c.path === "mine.txt");
    const agent = state.changes.find((c) => c.path === "agent.txt");
    expect(mine).toMatchObject({ staged: true });
    expect(agent).toMatchObject({ untracked: true, staged: false });
  });

  it("commits only the paths it is given, leaving other staged work alone", async () => {
    // The invariant that survives the redesign: whatever the caller selects is
    // exactly what lands, and a file the user staged for their own reasons is
    // not swept in unless they picked it.
    await write("agent.txt", "agent work\n");
    await write("mine.txt", "mine\n");
    await git(["add", "mine.txt"]);

    const res = await commit(repo, ["agent.txt"], "agent change");
    expect(res.ok).toBe(true);

    const landed = await git(["show", "--name-only", "--format=", "HEAD"]);
    expect(landed).toContain("agent.txt");
    expect(landed).not.toContain("mine.txt");
    expect(await git(["status", "--porcelain"])).toContain("A  mine.txt");
  });

  it("restores the index when a hook rejects the commit", async () => {
    // **The bug this prevents.** `git add` stages the files, the hook fails,
    // and without a restore they stay staged. Every later `git status` then
    // reports the agent's own work as already staged — which the old ownership
    // heuristic read as "the user's", so the retry offered nothing to commit
    // and the flow could not be finished at all.
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await write("agent.txt", "agent work\n");

    const before = await git(["status", "--porcelain"]);
    const res = await commit(repo, ["agent.txt"], "will be rejected");
    expect(res.ok).toBe(false);

    // A failed commit is a no-op: the index looks exactly as it did.
    expect(await git(["status", "--porcelain"])).toBe(before);

    // And the retry still sees the work as committable.
    const state = await prepare(repo, base);
    expect(state.files).toContain("agent.txt");
  });

  it("keeps files the user had already staged staged after a hook failure", async () => {
    // The restore must not over-reach: it unstages only what we staged.
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await write("theirs.txt", "user staged this\n");
    await git(["add", "theirs.txt"]);
    await write("agent.txt", "agent work\n");

    await commit(repo, ["agent.txt", "theirs.txt"], "will be rejected");

    // theirs.txt was staged before we ran, so it stays staged.
    expect(await git(["status", "--porcelain"])).toContain("A  theirs.txt");
  });

  it("refuses to create an empty commit when there is nothing to do", async () => {
    const res = await commit(repo, [], "nothing here");
    expect(res).toMatchObject({
      ok: false,
      issue: {
        stage: "commit",
        cause: "noChanges",
        recovery: "unavailable",
      },
    });
  });

  it("requires a message", async () => {
    await write("file.txt", "changed\n");
    const res = await commit(repo, ["file.txt"], "   ");
    expect(res.ok).toBe(false);
  });

  it("returns the new commit sha", async () => {
    await write("file.txt", "changed\n");
    const res = await commit(repo, ["file.txt"], "a change");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.sha).toBe((await git(["rev-parse", "HEAD"])).trim());
    }
  });

  it("reports a rejecting pre-commit hook as its own cause", async () => {
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'lint failed: no'\nexit 1\n", {
      mode: 0o755,
    });
    await write("file.txt", "changed\n");

    const res = await commit(repo, ["file.txt"], "a change");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issue.cause).toBe("hook");
      expect(res.issue.recovery).toBe("userAction");
      expect(res.issue.detail).toContain("lint failed");
    }
  });
});

describe("push", () => {
  it("sets upstream on the first push", async () => {
    await write("file.txt", "changed\n");
    await commit(repo, ["file.txt"], "work");

    const res = await push(repo, "codexdesk/feature", "origin", false);
    expect(res.ok).toBe(true);
    expect(
      (await git(["rev-parse", "--abbrev-ref", "@{upstream}"])).trim(),
    ).toBe("origin/codexdesk/feature");
  });

  it("reports a missing remote instead of failing opaquely", async () => {
    const res = await push(repo, "codexdesk/feature", null, false);
    expect(res).toMatchObject({
      ok: false,
      issue: { stage: "push", cause: "missingRemote" },
    });
  });

  it("reports a non-fast-forward rejection rather than force-pushing", async () => {
    // §7.2 forbids force-push. Diverge the remote and confirm we surface it.
    await write("file.txt", "ours\n");
    await commit(repo, ["file.txt"], "ours");
    await push(repo, "codexdesk/feature", "origin", false);

    // Someone else moves the branch on the remote.
    const other = await mkdtemp(path.join(tmpdir(), "codexdesk-other-"));
    try {
      await run("git", ["clone", "-q", remote, "."], { cwd: other });
      await run("git", ["config", "user.email", "o@example.com"], {
        cwd: other,
      });
      await run("git", ["config", "user.name", "Other"], { cwd: other });
      await run("git", ["checkout", "-q", "codexdesk/feature"], { cwd: other });
      await write("file.txt", "theirs\n", other);
      await run("git", ["commit", "-qam", "theirs"], { cwd: other });
      await run("git", ["push", "-q"], { cwd: other });

      // Now our side commits on top of the old tip and pushes.
      await write("file.txt", "ours again\n");
      await commit(repo, ["file.txt"], "ours again");
      const res = await push(repo, "codexdesk/feature", "origin", true);

      expect(res).toMatchObject({
        ok: false,
        issue: { stage: "push", cause: "rejected" },
      });
      // The remote must be unchanged: we did not force anything.
      const remoteTip = await run(
        "git",
        ["log", "-1", "--format=%s", "codexdesk/feature"],
        { cwd: remote },
      );
      expect(remoteTip.stdout.trim()).toBe("theirs");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("createDraftPr", () => {
  /** A scripted `gh`, so no real pull request is ever opened. */
  function fakeGh(
    script: Record<string, { stdout?: string; stderr?: string; code?: number }>,
  ): Runner & { calls: string[][] } {
    const calls: string[][] = [];
    const runner = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const key = args.slice(0, 2).join(" ");
      const hit = script[key] ?? script[args[0] ?? ""] ?? { code: 0 };
      return {
        stdout: hit.stdout ?? "",
        stderr: hit.stderr ?? "",
        code: hit.code ?? 0,
      };
    };
    return Object.assign(runner, { calls });
  }

  const opts = { title: "A change", body: "Body", baseBranch: "main" };

  it("creates a draft pull request and returns its url", async () => {
    const gh = fakeGh({
      "--version": { stdout: "gh version 2.74.0" },
      "auth status": { stdout: "logged in" },
      "pr view": { code: 1, stderr: "no pull requests found" },
      "pr create": { stdout: "https://github.com/o/r/pull/7\n" },
    });

    const res = await createDraftPr(repo, opts, gh);
    expect(res).toMatchObject({
      ok: true,
      value: { url: "https://github.com/o/r/pull/7", existed: false },
    });
    // It must be a *draft*, per §7.2.
    expect(gh.calls.some((c) => c.includes("--draft"))).toBe(true);
  });

  it("returns the existing pull request instead of opening a second", async () => {
    const gh = fakeGh({
      "--version": { stdout: "gh version 2.74.0" },
      "auth status": { stdout: "logged in" },
      "pr view": { stdout: '{"url":"https://github.com/o/r/pull/3"}' },
    });

    const res = await createDraftPr(repo, opts, gh);
    expect(res).toMatchObject({
      ok: true,
      value: { url: "https://github.com/o/r/pull/3", existed: true },
    });
    // Idempotence: no create call at all.
    expect(gh.calls.some((c) => c.includes("create"))).toBe(false);
  });

  it("reports a missing gh binary as its own cause", async () => {
    const gh = fakeGh({ "--version": { code: 127, stderr: "not found" } });
    const res = await createDraftPr(repo, opts, gh);
    expect(res).toMatchObject({
      ok: false,
      issue: {
        stage: "pullRequest",
        cause: "missingTool",
        recovery: "unavailable",
      },
    });
  });

  it("reports an unauthenticated gh separately from a missing one", async () => {
    const gh = fakeGh({
      "--version": { stdout: "gh version 2.74.0" },
      "auth status": {
        code: 1,
        stderr: "You are not logged into any GitHub hosts",
      },
    });
    const res = await createDraftPr(repo, opts, gh);
    expect(res).toMatchObject({
      ok: false,
      issue: {
        stage: "pullRequest",
        cause: "authentication",
        recovery: "userAction",
      },
    });
  });

  it("reports a repository with no GitHub remote", async () => {
    const gh = fakeGh({
      "--version": { stdout: "gh version 2.74.0" },
      "auth status": { stdout: "logged in" },
      "pr view": { code: 1, stderr: "no git remotes found" },
    });
    const res = await createDraftPr(repo, opts, gh);
    expect(res).toMatchObject({
      ok: false,
      issue: { stage: "pullRequest", cause: "missingRemote" },
    });
  });

  it("recovers the url when a pull request appeared between check and create", async () => {
    let viewed = 0;
    const gh = (async (cmd: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "--version" || args[0] === "--version") {
        return { stdout: "gh version 2.74.0", stderr: "", code: 0 };
      }
      if (key === "auth status") return { stdout: "ok", stderr: "", code: 0 };
      if (key === "pr view") {
        viewed++;
        // Absent on the first look, present on the retry.
        return viewed === 1
          ? { stdout: "", stderr: "no pull requests found", code: 1 }
          : {
              stdout: '{"url":"https://github.com/o/r/pull/9"}',
              stderr: "",
              code: 0,
            };
      }
      return { stdout: "", stderr: "a pull request already exists", code: 1 };
    }) as Runner;

    const res = await createDraftPr(repo, opts, gh);
    expect(res).toMatchObject({
      ok: true,
      value: { url: "https://github.com/o/r/pull/9", existed: true },
    });
  });

  it("tells the user to push when the branch is not on the remote", async () => {
    const gh = fakeGh({
      "--version": { stdout: "gh version 2.74.0" },
      "auth status": { stdout: "logged in" },
      "pr view": { code: 1, stderr: "no pull requests found" },
      "pr create": { code: 1, stderr: "must first push the current branch" },
    });
    const res = await createDraftPr(repo, opts, gh);
    expect(res).toMatchObject({
      ok: false,
      issue: { stage: "pullRequest", cause: "missingUpstream" },
    });
  });
});

describe("resumability", () => {
  it("does not create a second commit when the flow is retried after a push failure", async () => {
    // The §7.2 invariant: commit succeeded, push failed, retry starts at push.
    await write("file.txt", "changed\n");
    const first = await commit(repo, ["file.txt"], "work");
    expect(first.ok).toBe(true);
    const shaAfterCommit = (await git(["rev-parse", "HEAD"])).trim();

    // Push fails (no remote configured for this call).
    const pushRes = await push(repo, "codexdesk/feature", null, false);
    expect(pushRes.ok).toBe(false);

    // Re-observing the world puts us at push, not at commit.
    const state = await prepare(repo, base);
    expect(state.next).toBe("push");
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(shaAfterCommit);
    expect((await git(["rev-list", "--count", `${base}..HEAD`])).trim()).toBe(
      "1",
    );
  });

  it("uses the real runner without throwing on non-zero exit", async () => {
    // execRunner must report failure as a code, never as a rejection — the
    // whole state machine depends on that.
    const res = await execRunner(
      "git",
      ["rev-parse", "--abbrev-ref", "@{upstream}"],
      repo,
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("no upstream");
  });
});
