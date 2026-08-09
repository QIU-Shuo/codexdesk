import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  readGitBranches,
  readGitProjectRoot,
} from "../src/main/git/worktree";

const run = promisify(execFile);
const scratch: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexdesk-worktree-test-"));
  scratch.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "CodexDesk Test");
  await writeFile(path.join(root, "source.txt"), "main\n");
  await git(root, "add", "source.txt");
  await git(root, "commit", "-qm", "main");
  return root;
}

afterEach(async () => {
  for (const dir of scratch.splice(0).reverse()) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("branch-started worktrees", () => {
  it("returns the renderer's currentBranch field", async () => {
    const root = await repo();
    const info = await readGitBranches(root);
    expect(info).toMatchObject({
      currentBranch: "main",
      defaultBranch: "main",
      branches: ["main"],
      dirtyCount: 0,
    });
    expect(info).not.toHaveProperty("branch");
    expect(info).not.toHaveProperty("headSha");
  });

  it("uses the selected branch commit without checking out the source", async () => {
    const root = await repo();
    await git(root, "checkout", "-qb", "feature/new-chat");
    await writeFile(path.join(root, "source.txt"), "feature\n");
    await git(root, "commit", "-qam", "feature");
    const featureSha = await git(root, "rev-parse", "feature/new-chat");
    await git(root, "checkout", "-q", "main");
    const container = await mkdtemp(path.join(os.tmpdir(), "codexdesk-worktrees-"));
    scratch.push(container);

    const result = await createWorktree(
      root,
      "thread",
      "branch-test",
      container,
      "feature/new-chat",
    );

    expect(result).toMatchObject({ ok: true, baseSha: featureSha });
    if (!result.ok) throw new Error(result.detail);
    expect(await readFile(path.join(result.path, "source.txt"), "utf8")).toBe(
      "feature\n",
    );
    expect(await git(root, "branch", "--show-current")).toBe("main");
    expect(await readGitProjectRoot(result.path)).toBe(await realpath(root));
  });

  it("rejects an unknown branch instead of falling back to HEAD", async () => {
    const root = await repo();
    const container = await mkdtemp(path.join(os.tmpdir(), "codexdesk-worktrees-"));
    scratch.push(container);

    const result = await createWorktree(
      root,
      "thread",
      "missing-test",
      container,
      "missing",
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "git-failed",
      detail: "Branch missing does not exist in this repository.",
    });
    expect(await git(root, "branch", "--show-current")).toBe("main");
  });
});
