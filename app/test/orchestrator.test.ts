import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  Orchestrator,
  type ClientPort,
  type Deps,
  type GitPort,
} from "../src/main/orchestrator";
import { Store } from "../src/main/store";
import type { AppEvent, AuthState, UsageReport } from "../src/shared/ipc";
import type { LoginAccountParams } from "../src/protocol/generated/v2/LoginAccountParams";
import type { Thread } from "../src/protocol/generated/v2/Thread";
import type { ThreadItem } from "../src/protocol/generated/v2/ThreadItem";
import type { UserInput } from "../src/protocol/generated/v2/UserInput";

/**
 * Main-process orchestration tests.
 *
 * **Why these exist.** A review found five P1 bugs and every one of them lived
 * here — the layer with no coverage. Unit tests covered pure functions; live
 * tests drove `AppServerClient` directly, bypassing this entirely; the UI pass
 * only walked happy paths (it reopened a thread still in memory, which skips
 * the resume branch where the worst bug was). Each test below names the bug it
 * pins down, so a regression says what broke rather than just failing.
 */

function thread(id: string, cwd = "/repo"): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    path: null,
    cwd,
    cliVersion: "0.144.4",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  } as unknown as Thread;
}

type FakeClient = ClientPort & {
  sent: {
    threadId: string;
    input: UserInput[];
    model?: string | null;
    effort?: unknown;
    serviceTier?: string | null;
    approvalPolicy?: unknown;
    sandboxPolicy?: unknown;
  }[];
  startedWith: {
    cwd: string;
    model?: string | null;
    effort?: unknown;
    serviceTier?: string | null;
    approvalsReviewer?: string | null;
    approvalPolicy?: unknown;
    sandbox?: unknown;
  }[];
  resumedWith: {
    threadId: string;
    cwd: string;
    model?: string | null;
    effort?: unknown;
    serviceTier?: string | null;
    approvalsReviewer?: string | null;
    approvalPolicy?: unknown;
    sandbox?: unknown;
  }[];
  forkedWith: {
    threadId: string;
    cwd: string;
    lastTurnId?: string;
    model?: string | null;
    effort?: unknown;
    serviceTier?: string | null;
    approvalsReviewer?: string | null;
    approvalPolicy?: unknown;
    sandbox?: unknown;
  }[];
  failNextSend: boolean;
  activeTurns: Set<string>;
  loaded: string[];
  archiveError: Error | null;
  resumeError: Error | null;
  searchedFor: string[];
  searchedRoots: string[][];
  compacted: string[];
  compactError: Error | null;
  /** When set, `resumeThread` blocks on it — lets a test inspect the UI state
   * after the optimistic switch but before history has loaded. */
  gateResume: Promise<void> | null;
  /** Rows returned by `listThreads`, i.e. the sidebar catalog. */
  catalogData: Thread[];
  catalogArchivedData: Thread[];
  // --- sign-in (§8.5) ---
  authState: AuthState;
  loginStarts: LoginAccountParams[];
  cancelled: string[];
  apiKeyError: Error | null;
  // --- steering (§8.1) ---
  steered: {
    threadId: string;
    expectedTurnId: string;
    input: UserInput[];
  }[];
  steerError: Error | null;
  // --- usage (§8.6) ---
  usage: UsageReport | null;
  redeemKeys: string[];
  redeemFails: boolean;
};

let clientSeq = 0;

function makeClient(): FakeClient {
  const prefix = `c${++clientSeq}`;
  let n = 0;
  const c: FakeClient = {
    sent: [],
    startedWith: [],
    resumedWith: [],
    forkedWith: [],
    failNextSend: false,
    activeTurns: new Set(),
    loaded: [],
    archiveError: null,
    resumeError: null,
    searchedFor: [],
    searchedRoots: [],
    compacted: [],
    compactError: null,
    gateResume: null,
    catalogData: [],
    catalogArchivedData: [],
    authState: { kind: "signedIn", account: {} as never },
    loginStarts: [],
    cancelled: [],
    apiKeyError: null,
    steered: [],
    steerError: null,
    usage: null,
    redeemKeys: [],
    redeemFails: false,

    // --- sign-in (§8.5). The auth tests drive these; the default is a
    // signed-in account so every other test behaves as before.
    async readAuth() {
      return c.authState;
    },
    async startLogin(params: LoginAccountParams) {
      c.loginStarts.push(params);
      if (params.type === "chatgpt") {
        return {
          type: "chatgpt" as const,
          loginId: "login-1",
          authUrl: "https://auth.example.invalid/start",
        };
      }
      if (c.apiKeyError) throw c.apiKeyError;
      return { type: "apiKey" as const };
    },
    async cancelLogin(loginId: string) {
      c.cancelled.push(loginId);
    },
    async logout() {
      c.authState = { kind: "signedOut", requiresOpenaiAuth: true };
    },

    async startThread(config) {
      c.startedWith.push({
        cwd: config.cwd,
        model: config.model,
        effort: config.effort,
        serviceTier: config.serviceTier,
        approvalsReviewer: config.approvalsReviewer,
        approvalPolicy: config.approvalPolicy,
        sandbox: config.sandbox,
      });
      return thread(`${prefix}-t${++n}`, config.cwd);
    },
    async resumeThread(threadId, config) {
      c.resumedWith.push({
        threadId,
        cwd: config.cwd,
        model: config.model,
        effort: config.effort,
        serviceTier: config.serviceTier,
        approvalsReviewer: config.approvalsReviewer,
        approvalPolicy: config.approvalPolicy,
        sandbox: config.sandbox,
      });
      if (c.gateResume) await c.gateResume;
      if (c.resumeError) throw c.resumeError;
      return thread(threadId, config.cwd);
    },
    async forkThread(threadId, config, lastTurnId) {
      c.forkedWith.push({
        threadId,
        cwd: config.cwd,
        lastTurnId,
        model: config.model,
        effort: config.effort,
        serviceTier: config.serviceTier,
        approvalsReviewer: config.approvalsReviewer,
        approvalPolicy: config.approvalPolicy,
        sandbox: config.sandbox,
      });
      return thread(`${prefix}-fork${++n}`, config.cwd);
    },
    async readThread(threadId) {
      return thread(threadId);
    },
    async listThreads(params) {
      const source = params.archived ? c.catalogArchivedData : c.catalogData;
      const offset = Number(params.cursor ?? 0);
      const limit = params.limit ?? source.length;
      const nextOffset = offset + limit;
      return {
        data: source.slice(offset, nextOffset),
        nextCursor: nextOffset < source.length ? String(nextOffset) : null,
      };
    },
    async loadedThreadIds() {
      return c.loaded;
    },
    async setThreadName() {},
    async archiveThread() {
      if (c.archiveError) throw c.archiveError;
    },
    async deleteThread() {},
    async unsubscribe() {},
    async sendMessage(threadId, input, options) {
      if (c.failNextSend) {
        c.failNextSend = false;
        throw new Error("turn/start: server exploded");
      }
      c.sent.push({
        threadId,
        input,
        model: options?.model,
        effort: options?.effort,
        serviceTier: options?.serviceTier,
        approvalPolicy: options?.approvalPolicy,
        sandboxPolicy: options?.sandboxPolicy,
      });
    },
    async interrupt() {},
    async compact(threadId) {
      if (c.compactError) throw c.compactError;
      c.compacted.push(threadId);
    },
    // --- usage (§8.6) ---
    async readUsage() {
      return c.usage;
    },
    async consumeResetCredit(key) {
      c.redeemKeys.push(key);
      return !c.redeemFails;
    },
    async steer(threadId, expectedTurnId, input) {
      if (!c.activeTurns.has(threadId)) return { kind: "turnEnded" };
      if (c.steerError) {
        const detail = (
          c.steerError as Error & {
            data?: {
              error?: { activeTurnNotSteerable?: { turnKind?: string } };
            };
          }
        ).data?.error?.activeTurnNotSteerable?.turnKind;
        return { kind: "notSteerable", detail: detail ?? null };
      }
      c.steered.push({ threadId, expectedTurnId, input });
      return { kind: "delivered" };
    },
    isTurnActive: (threadId) => c.activeTurns.has(threadId),
    activeTurnId: (threadId) =>
      c.activeTurns.has(threadId) ? `turn-${threadId}` : null,
    answerRequest() {},
    async startReview(_threadId) {
      return { reviewThreadId: `${prefix}-review${++n}` };
    },
    async searchFiles(query, roots) {
      c.searchedFor.push(query);
      c.searchedRoots.push(roots);
      return {
        files: [
          { path: "/repo/match.ts", file_name: "match.ts" },
          { path: "/repo/.git/hooks/pre-commit", file_name: "pre-commit" },
        ],
      };
    },
    pendingFor: () => [],
    async listSkills() {
      return { skills: [], errors: [] };
    },
    async setSkillEnabled() {},
    async listPlugins() {
      return [];
    },
    async listMcpServers() {
      return [];
    },
    async reloadMcpServers() {},
    async readWebSearchSettings() {
      return { mode: null, allowedModes: null };
    },
    async setPluginEnabled() {},
    async setWebSearchMode() {},
  };
  return c;
}

function makeGit(): GitPort & {
  created: string[];
  bases: Array<string | undefined>;
  diff: string;
  projectRoots: Map<string, string>;
} {
  let n = 0;
  const g = {
    created: [] as string[],
    bases: [] as Array<string | undefined>,
    diff: "",
    projectRoots: new Map<string, string>(),
    async projectRoot(cwd: string) {
      return g.projectRoots.get(cwd) ?? null;
    },
    async createWorktree(
      _repo: string,
      label: string,
      suffix: string,
      dir: string,
      baseBranch?: string,
    ) {
      const p = path.join(dir, `${label}-${suffix}-${++n}`);
      g.created.push(p);
      g.bases.push(baseBranch);
      return {
        ok: true as const,
        path: p,
        branch: `codexdesk/${label}-${suffix}`,
        baseSha: `sha-${n}`,
      };
    },
    async readBranches(cwd: string) {
      return {
        root: cwd,
        currentBranch: "main",
        defaultBranch: "main",
        branches: ["main", "feature"],
        dirtyCount: 2,
      };
    },
    async removeWorktree() {
      return { ok: true };
    },
    async diffAgainstBase() {
      return g.diff;
    },
    // --- milestone 3 (§7). Defaults describe a clean worktree with nothing
    // to deliver; the delivery tests drive the real implementations against
    // real repositories instead of this fake.
    async sessionDiff() {
      return { parsed: { files: [], additions: 0, deletions: 0 }, raw: g.diff };
    },
    async prepareDelivery(worktreePath: string) {
      return {
        next: "inspect" as const,
        repoRoot: worktreePath,
        branch: "codexdesk/test",
        defaultBranch: "main",
        remote: "origin",
        upstream: null,
        files: ["a.ts"],
        changes: [
          { path: "a.ts", untracked: false, staged: false, unstaged: true },
        ],
        additions: 0,
        deletions: 0,
        committedSha: null,
        pushed: false,
        prUrl: null,
        issue: null,
      };
    },
    async commit() {
      return { ok: true as const, value: { sha: "commit-sha" } };
    },
    async push() {
      return { ok: true as const, value: { upstream: "origin/codexdesk/test" } };
    },
    async createDraftPr() {
      return {
        ok: true as const,
        value: { url: "https://example.invalid/pull/1", existed: false },
      };
    },
  };
  return g;
}

function setup(
  opts: {
    storeFile?: string;
    listDir?: Deps["listDir"];
    openExternal?: Deps["openExternal"];
  } = {},
) {
  const events: AppEvent[] = [];
  const file =
    opts.storeFile ??
    path.join(mkdtempSync(path.join(tmpdir(), "codexdesk-orch-")), "state.json");
  const store = new Store(file);
  store.load();
  const client = makeClient();
  const git = makeGit();
  const orch = new Orchestrator({
    store,
    emit: (ev) => events.push(ev),
    notify: () => {},
    git,
    worktreeContainer: "/wt",
    canonicalize: (d) => d,
    listDir: opts.listDir,
    openExternal: opts.openExternal,
  });
  orch.setClient(client);
  orch.workspace = "/repo";
  return { orch, client, git, store, events, file };
}

function outboxEntries(orch: Orchestrator, threadId: string) {
  return orch.getThread(threadId)!.outbox.durableSnapshot().entries;
}

function outboxDispatch(orch: Orchestrator, threadId: string) {
  return orch.getThread(threadId)!.outbox.dispatchState();
}

describe("draft isolation between threads", () => {
  // P1: a draft typed in thread A appeared in thread B and was persisted
  // there. The renderer kept any non-empty local draft across a switch; the
  // fix lives in App.tsx, but the main-process contract is what makes it
  // detectable — each thread's draft must stay its own.
  it("keeps each thread's draft separate", async () => {
    const { orch, store } = setup();
    const a = (await orch.newThread({}))!;
    const b = (await orch.newThread({}))!;

    orch.saveDraft(a, "text meant for A");
    orch.saveDraft(b, "text meant for B");

    expect(orch.getThread(a)!.draft).toBe("text meant for A");
    expect(orch.getThread(b)!.draft).toBe("text meant for B");
    expect(store.get().threads[a]!.draft).toBe("text meant for A");
    expect(store.get().threads[b]!.draft).toBe("text meant for B");
  });

  it("serves the right draft in each thread's view", async () => {
    const { orch } = setup();
    const a = (await orch.newThread({}))!;
    const b = (await orch.newThread({}))!;
    orch.saveDraft(a, "A text");

    await orch.openThread(b);
    expect(orch.toView(orch.getThread(b)!).draft).toBe("");
    await orch.openThread(a);
    expect(orch.toView(orch.getThread(a)!).draft).toBe("A text");
  });
});

describe("item lifecycle timing", () => {
  it("retains app-server timestamps for compact reasoning durations", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;
    const item: ThreadItem = {
      type: "reasoning",
      id: "reasoning-1",
      summary: ["Checking the implementation."],
      content: [],
    };

    orch.handleEvent({
      type: "itemStarted",
      threadId: id,
      turnId: "turn-1",
      item,
      startedAtMs: 1_000,
    });
    orch.handleEvent({
      type: "itemCompleted",
      threadId: id,
      turnId: "turn-1",
      item,
      completedAtMs: 66_000,
    });

    const entry = orch.toView(orch.getThread(id)!).entries[0];
    expect(entry).toMatchObject({
      kind: "item",
      id: "reasoning-1",
      turnId: "turn-1",
      startedAtMs: 1_000,
      completedAtMs: 66_000,
    });
  });
});

describe("message durability", () => {
  // P1: the queue entry was removed and persisted *before* turn/start
  // succeeded, so a rejected send destroyed the user's message with only a
  // log line to show for it.
  it("keeps a queued message when the send fails", async () => {
    const { orch, client, store } = setup();
    const id = (await orch.newThread({}))!;

    client.activeTurns.add(id);
    await orch.sendMessage(id, "queued while busy");
    expect(outboxEntries(orch, id)).toHaveLength(1);

    client.activeTurns.delete(id);
    client.failNextSend = true;
    await orch.drainQueue(id);

    // Still queued, still persisted, and the user is told.
    expect(outboxEntries(orch, id)).toHaveLength(1);
    expect(store.get().threads[id]!.outbox.entries).toHaveLength(1);
    expect(orch.getThread(id)!.lastError).toMatch(/failed to send/);
  });

  it("removes a queued message only after a successful send", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "follow-up");
    client.activeTurns.delete(id);

    await orch.drainQueue(id);

    expect(outboxEntries(orch, id)).toHaveLength(0);
    expect(client.sent.at(-1)?.input[0]).toMatchObject({ text: "follow-up" });
  });

  it("keeps the draft when a direct send fails", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    orch.saveDraft(id, "precious text");

    client.failNextSend = true;
    const res = await orch.sendMessage(id, "precious text");

    expect(res.error).toMatch(/exploded/);
    // Clearing the draft before the RPC succeeded threw away typed text.
    expect(orch.getThread(id)!.draft).toBe("precious text");
  });

  it("clears the draft once the send succeeds", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;
    orch.saveDraft(id, "sent text");
    await orch.sendMessage(id, "sent text");
    expect(orch.getThread(id)!.draft).toBe("");
  });

  it("drains one message per completed turn, not all at once", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "first");
    await orch.sendMessage(id, "second");
    client.activeTurns.delete(id);

    await orch.drainQueue(id);

    expect(client.sent.filter((s) => s.threadId === id)).toHaveLength(1);
    expect(outboxEntries(orch, id)).toHaveLength(1);
  });
});

describe("worktree isolation", () => {
  it("registers an isolated checkout as its own workspace", async () => {
    const { orch, git } = setup();
    const source = orch.addProject("CodexDesk", "/repo");

    const result = await orch.registerIsolatedWorkspace(
      source.id,
      "CodexDesk experiment",
    );

    expect(result.error).toBeNull();
    expect(result.project).toMatchObject({
      name: "CodexDesk experiment",
      roots: [git.created[0]],
      activeRoot: git.created[0],
    });
    expect(orch.snapshot().activeProjectId).toBe(result.project?.id);

    orch.renameProject(result.project!.id, "CodexDesk stable");
    expect(
      orch.snapshot().projects.find((item) => item.id === result.project?.id)
        ?.name,
    ).toBe("CodexDesk stable");
  });

  it("remembers the selected source root for the next draft chat", async () => {
    const { orch, store } = setup();
    const project = orch.addProject("Monorepo", "/repo");
    store.update((state) => {
      const saved = state.workspaceRegistry.workspaces.find(
        (item) => item.id === project.id,
      );
      if (saved) saved.roots.push("/repo/tools");
    });

    await orch.newThread({
      cwd: "/repo/tools",
      projectId: project.id,
      useWorktree: true,
    });

    expect(
      store
        .get()
        .workspaceRegistry.workspaces.find((item) => item.id === project.id)
        ?.selectedRoot,
    ).toBe("/repo/tools");
  });

  it("starts a selected branch in an isolated worktree", async () => {
    const { orch, git, client } = setup();
    const id = (await orch.newThread({
      cwd: "/repo",
      projectId: "project-1",
      useWorktree: false,
      baseBranch: "feature/new-chat",
    }))!;

    expect(git.bases).toEqual(["feature/new-chat"]);
    expect(orch.getThread(id)!.worktreePath).toBe(git.created[0]);
    expect(client.startedWith.at(-1)?.cwd).toBe(git.created[0]);
  });

  it("reads branch context without creating a thread", async () => {
    const { orch, git } = setup();
    expect(await orch.readGitBranches("/repo")).toMatchObject({
      root: "/repo",
      currentBranch: "main",
      branches: ["main", "feature"],
      dirtyCount: 2,
    });
    expect(git.created).toEqual([]);
  });

  // P1 (worst): resume passed the workspace root and only applied the saved
  // worktree path afterwards, so the UI showed a worktree while the agent ran
  // against the user's real checkout. The UI pass missed it because it
  // reopened a thread still in memory, skipping this branch entirely.
  it("resumes a worktree thread against its worktree, not the workspace", async () => {
    const { orch, client, git, file } = setup();
    orch.setUseWorktrees?.(true);
    const id = (await orch.newThread({ useWorktree: true }))!;
    const wtPath = git.created[0]!;
    expect(orch.getThread(id)!.worktreePath).toBe(wtPath);
    orch.getThread(id)!.updatedAtMs = 1;
    (orch as unknown as { deps: { store: Store } }).deps.store.flush();

    // Restart: fresh orchestrator over the same persisted state.
    const fresh = setup({ storeFile: file });
    await fresh.orch.openThread(id);

    expect(fresh.client.resumedWith).toHaveLength(1);
    expect(fresh.client.resumedWith[0]!.cwd).toBe(wtPath);
    expect(fresh.orch.getThread(id)!.worktreePath).toBe(wtPath);
  });

  it("persists the base SHA so diffs survive a restart", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({ useWorktree: true }))!;
    const base = orch.getThread(id)!.worktreeBaseSha;
    expect(base).toBeTruthy();
    expect(store.get().threads[id]!.worktreeBaseSha).toBe(base);

    store.flush();
    const fresh = setup({ storeFile: file });
    fresh.git.diff = "diff --git a/x b/x";
    await fresh.orch.openThread(id);
    expect(fresh.orch.getThread(id)!.worktreeBaseSha).toBe(base);
  });

  // P1: the fork copied the source thread's worktree path, letting two
  // independent agents edit one checkout concurrently.
  it("gives a fork its own worktree", async () => {
    const { orch, git } = setup();
    const id = (await orch.newThread({ useWorktree: true }))!;
    const srcPath = orch.getThread(id)!.worktreePath;

    const forkId = (await orch.forkThread(id))!;
    const forkPath = orch.getThread(forkId)!.worktreePath;

    expect(forkPath).toBeTruthy();
    expect(forkPath).not.toBe(srcPath);
    expect(git.created).toHaveLength(2);
  });

  it("forks a non-worktree thread without creating one", async () => {
    const { orch, git } = setup();
    const id = (await orch.newThread({ useWorktree: false }))!;
    const forkId = (await orch.forkThread(id))!;
    expect(orch.getThread(forkId)!.worktreePath).toBeNull();
    expect(git.created).toHaveLength(0);
  });

  it("refuses to start a thread when worktree setup fails", async () => {
    const { orch, client, git } = setup();
    git.createWorktree = async () => ({
      ok: false,
      reason: "not-a-repo",
      detail: "not a git repository",
    });

    const id = await orch.newThread({ useWorktree: true });

    // A silent fallback to the user's checkout would defeat the isolation
    // the sandbox posture depends on (plan §6, 3.4).
    expect(id).toBeNull();
    expect(client.startedWith).toHaveLength(0);
  });

  it("passes the fork's own turn id through as the checkpoint", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    await orch.forkThread(id, "turn-42");
    expect(client.forkedWith[0]!.lastTurnId).toBe("turn-42");
  });
});

describe("recovery", () => {
  // P1: `lastThreadId` was written and never read; `loadedThreadIds()` had
  // no call sites. Recovery reloaded the catalog and nothing else.
  it("reopens the thread the user was last looking at", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    await orch.openThread(id);
    expect(store.get().lastThreadId).toBe(id);
    store.flush();

    const fresh = setup({ storeFile: file });
    await fresh.orch.recover();

    expect(fresh.orch.activeThreadId).toBe(id);
  });

  it("reattaches to threads app-server still holds in memory", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    store.flush();

    const fresh = setup({ storeFile: file });
    fresh.client.loaded = [id];
    fresh.client.activeTurns.add(id);
    await fresh.orch.recover();

    // A thread the server still considers active is running, not idle.
    expect(fresh.orch.getThread(id)).toBeDefined();
    expect(fresh.orch.getThread(id)!.run.kind).toBe("running");
  });

  it("ignores loaded threads that are not ours", async () => {
    const { orch, client } = setup();
    client.loaded = ["someone-elses-thread"];
    await orch.recover();
    expect(orch.getThread("someone-elses-thread")).toBeUndefined();
  });

  it("survives loadedThreadIds failing", async () => {
    const { orch, client, store, file } = setup();
    const id = (await orch.newThread({}))!;
    await orch.openThread(id);
    store.flush();

    const fresh = setup({ storeFile: file });
    fresh.client.loadedThreadIds = async () => {
      throw new Error("unsupported");
    };
    await fresh.orch.recover();

    // Degrades to "reopen the last thread" rather than throwing.
    expect(fresh.orch.activeThreadId).toBe(id);
  });
});

describe("opening a thread the server cannot resume", () => {
  // Found by driving the real app after the fixes: a thread created and never
  // used has no rollout on disk, so `thread/resume` fails and the row was
  // stranded in the picker with only a log line. The fake client in these
  // tests always resumed successfully, which is exactly why the first pass
  // missed it — a fake that never fails tests nothing about failure.
  it("starts a usable replacement thread, carrying local state over", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({ useWorktree: true }))!;
    const wt = orch.getThread(id)!.worktreePath;
    orch.saveDraft(id, "typed but never sent");
    store.flush();

    const fresh = setup({ storeFile: file });
    fresh.client.resumeError = new Error(
      `thread/resume: no rollout found for thread id ${id}`,
    );
    await fresh.orch.openThread(id);

    // Reconstructing locally is not enough: app-server would then reject
    // `turn/start` with "thread not found". A fresh server thread is
    // started and the local state moves onto it.
    const active = fresh.orch.activeThreadId!;
    expect(active).toBeTruthy();
    expect(active).not.toBe(id);
    expect(fresh.client.startedWith.length).toBeGreaterThan(0);
    expect(fresh.orch.getThread(active)!.worktreePath).toBe(wt);
    expect(fresh.orch.getThread(active)!.draft).toBe("typed but never sent");

    // The dead id is gone from the picker rather than lingering unusable.
    // (`store` here is the first instance's handle; the fresh orchestrator
    // owns its own Store over the same file, so check that one.)
    expect(fresh.orch.getThread(id)).toBeUndefined();
    expect(fresh.store.get().threads[id]).toBeUndefined();
    expect(fresh.orch.threadList().some((t) => t.threadId === id)).toBe(false);
  });

  it("can send on the replacement thread", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    store.flush();

    const fresh = setup({ storeFile: file });
    fresh.client.resumeError = new Error("no rollout found");
    await fresh.orch.openThread(id);

    const active = fresh.orch.activeThreadId!;
    const res = await fresh.orch.sendMessage(active, "hello");
    expect(res.error).toBeUndefined();
    expect(fresh.client.sent.at(-1)?.threadId).toBe(active);
  });

  it("still reports a resume failure that is not about a missing rollout", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    store.flush();

    const fresh = setup({ storeFile: file });
    fresh.client.resumeError = new Error("connection reset");
    await fresh.orch.openThread(id);

    expect(fresh.orch.activeThreadId).toBeNull();
    expect(
      fresh.events.some(
        (e) => e.type === "log" && /connection reset/.test(e.message),
      ),
    ).toBe(true);
  });
});

describe("optimistic thread switch", () => {
  // Switching to a cold thread used to block on `resumeThread` + `readThread`
  // before showing anything — 1-3s of nothing. The switch now emits an
  // immediate skeleton from persisted state and loads history in the
  // background.
  it("shows the thread before its history has loaded", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    orch.saveDraft(id, "half-written");
    store.flush();

    const fresh = setup({ storeFile: file });
    let release!: () => void;
    fresh.client.gateResume = new Promise((r) => (release = r));

    // Do not await: the load is gated open, so this resolves only after the
    // optimistic emit.
    const opening = fresh.orch.openThread(id);
    await Promise.resolve();

    // Visible already, with the persisted draft, before resume returns.
    expect(fresh.orch.activeThreadId).toBe(id);
    const view = fresh.events.filter((e) => e.type === "threadView").at(-1) as
      { view: { draft: string; loaded: boolean } } | undefined;
    expect(view?.view.draft).toBe("half-written");
    // The skeleton is explicitly marked not-loaded, so the transcript shows a
    // loading state rather than the "(empty thread)" / "ask something" copy.
    expect(view?.view.loaded).toBe(false);
    // The blocking call has been issued but not yet resolved.
    expect(fresh.client.resumedWith.map((r) => r.threadId)).toContain(id);

    release();
    await opening;
    expect(fresh.orch.getThread(id)?.loaded).toBe(true);
  });

  it("keeps the thread title through the switch instead of flashing empty", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    store.flush();

    const fresh = setup({ storeFile: file });
    // The sidebar catalog is what showed a name before the click; seed it the
    // way startup does via `listThreads`.
    fresh.client.catalogData = [
      { ...thread(id), name: "My feature work", preview: "do the thing" },
    ];
    await fresh.orch.refreshCatalog();

    let release!: () => void;
    fresh.client.gateResume = new Promise((r) => (release = r));
    const opening = fresh.orch.openThread(id);
    await Promise.resolve();

    // The optimistic view must already carry the name — not null, which is
    // what rendered as "(empty thread)".
    const view = fresh.events.filter((e) => e.type === "threadView").at(-1) as
      { view: { name: string | null } } | undefined;
    expect(view?.view.name).toBe("My feature work");

    release();
    await opening;
  });

  it("does not reorder a project when an older cold thread is selected", async () => {
    const { orch, client } = setup();
    client.catalogData = [
      {
        ...thread("recent"),
        createdAt: 20,
        updatedAt: 20,
        recencyAt: 20,
      },
      {
        ...thread("older"),
        createdAt: 10,
        updatedAt: 10,
        recencyAt: 10,
      },
    ];
    await orch.refreshCatalog();
    expect(orch.threadList().map((row) => row.threadId)).toEqual([
      "recent",
      "older",
    ]);

    let release!: () => void;
    client.gateResume = new Promise((resolve) => (release = resolve));
    const opening = orch.openThread("older");
    await Promise.resolve();

    // The optimistic skeleton replaces the catalog row immediately. Its
    // timestamp must remain the catalog timestamp, not the time of selection.
    expect(orch.threadList().map((row) => row.threadId)).toEqual([
      "recent",
      "older",
    ]);

    release();
    await opening;
    expect(orch.threadList().map((row) => row.threadId)).toEqual([
      "recent",
      "older",
    ]);
  });

  it("hides a temporary catalog task until the user explicitly opens it", async () => {
    const { orch, client } = setup();
    orch.addProject("Selected workspace", "/repo");
    const historicalCwd = path.join(tmpdir(), "benchmark-checkout");
    client.catalogData = [thread("historical", historicalCwd)];
    await orch.refreshCatalog();

    expect(
      orch.threadList().find((row) => row.threadId === "historical"),
    ).toBeUndefined();

    await orch.openThread("historical");

    expect(client.resumedWith.at(-1)).toMatchObject({
      threadId: "historical",
      cwd: historicalCwd,
    });
    expect(
      orch.threadList().find((row) => row.threadId === "historical")?.projectId,
    ).toBeNull();
  });

  it("does not steal the view back when the user switches away mid-load", async () => {
    const { orch, store, file } = setup();
    const a = (await orch.newThread({}))!;
    store.flush();

    const fresh = setup({ storeFile: file });
    // b is created fresh in this session, so it loads instantly (fast path).
    const b = (await fresh.orch.newThread({}))!;

    let release!: () => void;
    fresh.client.gateResume = new Promise((r) => (release = r));
    const openingA = fresh.orch.openThread(a);
    await Promise.resolve();
    expect(fresh.orch.activeThreadId).toBe(a);

    // User switches to b while a's history is still gated.
    await fresh.orch.openThread(b);
    expect(fresh.orch.activeThreadId).toBe(b);

    // a's load now completes; it must not yank the view back to a.
    release();
    await openingA;
    expect(fresh.orch.activeThreadId).toBe(b);
    const lastActive = fresh.events
      .filter((e) => e.type === "activeThread")
      .at(-1) as { threadId: string } | undefined;
    expect(lastActive?.threadId).toBe(b);
  });

  it("re-opening a loaded thread does not resume again", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    store.flush();

    const fresh = setup({ storeFile: file });
    await fresh.orch.openThread(id); // cold: one resume
    await fresh.orch.openThread(id); // warm: fast path, no second resume
    expect(
      fresh.client.resumedWith.filter((r) => r.threadId === id),
    ).toHaveLength(1);
  });

  it("keeps completed turn duration when cold history is loaded", async () => {
    const { orch, store, file } = setup();
    const id = (await orch.newThread({}))!;
    store.flush();

    const fresh = setup({ storeFile: file });
    fresh.client.readThread = async () =>
      ({
        ...thread(id),
        turns: [
          {
            id: "turn-1",
            itemsView: { type: "full" },
            status: "completed",
            error: null,
            startedAt: 100,
            completedAt: 172,
            durationMs: 72_000,
            items: [
              {
                type: "commandExecution",
                id: "command-1",
                command: "npm test",
                cwd: "/repo",
                processId: null,
                status: "completed",
                commandActions: [],
                aggregatedOutput: "",
                exitCode: 0,
                durationMs: 1_000,
              },
            ],
          },
        ],
      }) as unknown as Thread;

    await fresh.orch.openThread(id);

    expect(fresh.orch.getThread(id)?.entries[0]).toMatchObject({
      kind: "item",
      turnId: "turn-1",
      turnDurationMs: 72_000,
    });
  });
});

describe("cross-project catalog", () => {
  it("assigns the most specific project, preserves explicit projectless, and includes archived", async () => {
    const { orch, client, store } = setup();
    const parent = orch.addProject("Monorepo", "/repo");
    const nested = orch.addProject("Nested app", "/repo/packages/app");
    store.update((state) => {
      state.workspaceRegistry.placements["outside-chat"] = {
        kind: "unassigned",
      };
    });
    client.catalogData = [
      thread("parent-chat", "/repo/tools"),
      thread("parent-chat", "/repo/tools"),
      thread("nested-chat", "/repo/packages/app/src"),
      thread("outside-chat", "/outside"),
    ];
    client.catalogArchivedData = [thread("archived-chat", "/repo")];

    await orch.refreshCatalog();

    const rows = new Map(orch.threadList().map((row) => [row.threadId, row]));
    expect(rows.get("parent-chat")?.projectId).toBe(parent.id);
    expect(rows.get("nested-chat")?.projectId).toBe(nested.id);
    expect(rows.get("outside-chat")?.projectId).toBeNull();
    expect(rows.get("archived-chat")).toMatchObject({
      projectId: parent.id,
      archived: true,
    });
    expect(
      orch.threadList().filter((row) => row.threadId === "parent-chat"),
    ).toHaveLength(1);
  });

  it("keeps an explicit project owner when a worktree cwd is outside its root", async () => {
    const { orch, store } = setup();
    const project = orch.addProject("Repo", "/repo");
    const id = (await orch.newThread({
      cwd: "/repo",
      projectId: project.id,
      useWorktree: true,
    }))!;

    expect(
      orch.threadList().find((row) => row.threadId === id)?.projectId,
    ).toBe(project.id);
    expect(orch.getThread(id)?.cwd).not.toBe("/repo");
    expect(store.get().workspaceRegistry.placements[id]).toEqual({
      kind: "registered",
      workspaceId: project.id,
      navigationRoot: "/repo",
    });
  });

  it("keeps explicit ownership stable when a nested project is added", async () => {
    const { orch, store } = setup();
    const parent = orch.addProject("Monorepo", "/repo");
    const id = (await orch.newThread({ cwd: "/repo/packages/app" }))!;
    expect(orch.getThread(id)?.projectId).toBe(parent.id);
    expect(store.get().workspaceRegistry.placements[id]).toMatchObject({
      kind: "registered",
      workspaceId: parent.id,
    });

    orch.addProject("Nested app", "/repo/packages/app");

    expect(orch.getThread(id)?.projectId).toBe(parent.id);
  });

  it("repairs a persisted owner that does not contain the conversation root", async () => {
    const { orch, client, git, store } = setup();
    const first = orch.addProject("First", "/work/first");
    const second = orch.addProject("Second", "/work/second");
    store.update((state) => {
      state.workspaceRegistry.placements.misplaced = {
        kind: "registered",
        workspaceId: first.id,
        navigationRoot: "/work/second",
      };
    });
    git.projectRoots.set("/work/second", "/work/second");
    client.catalogData = [thread("misplaced", "/work/second")];

    await orch.refreshCatalog();

    expect(store.get().workspaceRegistry.placements.misplaced).toEqual({
      kind: "registered",
      workspaceId: second.id,
      navigationRoot: "/work/second",
    });
    expect(orch.threadList()[0]?.projectId).toBe(second.id);
  });

  it("imports historical roots and persists their inferred assignments", async () => {
    const { orch, client, git, store } = setup();
    git.projectRoots.set("/work/evalfactory", "/work/evalfactory");
    git.projectRoots.set("/work/hobby", "/work/hobby");
    git.projectRoots.set("/work/hobby/public_staging", "/work/hobby");
    client.catalogData = [
      thread("eval-1", "/work/evalfactory"),
      thread("eval-2", "/work/evalfactory"),
      thread("hobby-1", "/work/hobby"),
      thread("hobby-nested", "/work/hobby/public_staging"),
    ];

    await orch.refreshCatalog();

    const projects = store.get().workspaceRegistry.workspaces;
    const evalProject = projects.find((project) =>
      project.roots.includes("/work/evalfactory"),
    );
    const hobbyProject = projects.find((project) =>
      project.roots.includes("/work/hobby"),
    );
    expect(evalProject?.label).toBe("evalfactory");
    expect(hobbyProject?.label).toBe("hobby");
    expect(store.get().workspaceRegistry.placements).toMatchObject({
      "eval-1": { kind: "registered", workspaceId: evalProject?.id },
      "eval-2": { kind: "registered", workspaceId: evalProject?.id },
      "hobby-1": { kind: "registered", workspaceId: hobbyProject?.id },
      "hobby-nested": {
        kind: "registered",
        workspaceId: hobbyProject?.id,
      },
    });
    expect(
      projects.some((project) =>
        project.roots.includes("/work/hobby/public_staging"),
      ),
    ).toBe(false);
    expect(orch.threadList().every((row) => row.projectId !== null)).toBe(true);
  });

  it("replaces stale workspace buckets with repository projects and Recents", async () => {
    const { orch, client, git, store } = setup();
    const internalRoot = path.join(
      homedir(),
      "Library",
      "Application Support",
      "CODEXDESK",
      "projects",
      "legacy",
      "git",
      "store.git",
    );
    const generatedRoot = path.join(
      homedir(),
      "Documents",
      "Codex",
      "2026-07-16",
      "one-off-task",
    );
    store.update((state) => {
      state.workspaceRegistry = {
        workspaces: [
          {
            id: "broad",
            label: "work",
            roots: ["/work"],
            selectedRoot: "/work",
            registeredAt: 0,
          },
          {
            id: "internal",
            label: "store.git",
            roots: [internalRoot],
            selectedRoot: internalRoot,
            registeredAt: 0,
          },
          {
            id: "generated",
            label: "one-off-task",
            roots: [generatedRoot],
            selectedRoot: generatedRoot,
            registeredAt: Date.now(),
          },
        ],
        activeWorkspaceId: "broad",
        placements: {
          alpha: {
            kind: "registered",
            workspaceId: "broad",
            navigationRoot: "/work/alpha",
          },
          internal: {
            kind: "registered",
            workspaceId: "internal",
            navigationRoot: internalRoot,
          },
          generated: {
            kind: "registered",
            workspaceId: "generated",
            navigationRoot: generatedRoot,
          },
        },
        dismissedRoots: [],
      };
    });
    git.projectRoots.set("/work/alpha", "/work/alpha");
    git.projectRoots.set("/work/beta", "/work/beta");
    client.catalogData = [
      thread("alpha", "/work/alpha"),
      thread("beta", "/work/beta"),
      thread("internal", internalRoot),
      thread("generated", generatedRoot),
    ];

    await orch.refreshCatalog();

    const registry = store.get().workspaceRegistry;
    expect(registry.activeWorkspaceId).toBeNull();
    expect(
      registry.workspaces.map((workspace) => workspace.label).sort(),
    ).toEqual(["alpha", "beta"]);
    expect(
      orch.threadList().find((row) => row.threadId === "internal"),
    ).toBeUndefined();
    expect(
      orch.threadList().find((row) => row.threadId === "generated"),
    ).toMatchObject({ projectId: null });
    expect(
      orch
        .threadList()
        .filter((row) => ["alpha", "beta"].includes(row.threadId))
        .every((row) => row.projectId !== null),
    ).toBe(true);
  });

  it("maps a historical linked worktree back to its source project", async () => {
    const { orch, client, git, store } = setup();
    const project = orch.addProject("Eval", "/work/evalfactory");
    const worktree = "/wt/legacy-thread";
    git.projectRoots.set(worktree, "/work/evalfactory");
    store.update((state) => {
      state.threads["legacy-worktree"] = {
        draft: "",
        outbox: { entries: [] },
        pinned: false,
        name: null,
        cwd: worktree,
        worktreePath: worktree,
        updatedAtMs: 1,
      };
    });
    client.catalogData = [thread("legacy-worktree", worktree)];

    await orch.refreshCatalog();

    expect(orch.threadList()[0]?.projectId).toBe(project.id);
    expect(store.get().workspaceRegistry.placements["legacy-worktree"]).toEqual(
      {
        kind: "registered",
        workspaceId: project.id,
        navigationRoot: "/work/evalfactory",
      },
    );
  });

  it("does not import temp roots and does not re-import a removed project", async () => {
    const { orch, client, store } = setup();
    client.catalogData = [
      thread("temporary", path.join(tmpdir(), "run-1")),
      thread(
        "stale-worktree",
        "/Users/me/Library/Application Support/CodexDesk/worktrees/4cd9390b",
      ),
      thread(
        "generated",
        "/Users/me/Library/Application Support/OtherTool/cache/session-1dfaecc7",
      ),
    ];
    await orch.refreshCatalog();
    expect(orch.threadList().every((row) => row.projectId === null)).toBe(true);

    const project = orch.addProject("Workspace", "/work/remove-me");
    orch.removeProject(project.id);
    client.catalogData = [thread("removed-root", "/work/remove-me")];
    await orch.refreshCatalog();

    expect(
      store
        .get()
        .workspaceRegistry.workspaces.some((candidate) =>
          candidate.roots.includes("/work/remove-me"),
        ),
    ).toBe(false);
    expect(
      orch.threadList().find((row) => row.threadId === "removed-root")
        ?.projectId,
    ).toBeNull();
  });

  it("paginates beyond the first hundred catalog rows", async () => {
    const { orch, client } = setup();
    client.catalogData = Array.from({ length: 205 }, (_, index) =>
      thread(`chat-${index}`, `/repo/${index}`),
    );

    await orch.refreshCatalog();

    expect(
      orch.threadList().filter((row) => row.threadId.startsWith("chat-")),
    ).toHaveLength(205);
  });
});

describe("archive and delete", () => {
  // A thread with no turns has no rollout on disk, so app-server answers
  // `no rollout found`. The row stayed visible and the user was shown an
  // error for doing something reasonable.
  it("archives locally when the server has no rollout", async () => {
    const { orch, client, events } = setup();
    const id = (await orch.newThread({}))!;
    client.archiveError = new Error("no rollout found for thread");

    await orch.archiveThread(id, true);

    expect(orch.getThread(id)!.archived).toBe(true);
    expect(orch.threadList().find((t) => t.threadId === id)?.archived).toBe(
      true,
    );
    const errors = events.filter(
      (e) => e.type === "log" && e.level === "error",
    );
    expect(errors).toHaveLength(0);
  });

  it("reports a genuine archive failure", async () => {
    const { orch, client, events } = setup();
    const id = (await orch.newThread({}))!;
    client.archiveError = new Error("database is locked");

    await orch.archiveThread(id, true);

    expect(orch.getThread(id)!.archived).toBe(false);
    expect(
      events.some(
        (e) => e.type === "log" && /database is locked/.test(e.message),
      ),
    ).toBe(true);
  });

  it("removes a deleted thread from state and pins even when delete fails", async () => {
    const { orch, client, store } = setup();
    const id = (await orch.newThread({}))!;
    orch.pinThread(id, true);
    expect(store.get().pinnedOrder).toContain(id);

    client.deleteThread = async () => {
      throw new Error("no such table: agent_jobs");
    };
    await orch.deleteThread(id);

    expect(orch.getThread(id)).toBeUndefined();
    expect(store.get().pinnedOrder).not.toContain(id);
    expect(store.get().threads[id]).toBeUndefined();
  });
});

describe("turn state", () => {
  /**
   * Retries were written to `lastError`, a single string the next error
   * overwrites and no completed turn clears. Five reconnects showed one
   * banner and left no trace, so a turn slowed by a flaky connection looked
   * identical to one that was simply slow.
   */
  it("records a retryable error as a transcript row, not a banner", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;

    orch.handleEvent({
      type: "turnError",
      threadId: id,
      error: { message: "Transport retry scheduled" } as never,
      willRetry: true,
    });
    orch.handleEvent({
      type: "turnError",
      threadId: id,
      error: { message: "Transport retry scheduled again" } as never,
      willRetry: true,
    });

    const retries = orch
      .getThread(id)!
      .entries.filter((e) => e.kind === "retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({
      message: "Transport retry scheduled",
      attempt: null,
      max: null,
    });
    expect(retries[1]).toMatchObject({
      message: "Transport retry scheduled again",
      attempt: null,
      max: null,
    });
    // A recovered reconnect is not a thread-level failure.
    expect(orch.getThread(id)!.lastError).toBeNull();
    expect(orch.getThread(id)!.run.kind).not.toBe("failed");
  });

  it("still fails the thread when the error is terminal", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;

    orch.handleEvent({
      type: "turnError",
      threadId: id,
      error: { message: "context window exceeded" } as never,
      willRetry: false,
    });

    expect(orch.getThread(id)!.lastError).toBe("context window exceeded");
    expect(orch.getThread(id)!.run.kind).toBe("failed");
    expect(
      orch.getThread(id)!.entries.filter((e) => e.kind === "retry"),
    ).toHaveLength(0);
  });

  it("keeps an arbitrary retry message rather than dropping it", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;

    orch.handleEvent({
      type: "turnError",
      threadId: id,
      error: { message: "Server is busy, reconnecting" } as never,
      willRetry: true,
    });

    const retry = orch.getThread(id)!.entries.find((e) => e.kind === "retry");
    expect(retry).toMatchObject({
      attempt: null,
      max: null,
      message: "Server is busy, reconnecting",
    });
  });

  it("marks a background thread unread but not the visible one", async () => {
    const { orch } = setup();
    const a = (await orch.newThread({}))!;
    const b = (await orch.newThread({}))!;
    await orch.openThread(a);

    orch.handleEvent({
      type: "turnCompleted",
      threadId: b,
      turn: { id: "x", status: "completed" } as never,
    });
    orch.handleEvent({
      type: "turnCompleted",
      threadId: a,
      turn: { id: "y", status: "completed" } as never,
    });

    expect(orch.getThread(b)!.unread).toBe(true);
    expect(orch.getThread(a)!.unread).toBe(false);
  });

  it("routes deltas to the right thread's buffers", async () => {
    const { orch } = setup();
    const a = (await orch.newThread({}))!;
    const b = (await orch.newThread({}))!;

    orch.handleEvent({
      type: "itemDelta",
      threadId: a,
      itemId: "i1",
      kind: "agentMessage",
      index: 0,
      delta: "hello ",
    });
    orch.handleEvent({
      type: "itemDelta",
      threadId: b,
      itemId: "i1",
      kind: "agentMessage",
      index: 0,
      delta: "different",
    });
    orch.handleEvent({
      type: "itemDelta",
      threadId: a,
      itemId: "i1",
      kind: "agentMessage",
      index: 0,
      delta: "world",
    });

    expect(orch.getThread(a)!.deltas.i1!.agentMessage![0]).toBe("hello world");
    expect(orch.getThread(b)!.deltas.i1!.agentMessage![0]).toBe("different");
  });

  it("keeps reasoning streams separate per index", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;
    // contentIndex and summaryIndex are different counters; a flat buffer
    // interleaves them into nonsense.
    orch.handleEvent({
      type: "itemDelta",
      threadId: id,
      itemId: "r",
      kind: "reasoningText",
      index: 0,
      delta: "block zero ",
    });
    orch.handleEvent({
      type: "itemDelta",
      threadId: id,
      itemId: "r",
      kind: "reasoningText",
      index: 1,
      delta: "block one",
    });
    orch.handleEvent({
      type: "itemDelta",
      threadId: id,
      itemId: "r",
      kind: "reasoningSummary",
      index: 0,
      delta: "summary",
    });

    const streams = orch.getThread(id)!.deltas.r!;
    expect(streams.reasoningText![0]).toBe("block zero ");
    expect(streams.reasoningText![1]).toBe("block one");
    expect(streams.reasoningSummary![0]).toBe("summary");
  });

  it("keeps the turn diff for a worktree thread, so both scopes exist", async () => {
    // This used to assert the opposite: the turn diff was *discarded* for
    // worktree threads on the grounds that their diff comes from git. That
    // conflated the two scopes and left "what did the agent just do"
    // unanswerable for exactly the threads where it is asked (§7.1).
    const { orch } = setup();
    const id = (await orch.newThread({ useWorktree: true }))!;

    orch.handleEvent({ type: "diff", threadId: id, diff: "just this turn" });

    expect(orch.getThread(id)!.diff).toBe("just this turn");
  });

  it("does not let the turn diff clobber the computed session diff", async () => {
    // The invariant the old test was really protecting: the session scope is
    // computed from git and must not be replaced by a turn diff. It now lives
    // in `changes`, which is scope-specific, rather than in `diff`.
    const { orch, git, events } = setup();
    git.sessionDiff = async () => ({
      parsed: {
        files: [
          {
            path: "session-only.ts",
            oldPath: null,
            status: "modified" as const,
            additions: 1,
            deletions: 0,
            suppressed: false,
            suppressedReason: null,
            hunks: [],
          },
        ],
        additions: 1,
        deletions: 0,
      },
      raw: "",
    });
    const id = (await orch.newThread({ useWorktree: true }))!;
    orch.handleEvent({ type: "diff", threadId: id, diff: "just this turn" });

    await orch.refreshChanges(id);
    const ev = events.filter((e) => e.type === "changes").at(-1) as
      { changes: { scope: string; files: { path: string }[] } } | undefined;
    expect(ev?.changes.scope).toBe("session");
    expect(ev?.changes.files.map((f) => f.path)).toEqual(["session-only.ts"]);
  });
});

describe("workspace", () => {
  it("rejects a workspace that cannot be canonicalized", async () => {
    const events: AppEvent[] = [];
    const store = new Store(
      path.join(mkdtempSync(path.join(tmpdir(), "codexdesk-ws-")), "s.json"),
    );
    store.load();
    const orch = new Orchestrator({
      store,
      emit: (ev) => events.push(ev),
      notify: () => {},
      worktreeContainer: "/wt",
      canonicalize: () => {
        throw new Error("ENOENT");
      },
    });

    expect(await orch.useWorkspace("/nope")).toBe(false);
    expect(orch.workspace).toBeNull();
  });

  it("records recents most-recent-first without duplicates", async () => {
    const { orch, store } = setup();
    await orch.useWorkspace("/a");
    await orch.useWorkspace("/b");
    await orch.useWorkspace("/a");
    expect(store.get().recents.slice(0, 2)).toEqual(["/a", "/b"]);
  });
});

describe("@-mention search", () => {
  // Typing a bare `@` must offer suggestions. `fuzzyFileSearch` returns
  // nothing for an empty query (it is a matcher, not a lister, verified
  // against 0.144.4), so the empty case lists the root directory instead.
  it("lists the root's files on an empty query without calling the server", async () => {
    const listDir = async (dir: string) => [
      { path: `${dir}/a.ts`, file_name: "a.ts", root: dir },
      { path: `${dir}/.git`, file_name: ".git", root: dir },
    ];
    const { orch, client } = setup({ listDir });
    await orch.newThread({});

    const results = (await orch.searchFiles("")) as { file_name: string }[];

    expect(client.searchedFor).toHaveLength(0); // server not consulted
    // `.git` is filtered out, so only real files remain.
    expect(results.map((r) => r.file_name)).toEqual(["a.ts"]);
  });

  it("routes a non-empty query to fuzzyFileSearch and drops .git hits", async () => {
    const { orch, client } = setup();
    await orch.newThread({});

    const results = (await orch.searchFiles("match")) as {
      file_name: string;
    }[];

    expect(client.searchedFor).toEqual(["match"]);
    expect(results.map((r) => r.file_name)).toEqual(["match.ts"]);
  });

  it("accepts a known new-chat root and rejects an arbitrary IPC path", async () => {
    const { orch, client } = setup();
    await orch.newThread({});

    await orch.searchFiles("first", "/repo");
    await orch.searchFiles("second", "/tmp/not-a-project");

    expect(client.searchedRoots).toEqual([["/repo"], ["/repo"]]);
  });

  it("returns nothing when there is no workspace", async () => {
    const { orch } = setup();
    orch.workspace = null;
    expect(await orch.searchFiles("")).toEqual([]);
  });
});

describe("slash command actions", () => {
  it("starts compaction through the dedicated protocol verb", async () => {
    const { orch, client } = setup();
    const threadId = (await orch.newThread({}))!;

    expect(await orch.compactThread(threadId)).toBe(true);
    expect(client.compacted).toEqual([threadId]);
  });

  it("reports a compaction failure without claiming success", async () => {
    const { orch, client, events } = setup();
    const threadId = (await orch.newThread({}))!;
    client.compactError = new Error("cannot compact now");

    expect(await orch.compactThread(threadId)).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "log" && event.message.includes("cannot compact now"),
      ),
    ).toBe(true);
  });
});

describe("sign-in (§8.5)", () => {
  it("opens the browser and waits, rather than claiming success", async () => {
    // `account/login/start` only *starts* the ChatGPT flow. Treating its
    // response as the outcome would report a sign-in that has not happened.
    const opened: string[] = [];
    const { orch, client, events } = setup({
      openExternal: (u) => opened.push(u),
    });

    await orch.startLogin({ kind: "chatgpt" });

    expect(client.loginStarts).toEqual([{ type: "chatgpt" }]);
    expect(opened).toEqual(["https://auth.example.invalid/start"]);
    const state = events.filter((e) => e.type === "login").at(-1) as
      { state: { kind: string; authUrl?: string } } | undefined;
    expect(state?.state).toMatchObject({
      kind: "awaitingBrowser",
      authUrl: "https://auth.example.invalid/start",
    });
  });

  it("settles only when account/login/completed arrives", async () => {
    const { orch, events } = setup({ openExternal: () => {} });
    await orch.startLogin({ kind: "chatgpt" });

    orch.onLoginCompleted(true, null);
    // `onLoginCompleted` is called from a notification handler, so it cannot
    // be async; the auth re-read it kicks off settles on the next tick.
    await new Promise((r) => setTimeout(r, 0));

    const login = events.filter((e) => e.type === "login").at(-1) as {
      state: { kind: string };
    };
    expect(login.state.kind).toBe("idle");
    // And auth is re-read rather than assumed.
    const auth = events.filter((e) => e.type === "auth").at(-1) as
      { state: { kind: string } } | undefined;
    expect(auth?.state.kind).toBe("signedIn");
  });

  it("surfaces the server's reason when a login fails", async () => {
    const { orch, events } = setup({ openExternal: () => {} });
    await orch.startLogin({ kind: "chatgpt" });

    orch.onLoginCompleted(false, "the browser flow timed out");

    const login = events.filter((e) => e.type === "login").at(-1) as {
      state: { kind: string; message?: string };
    };
    expect(login.state).toMatchObject({
      kind: "failed",
      message: "the browser flow timed out",
    });
  });

  it("cancels an in-flight browser login by its loginId", async () => {
    const { orch, client } = setup({ openExternal: () => {} });
    await orch.startLogin({ kind: "chatgpt" });

    await orch.cancelLogin();

    expect(client.cancelled).toEqual(["login-1"]);
    expect(orch.login.kind).toBe("idle");
  });

  it("signs in immediately with an API key", async () => {
    // No browser round-trip: success is the response itself.
    const { orch, client, events } = setup();
    await orch.startLogin({ kind: "apiKey", apiKey: "sk-test" });

    expect(client.loginStarts).toEqual([{ type: "apiKey", apiKey: "sk-test" }]);
    expect(orch.login.kind).toBe("idle");
    expect(events.filter((e) => e.type === "auth").length).toBeGreaterThan(0);
  });

  it("reports a rejected API key instead of silently doing nothing", async () => {
    const { orch, client } = setup();
    client.apiKeyError = new Error("invalid api key");

    await orch.startLogin({ kind: "apiKey", apiKey: "sk-bad" });

    expect(orch.login).toMatchObject({ kind: "failed" });
    expect((orch.login as { message: string }).message).toContain("invalid");
  });

  it("re-reads auth after signing out", async () => {
    const { orch, events } = setup();
    await orch.logout();

    const auth = events.filter((e) => e.type === "auth").at(-1) as {
      state: { kind: string };
    };
    expect(auth.state.kind).toBe("signedOut");
  });
});

describe("changes, delivery, and comments (milestone 3)", () => {
  /** A thread with a worktree, which is what §7 features require. */
  async function threadWithWorktree() {
    const s = setup();
    const id = (await s.orch.newThread({ useWorktree: true }))!;
    return { ...s, id };
  }

  it("reports the turn scope for a thread with no worktree", async () => {
    // Without a base commit there is nothing honest to diff against, so the
    // pane must not claim a session scope it cannot compute.
    const { orch, events } = setup();
    const id = (await orch.newThread({ useWorktree: false }))!;
    await orch.refreshChanges(id);

    const ev = events.filter((e) => e.type === "changes").at(-1);
    expect(ev).toMatchObject({ changes: { scope: "turn", baseSha: null } });
  });

  it("emits the session diff against the recorded base sha", async () => {
    const { orch, events, id } = await threadWithWorktree();
    await orch.refreshChanges(id);

    const ev = events.filter((e) => e.type === "changes").at(-1) as
      { changes: { scope: string; baseSha: string | null } } | undefined;
    expect(ev?.changes.scope).toBe("session");
    // The base is the commit the worktree was branched from, not HEAD.
    expect(ev?.changes.baseSha).toBe(orch.getThread(id)?.worktreeBaseSha);
  });

  it("surfaces a diff failure instead of reporting no changes", async () => {
    // Showing an empty pane for a diff we failed to compute would tell the
    // user their work vanished.
    const { orch, git, events, id } = await threadWithWorktree();
    git.sessionDiff = async () => {
      throw new Error("fatal: bad object");
    };
    await orch.refreshChanges(id);

    const ev = events.filter((e) => e.type === "changes").at(-1) as
      { changes: { error: string | null } } | undefined;
    expect(ev?.changes.error).toContain("bad object");
  });

  it("reports a delivery issue rather than committing through it", async () => {
    const { orch, git, events, id } = await threadWithWorktree();
    git.prepareDelivery = async (worktreePath: string, _base: string) => ({
      next: "inspect" as const,
      repoRoot: worktreePath,
      branch: "main",
      defaultBranch: "main",
      remote: "origin",
      upstream: null,
      files: ["a.ts"],
      changes: ["a.ts"].filter(Boolean).map((p: string) => ({
        path: p,
        untracked: false,
        staged: false,
        unstaged: true,
      })),
      additions: 1,
      deletions: 0,
      committedSha: null,
      pushed: false,
      prUrl: null,
      issue: {
        stage: "inspect" as const,
        cause: "unsafeBranch" as const,
        recovery: "chooseBranch" as const,
        detail: "on the default branch",
      },
    });
    let committed = false;
    git.commit = async () => {
      committed = true;
      return { ok: true as const, value: { sha: "x" } };
    };

    await orch.commitChanges(id, "a message");
    expect(committed).toBe(false);
    const ev = events.filter((e) => e.type === "delivery").at(-1) as
      { state: { issue: { cause: string } | null } } | undefined;
    expect(ev?.state.issue?.cause).toBe("unsafeBranch");
  });

  it("re-observes the repository before committing", async () => {
    // The user may have edited since the pane rendered; committing a stale
    // file list would miss work or include something they reverted.
    const { orch, git, id } = await threadWithWorktree();
    const seen: string[][] = [];
    git.commit = async (_wt: string, files: string[]) => {
      seen.push(files);
      return { ok: true as const, value: { sha: "sha1" } };
    };
    git.prepareDelivery = async (worktreePath: string, _base: string) => ({
      next: "commit" as const,
      repoRoot: worktreePath,
      branch: "codexdesk/x",
      defaultBranch: "main",
      remote: "origin",
      upstream: null,
      files: ["fresh.ts"],
      changes: ["fresh.ts"].filter(Boolean).map((p: string) => ({
        path: p,
        untracked: false,
        staged: false,
        unstaged: true,
      })),
      additions: 1,
      deletions: 0,
      committedSha: null,
      pushed: false,
      prUrl: null,
      issue: null,
    });

    await orch.commitChanges(id, "message");
    expect(seen).toEqual([["fresh.ts"]]);
  });

  it("marks the flow busy while a step runs", async () => {
    const { orch, events, id } = await threadWithWorktree();
    await orch.commitChanges(id, "message");
    const busyStates = events
      .filter((e) => e.type === "delivery")
      .map((e) => (e as { state: { busy: boolean } }).state.busy);
    // At least one busy=true before settling back to false.
    expect(busyStates).toContain(true);
    expect(busyStates.at(-1)).toBe(false);
  });

  it("returns the pull request url and marks the flow done", async () => {
    const { orch, id } = await threadWithWorktree();
    const url = await orch.createPullRequest(id, "Title", "Body");
    expect(url).toBe("https://example.invalid/pull/1");
  });

  it("reports a pull request issue without claiming success", async () => {
    const { orch, git, events, id } = await threadWithWorktree();
    git.createDraftPr = async () => ({
      ok: false as const,
      issue: {
        stage: "pullRequest" as const,
        cause: "missingTool" as const,
        recovery: "unavailable" as const,
        detail: "gh is not installed",
      },
    });

    expect(await orch.createPullRequest(id, "T", "B")).toBeNull();
    const ev = events.filter((e) => e.type === "delivery").at(-1) as
      | { state: { issue: { cause: string } | null; prUrl: string | null } }
      | undefined;
    expect(ev?.state.issue?.cause).toBe("missingTool");
    expect(ev?.state.prUrl).toBeNull();
  });

  it("switches between the turn and session scopes", async () => {
    const { orch, git, events, id } = await threadWithWorktree();
    git.sessionDiff = async () => ({
      parsed: {
        files: [
          {
            path: "whole-session.ts",
            oldPath: null,
            status: "modified" as const,
            additions: 3,
            deletions: 0,
            suppressed: false,
            suppressedReason: null,
            hunks: [],
          },
        ],
        additions: 3,
        deletions: 0,
      },
      raw: "",
    });
    // A turn diff arrives as unified text, exactly as app-server streams it.
    orch.handleEvent({
      type: "diff",
      threadId: id,
      diff: [
        "diff --git a/just-this-turn.ts b/just-this-turn.ts",
        "--- a/just-this-turn.ts",
        "+++ b/just-this-turn.ts",
        "@@ -1 +1,2 @@",
        " keep",
        "+added by the last turn",
      ].join("\n"),
    });

    const lastChanges = () =>
      events.filter((e) => e.type === "changes").at(-1) as {
        changes: {
          scope: string;
          sessionAvailable: boolean;
          files: { path: string }[];
        };
      };

    await orch.refreshChanges(id);
    expect(lastChanges().changes).toMatchObject({
      scope: "session",
      sessionAvailable: true,
    });
    expect(lastChanges().changes.files.map((f) => f.path)).toEqual([
      "whole-session.ts",
    ]);

    orch.setChangesScope(id, "turn");
    await new Promise((r) => setTimeout(r, 0));
    expect(lastChanges().changes.scope).toBe("turn");
    expect(lastChanges().changes.files.map((f) => f.path)).toEqual([
      "just-this-turn.ts",
    ]);

    orch.setChangesScope(id, "session");
    await new Promise((r) => setTimeout(r, 0));
    expect(lastChanges().changes.files.map((f) => f.path)).toEqual([
      "whole-session.ts",
    ]);
  });

  it("offers only the turn scope without a worktree", async () => {
    // No base commit means no session diff can be computed; saying
    // `sessionAvailable: false` is what hides the control rather than
    // offering a scope that would come back empty.
    const { orch, events } = setup();
    const id = (await orch.newThread({ useWorktree: false }))!;
    await orch.refreshChanges(id);

    const ev = events.filter((e) => e.type === "changes").at(-1) as {
      changes: { scope: string; sessionAvailable: boolean };
    };
    expect(ev.changes).toMatchObject({
      scope: "turn",
      sessionAvailable: false,
    });
  });

  it("keeps diff comments across a restart", async () => {
    // §7.3 requires durable comment drafts. `persist()` was called but wrote
    // every field *except* comments, so a relaunch silently discarded them.
    const { orch, store, git, file, id } = await threadWithWorktree();
    git.sessionDiff = async () => ({
      parsed: {
        files: [
          {
            path: "a.ts",
            oldPath: null,
            status: "modified" as const,
            additions: 1,
            deletions: 0,
            suppressed: false,
            suppressedReason: null,
            hunks: [
              {
                hunkId: "a.ts:0",
                hunkIndex: 0,
                header: "@@ -1 +1,2 @@",
                oldStart: 1,
                oldCount: 1,
                newStart: 1,
                newCount: 2,
                context: "",
                lines: [
                  {
                    kind: "add" as const,
                    text: "added line",
                    leftLine: null,
                    rightLine: 1,
                  },
                ],
              },
            ],
          },
        ],
        additions: 1,
        deletions: 0,
      },
      raw: "",
    });

    await orch.refreshChanges(id);
    orch.addReviewNote(id, {
      filePath: "a.ts",
      side: "right",
      startLine: 1,
      endLine: 1,
      text: "please rename this",
    });
    expect(orch.getThread(id)?.reviewNotes).toHaveLength(1);
    store.flush();

    // Relaunch against the same state file.
    const fresh = setup({ storeFile: file });
    await fresh.orch.openThread(id);

    const restored = fresh.orch.getThread(id)?.reviewNotes ?? [];
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      body: "please rename this",
      anchor: {
        path: "a.ts",
        context: { selected: ["added line"] },
      },
    });
  });

  it("proposes an editable commit message from the changed files", async () => {
    const { orch, git, id } = await threadWithWorktree();
    git.prepareDelivery = async (worktreePath: string, _base: string) => ({
      next: "commit" as const,
      repoRoot: worktreePath,
      branch: "codexdesk/x",
      defaultBranch: "main",
      remote: "origin",
      upstream: null,
      files: ["src/a.ts", "src/b.ts"],
      changes: ["src/a.ts", "src/b.ts"].filter(Boolean).map((p: string) => ({
        path: p,
        untracked: false,
        staged: false,
        unstaged: true,
      })),
      additions: 2,
      deletions: 0,
      committedSha: null,
      pushed: false,
      prUrl: null,
      issue: null,
    });
    await orch.prepareDelivery(id);
    expect(orch.proposeCommitMessage(id)).toBe("Update 2 files in src");
  });
});

/**
 * Steering and the queue (§8.1).
 *
 * The queue's invariants are all about *not losing the user's message*: a
 * refused steer, a turn that ends mid-call, and a bounded queue each have a
 * wrong behaviour that silently discards typed text.
 */
describe("steering and the message queue (§8.1)", () => {
  it("steers into the running turn instead of starting a new one", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "actually, use tabs");

    await orch.steerNow(id);

    expect(client.steered.at(-1)?.input[0]).toMatchObject({
      text: "actually, use tabs",
    });
    expect(client.steered.at(-1)?.expectedTurnId).toBe(`turn-${id}`);
    // Steering must not also start a turn — that would run the message twice.
    expect(client.sent).toHaveLength(0);
    expect(outboxEntries(orch, id)).toHaveLength(0);
  });

  it("does not steer on its own when a message is queued", async () => {
    // Queueing and steering are separate actions: auto-injecting would empty
    // the queue as fast as the user filled it.
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "later, please");
    expect(client.steered).toHaveLength(0);
    expect(outboxEntries(orch, id)).toHaveLength(1);
  });

  it("keeps a refused message queued and says why, rather than erroring", async () => {
    // A review turn never accepts steering. Reporting that as a failure would
    // be wrong twice: it is expected, and the message still gets delivered at
    // turn end.
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "one more thing");

    client.steerError = Object.assign(new Error("rejected"), {
      data: { error: { activeTurnNotSteerable: { turnKind: "review" } } },
    });
    await orch.steerNow(id);

    expect(outboxEntries(orch, id)).toHaveLength(1);
    expect(outboxDispatch(orch, id)).toMatchObject({
      kind: "deferred",
      reason: "turnNotSteerable",
      detail: "review",
    });
    expect(orch.getThread(id)!.lastError).toBeNull();
  });

  it("delivers a refused message once the turn ends", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "deferred");
    client.steerError = Object.assign(new Error("rejected"), {
      data: { error: { activeTurnNotSteerable: { turnKind: "compact" } } },
    });
    await orch.steerNow(id);

    client.steerError = null;
    client.activeTurns.delete(id);
    await orch.drainQueue(id);

    expect(client.sent.at(-1)?.input[0]).toMatchObject({ text: "deferred" });
    expect(outboxEntries(orch, id)).toHaveLength(0);
  });

  it("keeps the message when the turn ends between the check and the steer", async () => {
    // The race the `expectedTurnId` precondition exists for. Losing the race
    // must cost a wait, not the message.
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "racy");

    // isTurnActive says yes, then the turn is gone by the time steer runs.
    const realSteer = client.steer.bind(client);
    client.steer = async (threadId, expectedTurnId, input) => {
      client.activeTurns.delete(threadId);
      return realSteer(threadId, expectedTurnId, input);
    };
    await orch.steerNow(id);

    expect(outboxEntries(orch, id)).toHaveLength(1);
    expect(outboxDispatch(orch, id)).toMatchObject({
      kind: "deferred",
      reason: "turnEnded",
    });
  });

  it("refuses to queue past the bound instead of growing without limit", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    for (let i = 0; i < 8; i++) await orch.sendMessage(id, `m${i}`);

    const res = await orch.sendMessage(id, "one too many");

    expect(res.error).toMatch(/full/);
    expect(outboxEntries(orch, id)).toHaveLength(8);
  });

  it("reorders the queue, since order decides what runs next", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "first");
    await orch.sendMessage(id, "second");

    const second = outboxEntries(orch, id)[1]!.id;
    orch.moveQueued(id, second, 0);

    expect(outboxEntries(orch, id).map((entry) => entry.text)).toEqual([
      "second",
      "first",
    ]);
  });

  it("clamps a move past the end rather than dropping the message", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "a");
    await orch.sendMessage(id, "b");

    const first = outboxEntries(orch, id)[0]!.id;
    orch.moveQueued(id, first, 99);

    expect(outboxEntries(orch, id).map((entry) => entry.text)).toEqual([
      "b",
      "a",
    ]);
  });

  it("edits a queued message in place, keeping its attachments", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    orch.addAttachment(id, {
      id: "a1",
      kind: "file",
      name: "notes.md",
      path: "/repo/notes.md",
    });
    client.activeTurns.add(id);
    await orch.sendMessage(id, "typo hree");

    const qid = outboxEntries(orch, id)[0]!.id;
    orch.editQueued(id, qid, "typo here");

    expect(outboxEntries(orch, id)[0]).toMatchObject({
      text: "typo here",
      assets: [{ name: "notes.md" }],
    });
  });

  it("treats an edit to empty as a removal", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "never mind");
    const qid = outboxEntries(orch, id)[0]!.id;

    orch.editQueued(id, qid, "   ");

    expect(outboxEntries(orch, id)).toHaveLength(0);
  });

  it("persists queue edits, so a restart does not resurrect old text", async () => {
    const { orch, client, store } = setup();
    const id = (await orch.newThread({}))!;
    client.activeTurns.add(id);
    await orch.sendMessage(id, "before");
    const qid = outboxEntries(orch, id)[0]!.id;
    orch.editQueued(id, qid, "after");

    expect(store.get().threads[id]!.outbox.entries[0]!.text).toBe("after");
  });

  it("carries a queued message's attachments into the steered input", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    orch.addAttachment(id, {
      id: "a1",
      kind: "image",
      name: "shot.png",
      path: "/tmp/shot.png",
    });
    client.activeTurns.add(id);
    await orch.sendMessage(id, "look at this");

    await orch.steerNow(id);

    expect(client.steered.at(-1)?.input).toMatchObject([
      { type: "localImage", path: "/tmp/shot.png" },
      { text: "look at this" },
    ]);
  });
});

/**
 * The plan surface (§8.3).
 *
 * `turn/plan/updated` says nothing about whether the turn finished, so the
 * main process has to mark that itself — a plan whose turn is over is a
 * record, not a forecast.
 */
describe("plan lifecycle (§8.3)", () => {
  it("marks the plan as ended when its own turn completes", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;
    orch.handleEvent({
      type: "plan",
      threadId: id,
      plan: {
        explanation: null,
        steps: [{ step: "do it", status: "pending" }],
        turnId: "t1",
        turnEnded: false,
      },
    });

    orch.handleEvent({
      type: "turnCompleted",
      threadId: id,
      turn: { id: "t1", status: "completed" } as never,
    });

    expect(orch.getThread(id)!.plan).toMatchObject({ turnEnded: true });
  });

  it("leaves a newer turn's plan alone when an older turn completes", async () => {
    // Turns can complete out of order relative to what the plan describes;
    // stamping the wrong plan would show a live plan as abandoned.
    const { orch } = setup();
    const id = (await orch.newThread({}))!;
    orch.handleEvent({
      type: "plan",
      threadId: id,
      plan: {
        explanation: null,
        steps: [{ step: "current work", status: "inProgress" }],
        turnId: "t2",
        turnEnded: false,
      },
    });

    orch.handleEvent({
      type: "turnCompleted",
      threadId: id,
      turn: { id: "t1", status: "completed" } as never,
    });

    expect(orch.getThread(id)!.plan).toMatchObject({ turnEnded: false });
  });
});

/**
 * The approval posture (§8.2).
 *
 * `approvalsReviewer` is taken at thread config time, so the only way a
 * change reaches a thread is on start, resume, or fork. Missing any of those
 * makes the setting a lie for that path.
 */
describe("approval posture (§8.2)", () => {
  it("defaults to asking the user", async () => {
    const { orch, client } = setup();
    await orch.newThread({});
    expect(client.startedWith.at(-1)?.approvalsReviewer).toBe("user");
  });

  it("carries the posture into a newly started thread", async () => {
    const { orch, client } = setup();
    orch.setApprovalsReviewer("auto_review");
    await orch.newThread({});
    expect(client.startedWith.at(-1)?.approvalsReviewer).toBe("auto_review");
  });

  it("re-sends the app's current posture on resume, not the thread's old one", async () => {
    // thread/resume re-accepts the whole config, so a thread created while
    // approvals were delegated must not stay delegated after the user
    // switches back.
    const { orch, client } = setup();
    orch.setApprovalsReviewer("auto_review");
    const id = (await orch.newThread({}))!;
    await orch.closeThread(id);

    orch.setApprovalsReviewer("user");
    await orch.openThread(id);

    expect(client.resumedWith.at(-1)?.approvalsReviewer).toBe("user");
  });

  it("persists the posture across a restart", async () => {
    const { orch, store } = setup();
    orch.setApprovalsReviewer("guardian_subagent");
    expect(store.get().approvalsReviewer).toBe("guardian_subagent");
  });
});

describe("model-scoped settings", () => {
  it("persists and sends the selected effort and service tier on every path", async () => {
    const { orch, client, store } = setup();
    orch.config = {
      ...orch.config,
      models: [
        {
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          description: "",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "" },
          ],
          defaultReasoningEffort: "high",
          serviceTiers: [
            { id: "fast", name: "Fast", description: "Faster responses" },
          ],
          defaultServiceTier: null,
          isDefault: true,
        } as never,
      ],
    };

    orch.setModel("gpt-test");
    orch.setReasoningEffort("high");
    orch.setServiceTier("fast");
    const id = (await orch.newThread({}))!;

    expect(client.startedWith.at(-1)).toMatchObject({
      model: "gpt-test",
      effort: "high",
      serviceTier: "fast",
    });
    await orch.sendMessage(id, "hello");
    expect(client.sent.at(-1)).toMatchObject({
      model: "gpt-test",
      effort: "high",
      serviceTier: "fast",
    });
    await orch.forkThread(id);
    expect(client.forkedWith.at(-1)).toMatchObject({
      model: "gpt-test",
      effort: "high",
      serviceTier: "fast",
    });
    await orch.closeThread(id);
    await orch.openThread(id);
    expect(client.resumedWith.at(-1)).toMatchObject({
      model: "gpt-test",
      effort: "high",
      serviceTier: "fast",
    });
    expect(store.get()).toMatchObject({
      currentModel: "gpt-test",
      currentReasoningEffort: "high",
      currentServiceTier: "fast",
    });
  });

  it("ignores a service tier the selected model does not offer", () => {
    const { orch, store } = setup();
    orch.config = {
      ...orch.config,
      models: [
        {
          id: "default-model",
          isDefault: true,
          serviceTiers: [{ id: "fast" }],
        } as never,
      ],
    };

    orch.setServiceTier("unknown");
    expect(orch.config.currentServiceTier).toBeNull();
    expect(store.get().currentServiceTier).toBeNull();
  });
});

/**
 * Approval modes.
 *
 * CodexDesk does not enforce anything here — codex core does, from the approval
 * policy and sandbox sent with the thread config and each turn. What these
 * pin down is that the posture the user chose is the posture actually sent,
 * on every path that can reach the server. A mode that silently fails to
 * travel is worse than no control at all: the user believes they are in read
 * only while the agent writes.
 */
describe("approval modes", () => {
  it("starts threads under the default posture", async () => {
    const { orch, client } = setup();
    await orch.newThread({});
    expect(client.startedWith.at(-1)).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("starts a new thread under the global default once changed", async () => {
    const { orch, client } = setup();
    orch.setApprovalMode(null, "read-only");
    await orch.newThread({});
    expect(client.startedWith.at(-1)).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
  });

  it("keeps a thread's own mode when the default changes", async () => {
    // The point of per-thread modes: a read-only thread stays read-only even
    // as the user works elsewhere under a wider posture.
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    orch.setApprovalMode(id, "read-only");
    orch.setApprovalMode(null, "full-access");

    await orch.sendMessage(id, "hello");
    expect(client.sent.at(-1)?.approvalPolicy).toBe("on-request");
    expect(client.sent.at(-1)?.sandboxPolicy).toMatchObject({
      type: "readOnly",
    });
  });

  it("applies a mode change to the thread already open", async () => {
    // `turn/start` takes the posture "for this turn and subsequent turns",
    // which is what makes the picker do what it appears to do rather than
    // quietly waiting for the next thread.
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    await orch.sendMessage(id, "first");
    expect(client.sent.at(-1)?.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
    });

    orch.setApprovalMode(id, "full-access");
    await orch.sendMessage(id, "second");
    expect(client.sent.at(-1)?.approvalPolicy).toBe("never");
    expect(client.sent.at(-1)?.sandboxPolicy).toMatchObject({
      type: "dangerFullAccess",
    });
  });

  it("re-sends the thread's own mode on resume, not the current default", async () => {
    // The opposite of how `approvalsReviewer` behaves, and deliberately so:
    // widening a thread the user had deliberately restricted, just because
    // they opened it again, is the failure this exists to prevent.
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    orch.setApprovalMode(id, "read-only");
    await orch.closeThread(id);

    orch.setApprovalMode(null, "full-access");
    await orch.openThread(id);

    expect(client.resumedWith.at(-1)).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
  });

  it("persists a thread's mode", async () => {
    const { orch, store } = setup();
    const id = (await orch.newThread({}))!;
    orch.setApprovalMode(id, "read-only");
    expect(store.get().threads[id]?.approvalMode).toBe("read-only");
  });

  it("persists the global default", async () => {
    const { orch, store } = setup();
    orch.setApprovalMode(null, "full-access");
    expect(store.get().approvalMode).toBe("full-access");
  });

  it("reports the resolved mode on the thread view", async () => {
    const { orch } = setup();
    const id = (await orch.newThread({}))!;
    // Unset threads follow the default rather than reporting nothing.
    expect(orch.toView(orch.getThread(id)!).approvalMode).toBe("auto");
    orch.setApprovalMode(id, "read-only");
    expect(orch.toView(orch.getThread(id)!).approvalMode).toBe("read-only");
  });

  it("carries the mode onto a fork", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    orch.setApprovalMode(id, "read-only");
    await orch.forkThread(id);
    expect(client.forkedWith.at(-1)).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
  });

  it("refuses a mode the operator forbids", async () => {
    // The renderer is not the security boundary. A stale window could still
    // hold a control for a mode an admin has since disabled.
    const { orch, client } = setup();
    orch.config = {
      ...orch.config,
      allowedApprovalModes: ["read-only", "auto"],
    };
    orch.setApprovalMode(null, "full-access");
    await orch.newThread({});
    expect(client.startedWith.at(-1)?.approvalPolicy).toBe("on-request");
  });

  it("narrows a saved mode an operator has since forbidden", async () => {
    const { orch, client } = setup();
    const id = (await orch.newThread({}))!;
    orch.setApprovalMode(id, "full-access");
    // The admin tightens policy after the thread was already saved.
    orch.config = {
      ...orch.config,
      allowedApprovalModes: ["read-only"],
    };

    await orch.sendMessage(id, "hello");
    expect(client.sent.at(-1)?.approvalPolicy).toBe("on-request");
    expect(client.sent.at(-1)?.sandboxPolicy).toMatchObject({
      type: "readOnly",
    });
  });
});

/**
 * Usage and reset credits (§8.6).
 *
 * The invariant that matters is the credit: it is a real, finite thing the
 * user earned, and spending two because they clicked twice is not recoverable
 * from the UI.
 */
describe("usage and reset credits (§8.6)", () => {
  it("reads usage on demand", async () => {
    const { orch, client } = setup();
    client.usage = {
      lifetimeTokens: 12_345,
      peakDailyTokens: 900,
      longestRunningTurnSec: 61,
      currentStreakDays: 3,
      longestStreakDays: 9,
      dailyBuckets: [{ startDate: "2026-07-01", tokens: 500 }],
    };
    expect(await orch.readUsage()).toMatchObject({ lifetimeTokens: 12_345 });
  });

  it("reports no usage rather than failing when the account has none", async () => {
    const { orch } = setup();
    expect(await orch.readUsage()).toBeNull();
  });

  it("spends one credit when the user clicks twice", async () => {
    const { orch, client } = setup();
    // Both in flight at once — the second must not mint a second key.
    const [a, b] = await Promise.all([
      orch.consumeResetCredit(),
      orch.consumeResetCredit(),
    ]);
    expect(client.redeemKeys).toHaveLength(1);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("allows another attempt after one finishes", async () => {
    const { orch, client } = setup();
    await orch.consumeResetCredit();
    await orch.consumeResetCredit();
    expect(client.redeemKeys).toHaveLength(2);
    // Two separate attempts, so two distinct keys.
    expect(new Set(client.redeemKeys).size).toBe(2);
  });

  it("reports a failed redemption rather than claiming success", async () => {
    const { orch, client } = setup();
    client.redeemFails = true;
    expect(await orch.consumeResetCredit()).toBe(false);
  });
});

/**
 * Capability surfaces (§4.5 / V2.4).
 *
 * The mapping is covered in `capabilities.test.ts`. What is left here is the
 * orchestration around it: optimistic writes that must roll back, and the
 * staleness guard on a refresh that can be fired from three places at once.
 */
describe("capabilities", () => {
  const skill = (path: string, enabled = true) => ({
    name: path.split("/").slice(-2)[0],
    description: "",
    displayName: null,
    shortDescription: null,
    defaultPrompt: null,
    path,
    scope: "repo" as const,
    enabled,
  });

  it("keeps skill parse errors so an absence is explainable", async () => {
    const { orch, client } = setup();
    client.listSkills = async () => ({
      skills: [skill("/repo/.agents/skills/ok/SKILL.md")],
      errors: [{ path: "/repo/.agents/skills/bad/SKILL.md", message: "x" }],
    });

    await orch.refreshSkills();
    expect(orch.config.skills.items).toHaveLength(1);
    expect(orch.config.skillErrors).toEqual([
      { path: "/repo/.agents/skills/bad/SKILL.md", message: "x" },
    ]);
  });

  it("passes forceReload only for an explicit refresh", async () => {
    const { orch, client } = setup();
    const calls: (boolean | undefined)[] = [];
    client.listSkills = async (_cwd, force) => {
      calls.push(force);
      return { skills: [], errors: [] };
    };
    await orch.refreshSkills();
    await orch.refreshSkills(true);
    // The `skills/changed` path must not re-scan disk: the server already
    // knows its cache is stale.
    expect(calls).toEqual([false, true]);
  });

  it("puts the toggle back when the skill write fails", async () => {
    const { orch, client } = setup();
    const p = "/repo/.agents/skills/ok/SKILL.md";
    client.listSkills = async () => ({
      skills: [skill(p, true)],
      errors: [],
    });
    await orch.refreshSkills();
    client.setSkillEnabled = async () => {
      throw new Error("read-only config");
    };

    await orch.setSkillEnabled(p, false);
    // Optimistic flip, then the re-list restores the truth — a toggle that
    // stays flipped after a failed write is a lie about what the agent loads.
    expect(orch.config.skills.items[0]!.enabled).toBe(true);
  });

  it("delegates plugin toggles to the capability port", async () => {
    const { orch, client } = setup();
    const writes: { pluginId: string; enabled: boolean }[] = [];
    client.setPluginEnabled = async (pluginId, enabled) => {
      writes.push({ pluginId, enabled });
    };
    await orch.setPluginEnabled("github@openai-curated", false);
    expect(writes).toEqual([
      { pluginId: "github@openai-curated", enabled: false },
    ]);
  });

  it("ignores a stale capability refresh that lands after a newer one", async () => {
    const { orch, client } = setup();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    let call = 0;
    client.listPlugins = async () => {
      call += 1;
      // Captured *before* the await: `call` has moved on by the time the
      // first response resolves, and reading it afterwards would make both
      // calls return the same payload — a test that passes either way.
      const mine = call === 1 ? "stale" : "fresh";
      if (call === 1) await gate;
      return [
        {
          id: `${mine}@m`,
          name: mine,
          displayName: mine,
          description: null,
          marketplace: "m",
          enabled: true,
          authPolicy: "ON_INSTALL",
          availability: "AVAILABLE",
          skillNames: [],
          mcpServerNames: [],
          defaultPrompts: [],
        },
      ];
    };
    client.listMcpServers = async () => [];

    const slow = orch.refreshCapabilities();
    await orch.refreshCapabilities();
    release!();
    await slow;

    // Focus, notification, and panel-open can all fire a refresh; the older
    // response must not resurrect what the newer one replaced.
    expect(orch.capabilities.plugins.items.map((p) => p.id)).toEqual([
      "fresh@m",
    ]);
  });

  it("refuses a web search mode the operator disallows", async () => {
    const { orch, client } = setup();
    const writes: string[] = [];
    client.readWebSearchSettings = async () => ({
      mode: null,
      allowedModes: ["disabled", "cached"],
    });
    client.setWebSearchMode = async (mode) => {
      writes.push(mode);
    };
    await orch.loadWebSearchMode();
    await orch.setWebSearchMode("live");
    expect(writes).toEqual([]);
    expect(orch.config.webSearchMode).toBeNull();
  });

  it("restores the previous web search mode when the write fails", async () => {
    const { orch, client } = setup();
    client.readWebSearchSettings = async () => ({
      mode: "cached",
      allowedModes: null,
    });
    await orch.loadWebSearchMode();
    client.setWebSearchMode = async () => {
      throw new Error("locked");
    };
    await orch.setWebSearchMode("live");
    expect(orch.config.webSearchMode).toBe("cached");
  });

  it("folds a startup transition in without refetching", async () => {
    const { orch, client } = setup();
    client.listPlugins = async () => [];
    client.listMcpServers = async () => [
      {
        name: "drive",
        authStatus: "oAuth",
        toolNames: [],
        resourceCount: 0,
        status: null,
        error: null,
        failureReason: null,
      },
    ];
    await orch.refreshCapabilities();
    const before = client.listMcpServers;
    let refetched = false;
    client.listMcpServers = async () => {
      refetched = true;
      return before();
    };

    orch.applyMcpStatusUpdate({
      name: "drive",
      status: "failed",
      error: "connection refused",
      failureReason: "reauthenticationRequired",
    });

    expect(refetched).toBe(false);
    expect(orch.capabilities.mcpServers.items[0]).toMatchObject({
      status: "failed",
      failureReason: "reauthenticationRequired",
    });
  });
});
