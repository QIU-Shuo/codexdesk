import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, migrate } from "../src/main/store";

function tempFile(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), "codexdesk-store-")),
    "state.json",
  );
}

describe("Store", () => {
  it("round-trips state through disk", () => {
    const file = tempFile();
    const a = new Store(file);
    a.load();
    a.update((s) => {
      s.threads.t1 = {
        draft: "unsent text",
        outbox: {
          entries: [
            {
              id: "q1",
              text: "queued",
              createdAt: 1,
              assets: [],
              schedule: "afterTurn",
              lastFailure: null,
            },
          ],
        },
        pinned: true,
        name: "My thread",
        cwd: "/tmp/x",
        worktreePath: null,
        updatedAtMs: 5,
      };
      s.pinnedOrder = ["t1"];
    });
    a.flush();

    const b = new Store(file);
    const loaded = b.load();
    // The specific failure this prevents: quitting discards typed text.
    expect(loaded.threads.t1?.draft).toBe("unsent text");
    expect(loaded.threads.t1?.outbox.entries).toHaveLength(1);
    expect(loaded.pinnedOrder).toEqual(["t1"]);
  });

  it("round-trips a thread's approval mode", () => {
    // The posture is a safety setting, so losing it across a restart would
    // silently widen what the agent may do in that thread.
    const file = tempFile();
    const a = new Store(file);
    a.load();
    a.update((s) => {
      s.approvalMode = "full-access";
      s.threads.t1 = {
        draft: "",
        outbox: { entries: [] },
        pinned: false,
        name: null,
        cwd: "/tmp/x",
        worktreePath: null,
        approvalMode: "read-only",
        updatedAtMs: 5,
      };
    });
    a.flush();

    const loaded = new Store(file).load();
    expect(loaded.approvalMode).toBe("full-access");
    expect(loaded.threads.t1?.approvalMode).toBe("read-only");
  });

  it("starts clean rather than refusing to launch on a corrupt file", () => {
    const file = tempFile();
    writeFileSync(file, "{ this is not json", "utf8");
    const store = new Store(file);
    const state = store.load();
    expect(state.threads).toEqual({});
    expect(state.notifyMode).toBe("unfocused");
  });

  it("writes atomically so a crash cannot leave a half-written file", () => {
    const file = tempFile();
    const store = new Store(file);
    store.load();
    store.update((s) => {
      s.recents = ["/a", "/b"];
    });
    store.flush();
    // Whatever is on disk must always parse.
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });

  it("returns a usable state when the file does not exist yet", () => {
    const store = new Store(tempFile());
    const state = store.load();
    expect(state.version).toBe(3);
    expect(state.recents).toEqual([]);
  });
});

describe("migrate", () => {
  it("fills in fields missing from an older shape", () => {
    const migrated = migrate({ threads: { a: undefined } } as never);
    expect(migrated.version).toBe(3);
    expect(migrated.pinnedOrder).toEqual([]);
    expect(migrated.recents).toEqual([]);
    expect(migrated.notifyMode).toBe("unfocused");
    // A file predating approval modes must load as the posture the app
    // already used, not as something wider.
    expect(migrated.approvalMode).toBe("auto");
  });

  it("moves v1 ownership into v3 workspace placements", () => {
    const base = {
      draft: "",
      queue: [],
      pinned: false,
      name: null,
      cwd: "/repo",
      worktreePath: null,
      updatedAtMs: 1,
    };
    const migrated = migrate({
      version: 1,
      projects: [
        {
          id: "project-1",
          name: "Repo",
          roots: ["/repo"],
          activeRoot: "/repo",
        },
      ],
      threads: {
        owned: { ...base, projectId: "project-1" },
        projectless: { ...base, projectId: null },
        unknown: base,
      },
    } as never);

    expect(migrated.workspaceRegistry.placements).toEqual({
      owned: {
        kind: "registered",
        workspaceId: "project-1",
        navigationRoot: "/repo",
      },
      projectless: { kind: "unassigned" },
      unknown: {
        kind: "registered",
        workspaceId: "project-1",
        navigationRoot: "/repo",
      },
    });
  });

  it("reads a v2 file and emits only v3 workspace state on the next save", () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        threads: {
          t1: {
            draft: "keep me",
            queue: [
              {
                id: "queued-1",
                text: "follow up",
                queuedAtMs: 3,
                attachments: [],
              },
            ],
            pinned: false,
            name: null,
            cwd: "/repo-worktree",
            worktreePath: "/repo-worktree",
            worktreeBaseSha: "abc123",
            comments: [
              {
                commentId: "comment-1",
                filePath: "src/app.ts",
                side: "right",
                startLine: 4,
                endLine: 4,
                hunkId: "src/app.ts:0",
                commentText: "keep this note",
                quotedLines: ["selected line"],
                createdAtMs: 2,
              },
            ],
            updatedAtMs: 1,
          },
        },
        projects: [
          {
            id: "workspace-1",
            name: "Repo",
            roots: ["/repo"],
            activeRoot: "/repo",
          },
        ],
        activeProjectId: "workspace-1",
        threadProjectAssignments: { t1: "workspace-1" },
        threadWorkspaceRootHints: { t1: "/repo" },
      }),
      "utf8",
    );

    const store = new Store(file);
    const loaded = store.load();
    expect(loaded.threads.t1?.draft).toBe("keep me");
    expect(loaded.workspaceRegistry.placements.t1).toEqual({
      kind: "registered",
      workspaceId: "workspace-1",
      navigationRoot: "/repo",
    });
    expect(loaded.threads.t1?.reviewNotes).toMatchObject([
      {
        id: "comment-1",
        body: "keep this note",
        anchor: {
          path: "src/app.ts",
          side: "after",
          context: { selected: ["selected line"] },
          baseRevision: "abc123",
        },
      },
    ]);
    expect(loaded.threads.t1?.outbox.entries).toMatchObject([
      {
        id: "queued-1",
        text: "follow up",
        createdAt: 3,
        schedule: "afterTurn",
      },
    ]);

    store.flush();
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(written.version).toBe(3);
    expect(written.workspaceRegistry).toBeTruthy();
    expect(written).not.toHaveProperty("projects");
    expect(written).not.toHaveProperty("threadProjectAssignments");
    expect(written).not.toHaveProperty("threadWorkspaceRootHints");
    expect(
      (written.threads as Record<string, Record<string, unknown>>).t1,
    ).not.toHaveProperty("comments");
    expect(
      (written.threads as Record<string, Record<string, unknown>>).t1,
    ).not.toHaveProperty("queue");
  });
});
