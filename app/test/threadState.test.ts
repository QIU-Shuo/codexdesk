import { describe, expect, it } from "vitest";
import { projectForCwd, sortThreads } from "../src/main/threadState";
import { mapThreadStatus } from "../src/infrastructure/app-server/adapters/conversations";
import { worktreeBranchName } from "../src/main/git/worktree";
import type { ThreadListEntry } from "../src/shared/ipc";

function entry(id: string, updatedAtMs: number): ThreadListEntry {
  return {
    threadId: id,
    name: null,
    preview: "",
    cwd: "/tmp",
    projectId: null,
    run: { kind: "ready" },
    pinned: false,
    archived: false,
    unread: false,
    updatedAtMs,
    worktreePath: null,
    checkout: { kind: "notRequested" },
    loaded: true,
  };
}

describe("sortThreads", () => {
  it("puts pinned threads first, in their stored order", () => {
    const rows = [entry("a", 300), entry("b", 200), entry("c", 100)];
    const sorted = sortThreads(rows, ["c", "b"]);
    expect(sorted.map((t) => t.threadId)).toEqual(["c", "b", "a"]);
  });

  it("sorts unpinned threads by recency", () => {
    const rows = [entry("a", 100), entry("b", 300), entry("c", 200)];
    expect(sortThreads(rows, []).map((t) => t.threadId)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("ignores pinned ids that are no longer present", () => {
    const rows = [entry("a", 100), entry("b", 200)];
    expect(sortThreads(rows, ["gone", "a"]).map((t) => t.threadId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("projectForCwd", () => {
  const projects = [
    {
      id: "parent",
      name: "Monorepo",
      roots: ["/work/repo", "/work/second-root"],
      activeRoot: "/work/repo",
    },
    {
      id: "nested",
      name: "App",
      roots: ["/work/repo/packages/app"],
      activeRoot: "/work/repo/packages/app",
    },
  ];

  it("uses the most specific root and supports multi-root projects", () => {
    expect(projectForCwd("/work/repo/packages/app/src", projects)).toBe(
      "nested",
    );
    expect(projectForCwd("/work/second-root/src", projects)).toBe("parent");
  });

  it("does not confuse path prefixes and leaves unmatched chats projectless", () => {
    expect(projectForCwd("/work/repository", projects)).toBeNull();
    expect(projectForCwd("/elsewhere", projects)).toBeNull();
  });
});

describe("mapThreadStatus", () => {
  it("preserves the attention flags rather than collapsing to active", () => {
    // `ThreadStatus` is a tagged union whose `active` variant carries
    // `activeFlags`; those flags are the sidebar's needs-attention signal.
    expect(
      mapThreadStatus(
        { type: "active", activeFlags: ["waitingOnApproval"] },
        "turn-1",
      ),
    ).toMatchObject({ kind: "waiting", reason: "approval" });
    expect(
      mapThreadStatus(
        { type: "active", activeFlags: ["waitingOnUserInput"] },
        "turn-1",
      ),
    ).toMatchObject({ kind: "waiting", reason: "input" });
    expect(
      mapThreadStatus({ type: "active", activeFlags: [] }, "turn-1"),
    ).toMatchObject({ kind: "running", turnId: "turn-1" });
  });

  it("maps the remaining variants", () => {
    expect(mapThreadStatus({ type: "idle" }, null)).toEqual({ kind: "ready" });
    expect(mapThreadStatus({ type: "notLoaded" }, null)).toEqual({
      kind: "offline",
    });
    expect(mapThreadStatus({ type: "systemError" }, null)).toMatchObject({
      kind: "failed",
    });
  });
});

describe("worktreeBranchName", () => {
  it("separates the unique tag from the readable label", () => {
    expect(worktreeBranchName("Fix the login bug", "ab12")).toBe(
      "codexdesk/work/ab12/fix_the_login_bug",
    );
  });

  it("falls back when a label has no usable characters", () => {
    expect(worktreeBranchName("!!!", "ab12")).toBe("codexdesk/work/ab12/task");
  });

  it("bounds the slug length", () => {
    const name = worktreeBranchName("x".repeat(200), "ab12");
    expect(name.length).toBeLessThan(50);
  });
});
