import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AppServerClient } from "../../src/main/appServer/client";
import {
  createWorktree,
  diffAgainstBase,
  readGitInfo,
  removeWorktree,
} from "../../src/main/git/worktree";

/** A scratch repo with one commit, so worktrees have a base to branch from. */
function scratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codexdesk-repo-"));
  const g = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
             GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  g("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "hello.ts"), "export const hello = () => 'hi';\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

describe("thread lifecycle (live)", () => {
  it("starts, lists, names, forks, and deletes a thread", async () => {
    const repo = scratchRepo();
    const client = new AppServerClient(() => {}, "codex");
    await client.connect();

    const thread = await client.startThread({ cwd: repo });
    expect(thread.id).toBeTruthy();

    // A turn is needed before there is anything to fork from.
    await client.sendMessage(thread.id, [
      { type: "text", text: "Say the single word: ready", text_elements: [] },
    ]);
    await new Promise((r) => setTimeout(r, 12000));

    await client.setThreadName(thread.id, "codexdesk test thread");

    // `cwd` filtering is what makes a workspace-scoped picker cheap.
    const list = await client.listThreads({ cwd: repo, limit: 20, fast: true });
    const found = list.data.find((t) => t.id === thread.id);
    console.log("listed:", list.data.length, "| found:", !!found, "| name:", found?.name);
    expect(found).toBeDefined();
    expect(found?.name).toBe("codexdesk test thread");

    // includeTurns is the difference between a picker row and full history.
    const full = await client.readThread(thread.id, true);
    console.log("turns:", full.turns?.length ?? 0);
    expect((full.turns?.length ?? 0)).toBeGreaterThan(0);

    const meta = await client.readThread(thread.id, false);
    expect(meta.turns ?? []).toHaveLength(0);

    // Fork from the tip, then verify it is a distinct thread carrying history.
    const fork = await client.forkThread(thread.id, { cwd: repo });
    expect(fork.id).not.toBe(thread.id);
    const forkFull = await client.readThread(fork.id, true);
    console.log("fork turns:", forkFull.turns?.length ?? 0);
    expect((forkFull.turns?.length ?? 0)).toBeGreaterThan(0);

    const loaded = await client.loadedThreadIds();
    console.log("loaded in memory:", loaded.length);
    expect(loaded).toContain(thread.id);

    // `thread/delete` is broken in 0.144.4: it fails with "no such table:
    // agent_jobs". Migration 0042 drops that table but the delete path still
    // references it — an upstream bug, not a wrong call shape (our params
    // match `ThreadDeleteParams` exactly). Archiving is the working path.
    await expect(client.deleteThread(fork.id)).rejects.toThrow(/agent_jobs/);
    await client.archiveThread(thread.id, true);
    const archived = await client.listThreads({ cwd: repo, archived: true });
    expect(archived.data.some((t) => t.id === thread.id)).toBe(true);

    client.dispose();
    rmSync(repo, { recursive: true, force: true });
  }, 120000);

  it("resumes a thread and recovers its history", async () => {
    const repo = scratchRepo();
    const a = new AppServerClient(() => {}, "codex");
    await a.connect();
    const thread = await a.startThread({ cwd: repo });
    await a.sendMessage(thread.id, [
      { type: "text", text: "Say the single word: persisted", text_elements: [] },
    ]);
    await new Promise((r) => setTimeout(r, 12000));
    a.dispose();

    // A fresh connection, as after an app restart.
    const b = new AppServerClient(() => {}, "codex");
    await b.connect();
    const resumed = await b.resumeThread(thread.id, { cwd: repo });
    expect(resumed.id).toBe(thread.id);
    const full = await b.readThread(thread.id, true);
    const items = (full.turns ?? []).flatMap((t) => t.items);
    console.log("recovered items:", items.length);
    expect(items.length).toBeGreaterThan(0);

    b.dispose();
    rmSync(repo, { recursive: true, force: true });
  }, 120000);
});

describe("git worktrees", () => {
  it("creates an isolated worktree and diffs it against its base", async () => {
    const repo = scratchRepo();
    const container = mkdtempSync(path.join(tmpdir(), "codexdesk-wt-"));

    const info = await readGitInfo(repo);
    expect(info?.headSha).toBeTruthy();

    const result = await createWorktree(repo, "test thread", "aa11", container);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.branch).toBe("codexdesk/work/aa11/test_thread");

    // Edits land in the worktree, not the user's checkout — the whole point.
    writeFileSync(path.join(result.path, "hello.ts"), "export const hello = () => 'changed';\n");
    writeFileSync(path.join(result.path, "brand-new.ts"), "export const x = 1;\n");

    const diff = await diffAgainstBase(result.path, result.baseSha);
    console.log("diff length:", diff.length);
    expect(diff).toContain("changed");
    // Untracked files count as work the user needs to see.
    expect(diff).toContain("brand-new.ts");

    // The original checkout is untouched.
    const original = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
    expect(original.trim()).toBe("");

    // Refuses to discard uncommitted work without force.
    const refused = await removeWorktree(repo, result.path, false);
    expect(refused.ok).toBe(false);

    const forced = await removeWorktree(repo, result.path, true);
    expect(forced.ok).toBe(true);

    rmSync(repo, { recursive: true, force: true });
    rmSync(container, { recursive: true, force: true });
  }, 60000);

  it("reports a named reason rather than falling back to the checkout", async () => {
    const notRepo = mkdtempSync(path.join(tmpdir(), "codexdesk-plain-"));
    const container = mkdtempSync(path.join(tmpdir(), "codexdesk-wt2-"));
    const result = await createWorktree(notRepo, "x", "bb22", container);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A silent fallback to the user's checkout would violate the safety
      // model the sandbox posture depends on (plan §6, 3.4).
      expect(result.reason).toBe("not-a-repo");
    }
    rmSync(notRepo, { recursive: true, force: true });
    rmSync(container, { recursive: true, force: true });
  }, 30000);
});
