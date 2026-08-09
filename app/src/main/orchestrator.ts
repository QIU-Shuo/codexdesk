import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  emptyThread,
  projectForCwd,
  sortThreads,
  toListEntry,
  type ThreadRuntime,
} from "./threadState";
import { checkoutState } from "../application/domains/workspaces/CheckoutLifecycle";
import type { Store } from "./store";
import {
  createWorktree,
  diffAgainstBase,
  readGitBranches,
  readGitProjectRoot,
  removeWorktree,
  type GitBranchInfo,
  type WorktreeResult,
} from "./git/worktree";
import { sessionDiff } from "./git/sessionDiff";
import { prepare } from "./git/delivery";
import type { DeliveryState } from "../application/domains/delivery/DeliveryService";
import { deliveryIssue } from "../application/domains/delivery/DeliveryIssue";
import { deliveryProgressView } from "../application/domains/delivery/projection";
import {
  commit,
  push,
  createDraftPr,
  type StepResult,
} from "./git/deliveryActions";
import { parseUnifiedDiff, type ParsedDiff, type DiffFile } from "./git/diff";
import { ReviewNoteService } from "../application/domains/review/ReviewNoteService";
import type { ReviewNote } from "../application/domains/review/ReviewNote";
import { reviewNoteView } from "../application/domains/review/projection";
import { reviewDocumentFromDiff } from "./git/reviewDocument";
import {
  InputOutbox,
  type InputOutboxState,
  type OutboxEntry,
  type OutboxPolicy,
} from "../application/domains/conversations/InputOutbox";
import { inputOutboxView } from "../application/domains/conversations/outboxProjection";
import { transitionAgentRun } from "../application/domains/conversations/AgentRun";
import type { Thread } from "../protocol/generated/v2/Thread";
import type { ThreadConfig } from "./appServer/client";
import type { ApprovalsReviewer } from "../protocol/generated/v2/ApprovalsReviewer";
import {
  DEFAULT_APPROVAL_MODE,
  effectiveApprovalMode,
  threadParamsFor,
  turnParamsFor,
  type ApprovalMode,
} from "../application/domains/approvals/policy";
import type {
  ApprovalPolicy,
  TurnSandboxPolicy,
} from "../contracts/approvals";
import type { LoginAccountParams } from "../protocol/generated/v2/LoginAccountParams";
import type { LoginAccountResponse } from "../protocol/generated/v2/LoginAccountResponse";
import type { UserInput } from "../protocol/generated/v2/UserInput";
import type { ReasoningEffort } from "../protocol/generated/ReasoningEffort";
import { CapabilitiesService } from "../application/domains/capabilities/CapabilitiesService";
import type { CapabilitiesPort } from "../application/domains/capabilities/ports";
import { WorkspaceRegistry } from "../application/domains/workspaces/WorkspaceRegistry";
import type {
  WorkspacePlacement,
  WorkspaceRecord,
} from "../application/domains/workspaces/WorkspacePlacement";
import type {
  McpStatusUpdate,
  WebSearchMode,
} from "../contracts/views/capabilities";
import type {
  AppEvent,
  Attachment,
  CapabilitiesState,
  ChangesScope,
  LoginMethod,
  LoginState,
  AuthState,
  ConfigState,
  NewThreadOptions,
  NotifyMode,
  Project,
  PreflightState,
  RequestAnswer,
  ReviewSubmissionTarget,
  ReviewTarget,
  Snapshot,
  ThreadListEntry,
  ThreadView,
  UsageReport,
} from "../shared/ipc";

/**
 * Main-process orchestration, moved out of `index.ts` so it can be tested.
 *
 * **Why this file exists.** A code review found five P1 bugs, every one of
 * them in this layer: a draft leaking between threads, queued messages lost
 * on send failure, resume silently running against the wrong directory,
 * forks sharing one worktree, and a disabled network request being granted.
 * None were caught by unit tests (which covered pure functions), live tests
 * (which drive `AppServerClient` directly, bypassing all of this), or a UI
 * pass (which only walked happy paths). The orchestration was the one layer
 * with no coverage and it was where every serious bug lived.
 *
 * Everything platform-specific — Electron, git, the app-server connection —
 * arrives through `Deps` so a test can substitute fakes and drive real
 * sequences: switch threads mid-draft, fail a send, restart with a persisted
 * worktree.
 */
export type ClientPort = CapabilitiesPort & {
  // --- sign-in (§8.5) ---
  readAuth(): Promise<AuthState>;
  startLogin(params: LoginAccountParams): Promise<LoginAccountResponse>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;

  startThread(config: ThreadConfig): Promise<Thread>;
  resumeThread(threadId: string, config: ThreadConfig): Promise<Thread>;
  forkThread(
    threadId: string,
    config: ThreadConfig,
    lastTurnId?: string,
  ): Promise<Thread>;
  readThread(threadId: string, includeTurns: boolean): Promise<Thread>;
  listThreads(params: {
    cwd?: string | string[];
    limit?: number;
    cursor?: string;
    archived?: boolean;
    searchTerm?: string;
    fast?: boolean;
  }): Promise<{ data: Thread[]; nextCursor?: string | null }>;
  loadedThreadIds(): Promise<string[]>;
  setThreadName(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string, archived: boolean): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  unsubscribe(threadId: string): Promise<void>;
  sendMessage(
    threadId: string,
    input: UserInput[],
    options?: {
      model?: string | null;
      effort?: ReasoningEffort | null;
      serviceTier?: string | null;
      approvalPolicy?: ApprovalPolicy | null;
      sandboxPolicy?: TurnSandboxPolicy | null;
    },
  ): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  compact(threadId: string): Promise<void>;
  /** Inject input into the running turn (§8.1). False when none is running. */
  steer(
    threadId: string,
    expectedTurnId: string,
    input: UserInput[],
  ): Promise<
    | { kind: "delivered" }
    | { kind: "turnEnded" }
    | { kind: "notSteerable"; detail: string | null }
  >;
  activeTurnId(threadId: string): string | null;
  // --- usage (§8.6) ---
  readUsage(): Promise<UsageReport | null>;
  consumeResetCredit(idempotencyKey: string): Promise<boolean>;
  isTurnActive(threadId: string): boolean;
  answerRequest(requestId: string | number, answer: RequestAnswer): void;
  startReview(
    threadId: string,
    target: ReviewTarget,
  ): Promise<{ reviewThreadId: string }>;
  searchFiles(query: string, roots: string[]): Promise<{ files: unknown[] }>;
  pendingFor(threadId: string): unknown[];
};

export type GitPort = {
  /** Primary checkout for an ordinary directory or linked worktree. */
  projectRoot(cwd: string): Promise<string | null>;
  createWorktree(
    repoCwd: string,
    label: string,
    suffix: string,
    containerDir: string,
    baseBranch?: string,
  ): Promise<WorktreeResult>;
  readBranches(cwd: string): Promise<GitBranchInfo | null>;
  removeWorktree(
    repoRoot: string,
    worktreePath: string,
    force?: boolean,
  ): Promise<{ ok: boolean; detail?: string }>;
  diffAgainstBase(worktreePath: string, baseSha: string): Promise<string>;
  /**
   * Full worktree diff against the base, including untracked files (§7.1).
   * Separate from `diffAgainstBase` because it returns a parsed structure and
   * must not disturb the user's index.
   */
  sessionDiff(
    worktreePath: string,
    baseSha: string,
  ): Promise<{ parsed: ParsedDiff; raw: string }>;
  /** Observe the repository and decide the next delivery step (§7.2). */
  prepareDelivery(
    worktreePath: string,
    baseSha: string,
  ): Promise<DeliveryState>;
  commit(
    worktreePath: string,
    files: string[],
    message: string,
  ): Promise<StepResult<{ sha: string }>>;
  push(
    worktreePath: string,
    branch: string,
    remote: string | null,
    hasUpstream: boolean,
  ): Promise<StepResult<{ upstream: string }>>;
  createDraftPr(
    worktreePath: string,
    opts: { title: string; body: string; baseBranch: string | null },
  ): Promise<StepResult<{ url: string; existed: boolean }>>;
};

export const realGit: GitPort = {
  projectRoot: readGitProjectRoot,
  createWorktree,
  readBranches: readGitBranches,
  removeWorktree,
  diffAgainstBase,
  sessionDiff: async (worktreePath, baseSha) => {
    const res = await sessionDiff(worktreePath, baseSha);
    return { parsed: res.parsed, raw: res.raw };
  },
  prepareDelivery: prepare,
  commit,
  push,
  createDraftPr,
};

/** A single row the @-mention list can show. */
export type MentionResult = {
  path: string;
  file_name: string;
  root: string;
};

export type Deps = {
  store: Store;
  emit: (ev: AppEvent) => void;
  notify: (title: string, body: string, threadId?: string) => void;
  git?: GitPort;
  /** Where worktrees are created. */
  worktreeContainer: string;
  /** Overridable so tests need no real filesystem. */
  canonicalize?: (dir: string) => string;
  /** Open a URL in the user's browser. Injected so tests need no shell. */
  openExternal?: (url: string) => void;
  outboxPolicy?: OutboxPolicy;
  /**
   * List a directory's immediate children, honoring the same ignore rules as
   * the file tree. Used for the empty-`@` case, which `fuzzyFileSearch` cannot
   * serve — it is a matcher, not a lister (verified against 0.144.4).
   */
  listDir?: (dir: string) => Promise<MentionResult[]>;
};

function defaultCanonicalize(dir: string): string {
  const canonical = realpathSync(dir);
  if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
  return canonical;
}

/** Temporary projection for the current renderer's project-shaped inputs. */
function workspaceRecordToProject(workspace: WorkspaceRecord): Project {
  return {
    id: workspace.id,
    name: workspace.label,
    roots: [...workspace.roots],
    activeRoot: workspace.selectedRoot,
  };
}

export class Orchestrator {
  private client: ClientPort | null = null;
  private threads = new Map<string, ThreadRuntime>();
  private catalog: ThreadListEntry[] = [];
  private hiddenCatalogThreadIds = new Set<string>();
  private draining = new Set<string>();

  workspace: string | null = null;
  activeThreadId: string | null = null;
  preflight: PreflightState = { kind: "checking" };
  auth: AuthState = { kind: "unknown" };
  /** In-flight sign-in, if any (§8.5). Not persisted: a login that did not
   * finish before a restart is simply gone, and resuming a stale `loginId`
   * against a new server process would fail confusingly. */
  login: LoginState = { kind: "idle" };
  /** Set while a reset-credit redemption is in flight (§8.6), so a double
   * click cannot spend two credits. */
  private resetCreditInFlight: string | null = null;
  config: ConfigState = {
    models: [],
    permissionProfiles: [],
    skills: { status: "idle", items: [] },
    skillErrors: [],
    currentModel: null,
    currentReasoningEffort: null,
    currentServiceTier: null,
    approvalsReviewer: "user",
    approvalMode: DEFAULT_APPROVAL_MODE,
    allowedApprovalModes: null,
    webSearchMode: null,
    allowedWebSearchModes: null,
  };
  /** Plugins and MCP servers (§4.5 / V2.4). Separate from `config` because
   * MCP startup transitions arrive independently of any config read. */
  capabilities: CapabilitiesState = {
    plugins: { status: "idle", items: [] },
    mcpServers: { status: "idle", items: [] },
  };

  private readonly git: GitPort;
  private readonly canonicalize: (dir: string) => string;
  private readonly capabilityDomain: CapabilitiesService;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly reviewNotes: ReviewNoteService;
  private readonly outboxPolicy: OutboxPolicy;

  constructor(private readonly deps: Deps) {
    this.git = deps.git ?? realGit;
    this.canonicalize = deps.canonicalize ?? defaultCanonicalize;
    // Eight visible follow-ups is enough to plan several turns without
    // turning one completion into a large unattended burst.
    this.outboxPolicy = deps.outboxPolicy ?? { capacity: 8 };
    this.workspaceRegistry = new WorkspaceRegistry(
      {
        read: () => this.store.get().workspaceRegistry,
        write: (workspaceRegistry) => {
          this.store.update((state) => {
            state.workspaceRegistry = workspaceRegistry;
          });
        },
      },
      (root, workspaces) =>
        projectForCwd(root, workspaces.map(workspaceRecordToProject)),
    );
    this.reviewNotes = new ReviewNoteService(randomUUID, Date.now);
    this.capabilityDomain = new CapabilitiesService({
      publishSkills: (skills, skillErrors) => {
        this.config = { ...this.config, skills, skillErrors };
        this.emit({ type: "config", config: this.config });
      },
      publishInventory: (capabilities) => {
        this.capabilities = capabilities;
        this.emit({ type: "capabilities", capabilities });
      },
      publishWebSearch: ({ mode, allowedModes }) => {
        this.config = {
          ...this.config,
          webSearchMode: mode,
          allowedWebSearchModes: allowedModes,
        };
        this.emit({ type: "config", config: this.config });
      },
    });
    const persisted = deps.store.get();
    this.config = {
      ...this.config,
      currentModel: persisted.currentModel ?? null,
      currentReasoningEffort: persisted.currentReasoningEffort ?? null,
      currentServiceTier: persisted.currentServiceTier ?? null,
      approvalsReviewer: persisted.approvalsReviewer ?? "user",
      approvalMode: persisted.approvalMode ?? DEFAULT_APPROVAL_MODE,
    };
  }

  setClient(client: ClientPort | null): void {
    this.client = client;
    this.syncCapabilityContext();
  }

  private syncCapabilityContext(): void {
    this.capabilityDomain.setContext(this.client, this.workspace);
  }

  private get store(): Store {
    return this.deps.store;
  }

  private createOutbox(
    initial: InputOutboxState = { entries: [] },
  ): InputOutbox {
    return new InputOutbox(initial, this.outboxPolicy);
  }

  private emit(ev: AppEvent): void {
    this.deps.emit(ev);
  }

  // ------------------------------------------------------------- projection

  threadList(): ThreadListEntry[] {
    const loaded = [...this.threads.values()]
      .filter(
        (thread) =>
          thread.projectId !== null ||
          thread.threadId === this.activeThreadId ||
          this.isRecentEligibleRoot(
            thread.repoRoot ??
              this.workspaceRootHint(thread.threadId) ??
              thread.cwd,
          ),
      )
      .map((t) => toListEntry(t, true));
    const loadedIds = new Set(loaded.map((t) => t.threadId));
    const rest = this.catalog.filter(
      (entry) =>
        !loadedIds.has(entry.threadId) &&
        (!this.hiddenCatalogThreadIds.has(entry.threadId) ||
          entry.threadId === this.activeThreadId),
    );
    return sortThreads([...loaded, ...rest], this.store.get().pinnedOrder);
  }

  toView(t: ThreadRuntime): ThreadView {
    return {
      threadId: t.threadId,
      cwd: t.cwd,
      worktreePath: t.worktreePath,
      name: t.name,
      entries: t.entries,
      deltas: t.deltas,
      outbox: inputOutboxView(t.outbox),
      draft: t.draft,
      attachments: t.attachments ?? [],
      plan: t.plan,
      diff: t.diff,
      budget: t.budget,
      run: { ...t.run },
      checkout: checkoutState({
        root: t.worktreePath,
        sourceRoot: t.repoRoot ?? null,
        baseRevision: t.worktreeBaseSha ?? null,
      }),
      lastError: t.lastError,
      turnIds: t.completedTurnIds ?? [],
      // Resolved rather than raw: the picker shows the posture the thread
      // actually runs under, which for an unset thread is the default.
      approvalMode: this.approvalMode(t.threadId),
      // A freshly built skeleton has `loaded` explicitly false; every other
      // path leaves it undefined, which means "nothing to wait for".
      loaded: t.loaded !== false,
    };
  }

  snapshot(): Snapshot {
    const active = this.activeThreadId
      ? this.threads.get(this.activeThreadId)
      : null;
    return {
      preflight: this.preflight,
      auth: this.auth,
      cwd: this.workspace,
      recents: this.store.get().recents,
      threads: this.threadList(),
      activeThreadId: this.activeThreadId,
      view: active ? this.toView(active) : null,
      config: this.config,
      capabilities: this.capabilities,
      notifyMode: this.store.get().notifyMode,
      useWorktrees: this.store.get().useWorktrees ?? false,
      projects: this.projects(),
      activeProjectId: this.workspaceRegistry.snapshot().activeWorkspaceId,
    };
  }

  // ------------------------------------------------------------- projects

  private projects(): Project[] {
    return this.workspaceRegistry
      .snapshot()
      .workspaces.map(workspaceRecordToProject);
  }

  /**
   * Projects are navigation state (plan §6, 4.1) — a name over one or more
   * roots. Deliberately not an agent conversation and not a Git repository: we
   * never `git init` a folder the user picked.
   */
  addProject(name: string, root: string): Project {
    const canonicalRoot = this.canonicalPath(root);
    const workspace = this.workspaceRegistry.add({
      id: randomUUID(),
      label:
        name ||
        canonicalRoot.split(path.sep).filter(Boolean).slice(-1)[0] ||
        "Project",
      roots: [canonicalRoot],
      selectedRoot: canonicalRoot,
      registeredAt: Date.now(),
    });
    this.reassignProjects();
    this.pushProjects();
    this.pushThreads();
    return workspaceRecordToProject(workspace);
  }

  private pushProjects(): void {
    this.emit({
      type: "projects",
      projects: this.projects(),
      activeProjectId: this.workspaceRegistry.snapshot().activeWorkspaceId,
    });
  }

  async setActiveProject(id: string): Promise<void> {
    const workspace = this.workspaceRegistry.workspace(id);
    if (!workspace || !this.workspaceRegistry.setActive(id)) return;
    this.pushProjects();
    await this.useWorkspace(workspace.selectedRoot);
  }

  removeProject(id: string): void {
    this.workspaceRegistry.remove(id);
    this.reassignProjects();
    this.pushProjects();
    this.pushThreads();
  }

  renameProject(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.workspaceRegistry.rename(id, trimmed);
    this.pushProjects();
  }

  /**
   * Create an isolated checkout from HEAD and register it as a durable
   * workspace. No conversation owns its lifetime.
   */
  async registerIsolatedWorkspace(
    projectId: string,
    name: string,
  ): Promise<{ project: Project | null; error: string | null }> {
    const source = this.workspaceRegistry.workspace(projectId);
    const trimmed = name.trim();
    if (!source) return { project: null, error: "Project not found." };
    if (!trimmed) return { project: null, error: "Enter a project name." };

    const suffix = randomUUID().slice(0, 8);
    const result = await this.git.createWorktree(
      source.selectedRoot,
      trimmed,
      suffix,
      this.deps.worktreeContainer,
    );
    if (!result.ok) return { project: null, error: result.detail };

    return { project: this.addProject(trimmed, result.path), error: null };
  }

  /** Recompute ownership after projects are added or removed. */
  private reassignProjects(): void {
    const registry = this.workspaceRegistry.snapshot();
    const assign = (conversationId: string, root: string): string | null => {
      const placement = registry.placements[conversationId];
      const workspaceId = this.workspaceRegistry.workspaceFor(root, placement);
      if (placement?.kind !== "unassigned") {
        registry.placements[conversationId] = workspaceId
          ? {
              kind: "registered",
              workspaceId,
              navigationRoot: root,
            }
          : { kind: "unregistered", root };
      }
      return workspaceId;
    };
    for (const entry of this.catalog) {
      entry.projectId = assign(
        entry.threadId,
        this.workspaceRootHint(entry.threadId) ?? entry.cwd,
      );
    }
    for (const thread of this.threads.values()) {
      const placement = registry.placements[thread.threadId];
      thread.projectId = assign(
        thread.threadId,
        this.workspaceRootHint(thread.threadId) ?? thread.cwd,
      );
      thread.projectIdExplicit =
        placement?.kind === "registered" ||
        placement?.kind === "unassigned" ||
        thread.projectId !== null;
    }
    this.workspaceRegistry.replace(registry);
  }

  private canonicalPath(candidate: string): string {
    try {
      return this.canonicalize(candidate);
    } catch {
      return path.resolve(candidate);
    }
  }

  private projectAssignment(threadId: string): string | null | undefined {
    const placement = this.workspaceRegistry.placement(threadId);
    if (placement?.kind === "registered") return placement.workspaceId;
    if (placement?.kind === "unassigned") return null;
    return undefined;
  }

  private workspaceRootHint(threadId: string): string | undefined {
    return this.workspaceRegistry.navigationRoot(threadId);
  }

  /** Preserve explicit ownership only while that project exists. */
  private navigationProject(
    cwd: string,
    assignedProjectId?: string | null,
  ): string | null {
    const placement: WorkspacePlacement | undefined =
      assignedProjectId === null
        ? { kind: "unassigned" }
        : typeof assignedProjectId === "string"
          ? {
              kind: "registered",
              workspaceId: assignedProjectId,
              navigationRoot: cwd,
            }
          : undefined;
    return this.workspaceRegistry.workspaceFor(
      this.canonicalPath(cwd),
      placement,
    );
  }

  getThread(threadId: string): ThreadRuntime | undefined {
    return this.threads.get(threadId);
  }

  pushThreads(): void {
    this.emit({ type: "threads", threads: this.threadList() });
  }

  pushView(threadId: string): void {
    const t = this.threads.get(threadId);
    // Only the visible thread's transcript is pushed; background threads
    // accumulate here and are sent when opened.
    if (t && threadId === this.activeThreadId) {
      this.emit({ type: "threadView", view: this.toView(t) });
    }
  }

  private persist(t: ThreadRuntime): void {
    this.store.update((s) => {
      s.threads[t.threadId] = {
        draft: t.draft,
        outbox: t.outbox.durableSnapshot(),
        pinned: t.pinned,
        name: t.name,
        cwd: t.cwd,
        worktreePath: t.worktreePath,
        // Persisting the base SHA is what makes a worktree diff survive a
        // restart; it was previously in-memory only, so diffs silently
        // returned empty after relaunch.
        worktreeBaseSha: t.worktreeBaseSha ?? null,
        reviewNotes: (t.reviewNotes ?? []).map(reviewNoteView),
        approvalMode: t.approvalMode,
        updatedAtMs: t.updatedAtMs,
      };
    });
    const navigationRoot = this.canonicalPath(t.repoRoot ?? t.cwd);
    if (t.projectIdExplicit) {
      this.workspaceRegistry.setPlacement(
        t.threadId,
        t.projectId
          ? {
              kind: "registered",
              workspaceId: t.projectId,
              navigationRoot,
            }
          : { kind: "unassigned" },
      );
    } else if (t.repoRoot) {
      this.workspaceRegistry.setPlacement(t.threadId, {
        kind: "unregistered",
        root: navigationRoot,
      });
    }
  }

  // ----------------------------------------------------------------- events

  handleEvent(ev: AppEvent): void {
    switch (ev.type) {
      case "turnStarted": {
        const t = this.threads.get(ev.threadId);
        if (t) {
          t.activeTurnId = ev.turnId;
          t.run = transitionAgentRun(t.run, {
            type: "turnStarted",
            turnId: ev.turnId,
            startedAt: Date.now(),
          });
          t.lastError = null;
          t.updatedAtMs = Date.now();
        }
        break;
      }

      case "itemStarted":
      case "itemCompleted": {
        const t = this.threads.get(ev.threadId);
        if (!t) break;
        const idx = t.entries.findIndex(
          (e) => e.kind === "item" && e.id === ev.item.id,
        );
        const prior = idx >= 0 ? t.entries[idx] : undefined;
        const timing =
          ev.type === "itemStarted"
            ? { startedAtMs: ev.startedAtMs }
            : {
                ...(prior?.kind === "item" && prior.startedAtMs !== undefined
                  ? { startedAtMs: prior.startedAtMs }
                  : {}),
                completedAtMs: ev.completedAtMs,
              };
        const entry = {
          kind: "item" as const,
          id: ev.item.id,
          item: ev.item,
          turnId: ev.turnId,
          ...timing,
        };
        if (idx >= 0) {
          t.entries[idx] = entry;
        } else {
          t.entries.push(entry);
        }
        if (ev.type === "itemCompleted") delete t.deltas[ev.item.id];
        if (!t.preview && ev.item.type === "userMessage") {
          const text = ev.item.content.find((c) => c.type === "text");
          if (text && text.type === "text") {
            t.preview = text.text.trim().slice(0, 120);
          }
        }
        t.updatedAtMs = Date.now();
        break;
      }

      case "itemDelta": {
        const t = this.threads.get(ev.threadId);
        if (!t) break;
        const item = (t.deltas[ev.itemId] ??= {});
        const stream = (item[ev.kind] ??= {});
        stream[ev.index] = (stream[ev.index] ?? "") + ev.delta;
        break;
      }

      case "turnCompleted": {
        const t = this.threads.get(ev.threadId);
        if (t) {
          const turnDurationMs = completedTurnDurationMs(ev.turn);
          if (turnDurationMs !== undefined) {
            t.entries = t.entries.map((entry) =>
              entry.kind === "item" && entry.turnId === ev.turn.id
                ? { ...entry, turnDurationMs }
                : entry,
            );
          }
          t.activeTurnId = null;
          t.run = transitionAgentRun(
            t.run,
            ev.turn.status === "failed"
              ? {
                  type: "failed",
                  message: ev.turn.error?.message ?? "The turn failed.",
                  retryable: true,
                }
              : { type: "turnCompleted" },
          );
          t.completedTurnIds = [...(t.completedTurnIds ?? []), ev.turn.id];
          // A plan outlives the turn that produced it, so mark it as a record
          // rather than a forecast (§8.3). Steps still pending at this point
          // are work the agent did not do — the surface has to say so.
          if (t.plan && t.plan.turnId === ev.turn.id) {
            t.plan = { ...t.plan, turnEnded: true };
          }
          if (ev.turn.status !== "completed") {
            t.lastError = `turn ${ev.turn.status}${
              ev.turn.error ? `: ${ev.turn.error.message}` : ""
            }`;
          }
          if (ev.threadId !== this.activeThreadId) t.unread = true;
          t.updatedAtMs = Date.now();
          void this.refreshWorktreeDiff(t);
        }
        this.deps.notify(
          ev.turn.status === "completed"
            ? "Turn completed"
            : `Turn ${ev.turn.status}`,
          t?.name ?? t?.cwd ?? "",
          ev.threadId,
        );
        void this.drainQueue(ev.threadId);
        break;
      }

      case "turnError": {
        const t = this.threads.get(ev.threadId);
        if (t) {
          if (ev.willRetry) {
            // A retry is transcript history, not a banner: see the `retry`
            // entry in shared/ipc.ts. `lastError` is left alone so a real
            // failure later is not masked by a reconnect that recovered.
            t.entries.push({
              kind: "retry",
              id: `retry:${t.entries.length}:${Date.now()}`,
              message: ev.error.message,
              attempt: null,
              max: null,
              atMs: Date.now(),
            });
          } else {
            t.lastError = ev.error.message;
            t.run = transitionAgentRun(t.run, {
              type: "failed",
              message: ev.error.message,
              retryable: true,
            });
            t.activeTurnId = null;
          }
          t.updatedAtMs = Date.now();
        }
        if (!ev.willRetry) {
          this.deps.notify("Turn failed", ev.error.message, ev.threadId);
        }
        break;
      }

      case "requestPending": {
        const t = this.threads.get(ev.request.threadId);
        if (t) {
          t.entries.push({
            kind: "request",
            id: String(ev.request.requestId),
            request: ev.request,
          });
          t.run = transitionAgentRun(t.run, {
            type: "attentionRequested",
            turnId: t.activeTurnId,
            requestId: String(ev.request.requestId),
            reason:
              ev.request.kind === "userInput" ||
              ev.request.kind === "elicitation"
                ? "input"
                : "approval",
          });
          if (ev.request.threadId !== this.activeThreadId) t.unread = true;
          t.updatedAtMs = Date.now();
        }
        this.deps.notify(
          "Agent needs your input",
          describeRequest(ev.request.kind),
          ev.request.threadId,
        );
        break;
      }

      case "requestResolved": {
        const t = this.threads.get(ev.threadId);
        if (t) {
          t.entries = t.entries.filter(
            (e) => !(e.kind === "request" && e.id === String(ev.requestId)),
          );
          if (t.run.kind === "waiting") {
            t.run = transitionAgentRun(t.run, {
              type: "attentionResolved",
              activeTurnId: t.activeTurnId,
            });
          }
        }
        break;
      }

      case "autoReview": {
        const t = this.threads.get(ev.threadId);
        if (!t) break;
        const idx = t.entries.findIndex(
          (e) => e.kind === "review" && e.id === ev.review.reviewId,
        );
        const entry = {
          kind: "review" as const,
          id: ev.review.reviewId,
          review: ev.review,
        };
        if (idx >= 0) t.entries[idx] = entry;
        else t.entries.push(entry);
        break;
      }

      case "diff": {
        const t = this.threads.get(ev.threadId);
        // `turn/diff/updated` is what the *last turn* changed. It used to be
        // dropped for worktree threads, on the grounds that their diff comes
        // from git — but that conflated the two scopes. The session diff is
        // computed separately (`refreshChanges`); this is the turn scope, and
        // discarding it left "what did the agent just do" unanswerable for
        // exactly the threads where the question comes up.
        if (t) {
          t.diff = ev.diff;
          if (
            t.changesScope === "turn" &&
            ev.threadId === this.activeThreadId
          ) {
            void this.refreshChanges(ev.threadId);
          }
        }
        break;
      }
      case "plan": {
        const t = this.threads.get(ev.threadId);
        if (t) t.plan = ev.plan;
        break;
      }
      case "budget": {
        if (!ev.threadId) {
          for (const t of this.threads.values()) {
            t.budget = { ...t.budget, rateLimits: ev.budget.rateLimits };
          }
        } else {
          const t = this.threads.get(ev.threadId);
          if (t) {
            t.budget = {
              tokenUsage: ev.budget.tokenUsage ?? t.budget.tokenUsage,
              rateLimits: ev.budget.rateLimits ?? t.budget.rateLimits,
            };
          }
        }
        break;
      }
    }

    this.emit(ev);
    if ("threadId" in ev && ev.threadId) this.pushView(ev.threadId);
    if (
      ev.type === "turnCompleted" ||
      ev.type === "turnStarted" ||
      ev.type === "requestPending" ||
      ev.type === "requestResolved" ||
      ev.type === "turnError"
    ) {
      this.pushThreads();
    }
  }

  // ------------------------------------------------------------------ queue

  /**
   * Deliver the next queued message (§8.1).
   *
   * Two delivery paths, and which one applies depends on whether a turn is
   * running. When one is, we **steer** — `turn/steer` injects the input into
   * the turn already in flight, which is the whole point of queueing while the
   * agent works. When none is, we start a new turn.
   *
   * Not every turn accepts steering: `review` and `compact` turns refuse, and
   * the server says so with `activeTurnNotSteerable`. That is not an error to
   * report and forget — the message stays queued and drains at turn end, so
   * refusal costs the user a wait rather than their input.
   *
   * The message is only removed from the durable queue **after** delivery
   * succeeds. Removing first meant a failed send silently destroyed the
   * user's message, with nothing but a log line.
   */
  async drainQueue(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!this.client || !t || this.draining.has(threadId)) return;
    if (t.outbox.durableSnapshot().entries.length === 0) return;
    this.draining.add(threadId);
    const expectedTurnId = this.client.activeTurnId(threadId);
    const attempt = t.outbox.beginDispatch(expectedTurnId);
    if (!attempt) {
      this.draining.delete(threadId);
      return;
    }
    this.emitOutbox(t);
    try {
      const input = outboxInput(attempt.entry);
      if (attempt.route === "inject") {
        const result = await this.client.steer(
          threadId,
          attempt.expectedTurnId!,
          input,
        );
        if (result.kind === "turnEnded") {
          t.outbox.defer(attempt, "turnEnded");
          this.emitOutbox(t);
          return;
        }
        if (result.kind === "notSteerable") {
          t.outbox.defer(attempt, "turnNotSteerable", result.detail);
          this.emitOutbox(t);
          return;
        }
      } else {
        await this.client.sendMessage(threadId, input, this.turnOptions(t));
      }
      t.outbox.complete(attempt);
      this.persist(t);
      this.emitOutbox(t);
      this.pushView(threadId);
    } catch (err) {
      const message = errText(err);
      t.outbox.fail(attempt, {
        message,
        retryable: true,
        at: Date.now(),
      });
      t.lastError = `failed to send queued message: ${message}`;
      this.emit({ type: "log", level: "error", message: t.lastError });
      this.persist(t);
      this.emitOutbox(t);
      this.pushView(threadId);
    } finally {
      this.draining.delete(threadId);
    }
  }

  private emitOutbox(t: ThreadRuntime): void {
    this.emit({
      type: "outbox",
      threadId: t.threadId,
      outbox: inputOutboxView(t.outbox),
    });
  }

  /**
   * Send, or queue when a turn is already running.
   *
   * The draft is cleared only after the send succeeds — clearing first threw
   * away typed text whenever `turn/start` failed.
   */
  async sendMessage(
    threadId: string,
    text: string,
  ): Promise<{ queued: boolean; error?: string }> {
    const t = this.threads.get(threadId);
    if (!this.client || !t) return { queued: false, error: "no such thread" };

    if (this.client.isTurnActive(threadId)) {
      // The queue is bounded, so there is a state where typing more is
      // refused. Saying so beats silently dropping the message or letting an
      // unbounded queue fire twenty turns when the current one ends.
      const result = t.outbox.enqueue({
        id: randomUUID(),
        text,
        createdAt: Date.now(),
        assets: (t.attachments ?? []).map((attachment) => ({ ...attachment })),
        schedule: "afterTurn",
        lastFailure: null,
      });
      if (!result.ok) {
        const error = `the queue is full (${t.outbox.policy.capacity} messages)`;
        t.lastError = error;
        this.pushView(threadId);
        return { queued: false, error };
      }
      t.draft = "";
      t.attachments = [];
      this.persist(t);
      this.emitOutbox(t);
      this.pushView(threadId);
      return { queued: true };
    }

    try {
      await this.client.sendMessage(
        threadId,
        this.composeInput(t, text),
        this.turnOptions(t),
      );
    } catch (err) {
      const error = errText(err);
      t.lastError = `failed to send: ${error}`;
      this.emit({ type: "log", level: "error", message: t.lastError });
      this.pushView(threadId);
      return { queued: false, error };
    }

    t.draft = "";
    t.attachments = [];
    this.persist(t);
    this.pushView(threadId);
    return { queued: false };
  }

  /**
   * The per-turn overrides every `turn/start` carries.
   *
   * Sending the posture on each turn is what makes a mode change reach a
   * thread that is already open; `thread/start` alone would only affect the
   * next thread.
   */
  private turnOptions(t: ThreadRuntime) {
    return {
      model: this.config.currentModel,
      effort: this.config.currentReasoningEffort,
      serviceTier: this.config.currentServiceTier,
      ...turnParamsFor(this.approvalMode(t.threadId), [
        t.worktreePath ?? t.cwd,
      ]),
    };
  }

  /**
   * Compose text plus attachments into `UserInput[]`.
   *
   * The protocol already models these: `localImage` for a pasted screenshot,
   * `mention` for a file. This is why 4.4 is composer work rather than
   * protocol work.
   */
  private composeInput(t: ThreadRuntime, text: string): UserInput[] {
    const input: UserInput[] = [];
    for (const a of t.attachments ?? []) {
      input.push(
        a.kind === "image"
          ? { type: "localImage", path: a.path }
          : { type: "mention", name: a.name, path: a.path },
      );
    }
    input.push({ type: "text", text, text_elements: [] });
    return input;
  }

  addAttachment(threadId: string, attachment: Attachment): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.attachments = [...(t.attachments ?? []), attachment];
    this.pushView(threadId);
  }

  removeAttachment(threadId: string, id: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.attachments = (t.attachments ?? []).filter((a) => a.id !== id);
    this.pushView(threadId);
  }

  saveDraft(threadId: string, draft: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.draft = draft;
    this.persist(t);
  }

  removeQueued(threadId: string, id: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    if (!t.outbox.remove(id)) return;
    this.persist(t);
    this.emitOutbox(t);
    this.pushView(threadId);
  }

  /**
   * Send the head of the queue into the running turn now (§8.1).
   *
   * Queueing and steering are deliberately separate actions. Enqueueing does
   * *not* steer on its own: the app-server's own surface is
   * `maybeSendQueuedSteerMessage`, and auto-injecting every message would
   * empty the queue as fast as the user filled it, which defeats the point of
   * being able to line work up. So the queue drains at turn end by default,
   * and this is the explicit "don't wait" path.
   */
  async steerNow(threadId: string): Promise<void> {
    if (!this.client?.isTurnActive(threadId)) return;
    const t = this.threads.get(threadId);
    if (!t?.outbox.scheduleNow()) return;
    this.persist(t);
    await this.drainQueue(threadId);
  }

  /**
   * Edit a message that is still waiting (§8.1).
   *
   * A queued message is text the user has not sent yet, so it stays editable
   * — the alternative is delete-and-retype, which loses attachments. Empty
   * text removes it, matching what the composer does with an empty draft.
   */
  editQueued(threadId: string, id: string, text: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    const trimmed = text.trim();
    if (!trimmed) {
      this.removeQueued(threadId, id);
      return;
    }
    if (!t.outbox.edit(id, trimmed)) return;
    this.persist(t);
    this.emitOutbox(t);
    this.pushView(threadId);
  }

  /**
   * Reorder the queue (§8.1).
   *
   * Order is the whole point of a queue with more than one entry: the user
   * decides what the agent does next. Moves are clamped rather than rejected
   * so a drag past either end lands at the end rather than doing nothing.
   */
  moveQueued(threadId: string, id: string, toIndex: number): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    if (!t.outbox.move(id, toIndex)) return;
    this.persist(t);
    this.emitOutbox(t);
    this.pushView(threadId);
  }

  // --------------------------------------------------------------- sign-in

  /**
   * Start signing in (§8.5).
   *
   * Two methods ship: the ChatGPT browser flow and an API key. Both are
   * asynchronous in different ways — the browser flow returns an `authUrl`
   * and finishes later via `account/login/completed`, while an API key
   * succeeds or fails on the spot. The `login` state exists so the UI can
   * distinguish "nothing happened" from "waiting on your browser".
   *
   * `chatgptDeviceCode` exists in the protocol and is deliberately not built
   * — see the plan. `amazonBedrock` does *not* exist in 0.144.4 despite the
   * plan listing it.
   */
  async startLogin(method: LoginMethod): Promise<void> {
    if (!this.client) return;
    this.setLogin({ kind: "starting" });

    try {
      const res =
        method.kind === "apiKey"
          ? await this.client.startLogin({
              type: "apiKey",
              apiKey: method.apiKey,
            })
          : await this.client.startLogin({ type: "chatgpt" });

      if (res.type === "chatgpt") {
        // Only *starts* the flow; `onLoginCompleted` reports the outcome.
        this.setLogin({
          kind: "awaitingBrowser",
          loginId: res.loginId,
          authUrl: res.authUrl,
        });
        this.deps.openExternal?.(res.authUrl);
        return;
      }

      // apiKey succeeds immediately; re-read rather than assume.
      this.setLogin({ kind: "idle" });
      await this.refreshAuth();
    } catch (err) {
      this.setLogin({ kind: "failed", message: errText(err) });
    }
  }

  async cancelLogin(): Promise<void> {
    const current = this.login;
    this.setLogin({ kind: "idle" });
    if (current.kind === "awaitingBrowser" && this.client) {
      // Best effort: the server may already have finished or timed out.
      await this.client.cancelLogin(current.loginId).catch(() => {});
    }
  }

  async logout(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch (err) {
      this.emit({ type: "log", level: "error", message: errText(err) });
      return;
    }
    // The server answers with `account/updated`, but re-reading here means the
    // UI does not depend on that notification arriving.
    await this.refreshAuth();
  }

  /** Called when `account/login/completed` arrives. */
  onLoginCompleted(success: boolean, error: string | null): void {
    this.setLogin(
      success
        ? { kind: "idle" }
        : { kind: "failed", message: error ?? "Sign-in failed." },
    );
    if (success) void this.refreshAuth();
  }

  /** Re-read auth from the server and push it. */
  async refreshAuth(): Promise<void> {
    if (!this.client) return;
    try {
      this.auth = await this.client.readAuth();
      this.emit({ type: "auth", state: this.auth });
    } catch {
      // Leave the last known state rather than claiming signed-out.
    }
  }

  setAuth(state: AuthState): void {
    this.auth = state;
    this.emit({ type: "auth", state });
  }

  private setLogin(state: LoginState): void {
    this.login = state;
    this.emit({ type: "login", state });
  }

  // ------------------------------------------- changes, delivery, comments

  /** Which scope the pane shows for a thread (§7.1). */
  setChangesScope(threadId: string, scope: ChangesScope): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.changesScope = scope;
    void this.refreshChanges(threadId);
  }

  /**
   * Recompute the diff for the thread's current scope and push it (§7.1).
   *
   * Two scopes, and they answer different questions:
   *
   * - **turn** — what app-server reported at the end of the last turn, via
   *   `turn/diff/updated`. Note the spec's wording: *"the latest aggregated
   *   unified diff across every file change in the turn"*, emitted after every
   *   `FileChange` item. Verified live — it reflects the working tree, so an
   *   edit you made yourself before the turn appears here too. It is "the diff
   *   as of that turn", not "only what that turn touched". We do not compute
   *   it and cannot narrow it.
   * - **session** — everything in the worktree since the thread started. Comes
   *   from Git, never from concatenating turn diffs: turns overlap, later
   *   turns revert earlier ones, and edits made in the terminal never appear
   *   as turn diffs at all.
   *
   * A thread without a worktree has no base commit, so only the turn scope is
   * available there — the control is hidden rather than offering a scope that
   * cannot be computed.
   */
  async refreshChanges(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) return;

    const hasSession = Boolean(t.worktreePath && t.worktreeBaseSha);
    const scope: ChangesScope = hasSession
      ? (t.changesScope ?? "session")
      : "turn";

    if (scope === "turn") {
      // The turn diff arrives as unified text; parse it the same way so the
      // pane, review notes, and counts all work identically in both scopes.
      const parsed = parseUnifiedDiff(t.diff ?? "");
      t.changes = parsed;
      if (t.reviewNotes?.length) {
        t.reviewNotes = this.reviewNotes.relocate(
          t.reviewNotes,
          reviewDocumentFromDiff(parsed),
        );
        this.emitReviewNotes(threadId, t.reviewNotes);
      }
      this.emit({
        type: "changes",
        threadId,
        changes: {
          scope: "turn",
          baseSha: null,
          sessionAvailable: hasSession,
          files: parsed.files.map(toFileView),
          additions: parsed.additions,
          deletions: parsed.deletions,
          error: null,
        },
      });
      return;
    }

    // Narrowed by `hasSession` above; restated so TypeScript can see it.
    const worktreePath = t.worktreePath!;
    const baseSha = t.worktreeBaseSha!;

    try {
      const { parsed } = await this.git.sessionDiff(worktreePath, baseSha);
      t.changes = parsed;
      // Review notes anchor into this diff, so they are re-checked every
      // time it moves (§7.3) — silently pointing at a line that shifted is
      // worse than saying the comment is stale.
      if (t.reviewNotes?.length) {
        t.reviewNotes = this.reviewNotes.relocate(
          t.reviewNotes,
          reviewDocumentFromDiff(parsed),
        );
        this.emitReviewNotes(threadId, t.reviewNotes);
      }
      this.emit({
        type: "changes",
        threadId,
        changes: {
          scope: "session",
          baseSha,
          sessionAvailable: true,
          files: parsed.files.map(toFileView),
          additions: parsed.additions,
          deletions: parsed.deletions,
          error: null,
        },
      });
    } catch (err) {
      // Reporting "no changes" for a diff we failed to compute would tell the
      // user their work vanished. Say what happened instead.
      this.emit({
        type: "changes",
        threadId,
        changes: {
          scope: "session",
          baseSha,
          sessionAvailable: true,
          files: [],
          additions: 0,
          deletions: 0,
          error: errText(err),
        },
      });
    }
  }

  /** Observe the repository and report the next delivery step (§7.2). */
  async prepareDelivery(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t?.worktreePath || !t.worktreeBaseSha) return;
    const state = await this.git.prepareDelivery(
      t.worktreePath,
      t.worktreeBaseSha,
    );
    t.delivery = state;
    this.emitDelivery(threadId, state, false);
  }

  /**
   * Commit the paths the user selected.
   *
   * `selected` comes from the commit form. It is intersected with what git
   * currently reports rather than trusted outright: the user may have reverted
   * something between rendering the form and pressing the button, and
   * committing a path that no longer differs fails confusingly. Passing an
   * empty selection means "everything", which is what a form with no
   * interaction should do.
   */
  async commitChanges(
    threadId: string,
    message: string,
    selected?: string[],
  ): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t?.worktreePath || !t.worktreeBaseSha) return;

    // Always re-observe first. The user may have edited since the pane was
    // rendered, and committing a stale file list would either miss work or
    // include something they since reverted.
    const state = await this.git.prepareDelivery(
      t.worktreePath,
      t.worktreeBaseSha,
    );
    if (state.issue) {
      t.delivery = state;
      this.emitDelivery(threadId, state, false);
      return;
    }

    const wanted = selected?.length
      ? state.files.filter((f) => selected.includes(f))
      : state.files;
    if (wanted.length === 0) {
      const empty = {
        ...state,
        next: "commit" as const,
        issue: deliveryIssue(
          "commit",
          "noChanges",
          "userAction",
          "No files are selected for this commit.",
        ),
      };
      t.delivery = empty;
      this.emitDelivery(threadId, empty, false);
      return;
    }

    this.emitDelivery(threadId, state, true);
    const res = await this.git.commit(t.worktreePath, wanted, message);
    if (!res.ok) {
      const failed = {
        ...state,
        next: res.issue.stage,
        issue: res.issue,
      };
      t.delivery = failed;
      this.emitDelivery(threadId, failed, false);
      return;
    }
    await this.prepareDelivery(threadId);
    await this.refreshChanges(threadId);
  }

  async pushBranch(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t?.worktreePath || !t.worktreeBaseSha) return;

    const state = await this.git.prepareDelivery(
      t.worktreePath,
      t.worktreeBaseSha,
    );
    if (!state.branch) {
      this.emitDelivery(threadId, state, false);
      return;
    }

    this.emitDelivery(threadId, state, true);
    const res = await this.git.push(
      t.worktreePath,
      state.branch,
      state.remote,
      Boolean(state.upstream),
    );
    if (!res.ok) {
      const failed = {
        ...state,
        next: res.issue.stage,
        issue: res.issue,
      };
      t.delivery = failed;
      this.emitDelivery(threadId, failed, false);
      return;
    }
    await this.prepareDelivery(threadId);
  }

  async createPullRequest(
    threadId: string,
    title: string,
    body: string,
  ): Promise<string | null> {
    const t = this.threads.get(threadId);
    if (!t?.worktreePath || !t.worktreeBaseSha) return null;

    const state = await this.git.prepareDelivery(
      t.worktreePath,
      t.worktreeBaseSha,
    );
    this.emitDelivery(threadId, state, true);

    const res = await this.git.createDraftPr(t.worktreePath, {
      title,
      body,
      baseBranch: state.defaultBranch,
    });
    if (!res.ok) {
      const failed = {
        ...state,
        next: res.issue.stage,
        issue: res.issue,
      };
      t.delivery = failed;
      this.emitDelivery(threadId, failed, false);
      return null;
    }

    const done = {
      ...state,
      prUrl: res.value.url,
      next: "done" as const,
      issue: null,
    };
    t.delivery = done;
    this.emitDelivery(threadId, done, false);
    return res.value.url;
  }

  /**
   * A commit message proposed from the diff.
   *
   * Deliberately mechanical rather than model-generated for now: it is
   * editable, it costs no tokens and no latency, and a wrong-but-plausible
   * generated message is harder to notice than an obviously plain one.
   */
  proposeCommitMessage(threadId: string): string {
    const t = this.threads.get(threadId);
    const files = t?.delivery?.files ?? [];
    if (files.length === 0) return "";
    if (files.length === 1) return `Update ${files[0]}`;
    const dirs = new Set(files.map((f) => f.split("/")[0] ?? f));
    const scope = dirs.size === 1 ? ` in ${[...dirs][0]}` : "";
    return `Update ${files.length} files${scope}`;
  }

  addReviewNote(
    threadId: string,
    draft: {
      filePath: string;
      side: "left" | "right";
      startLine: number;
      endLine: number;
      text: string;
    },
  ): void {
    const t = this.threads.get(threadId);
    if (!t?.changes) return;
    const note = this.reviewNotes.create(
      reviewDocumentFromDiff(t.changes),
      threadId,
      {
        path: draft.filePath,
        side: draft.side === "left" ? "before" : "after",
        span: { start: draft.startLine, end: draft.endLine },
        body: draft.text,
      },
      t.worktreeBaseSha ?? null,
    );
    if (!note) return;
    t.reviewNotes = [...(t.reviewNotes ?? []), note];
    this.emitReviewNotes(threadId, t.reviewNotes);
    this.persist(t);
  }

  removeReviewNote(threadId: string, noteId: string): void {
    const t = this.threads.get(threadId);
    if (!t?.reviewNotes) return;
    t.reviewNotes = t.reviewNotes.filter((note) => note.id !== noteId);
    this.emitReviewNotes(threadId, t.reviewNotes);
    this.persist(t);
  }

  /**
   * Send accumulated comments as a turn (§7.3).
   *
   * Review can continue the current thread, target another thread, or create a
   * fork. Forking keeps the reviewed history unchanged.
   */
  async submitReviewNotes(
    threadId: string,
    text: string,
    target: ReviewSubmissionTarget,
  ): Promise<string | null> {
    const t = this.threads.get(threadId);
    if (!t?.reviewNotes?.length && !text.trim()) return null;

    const notes = t?.reviewNotes ?? [];
    const message = this.reviewNotes.compose(notes, text);

    let targetId = threadId;
    if (target.kind === "fork") {
      const forked = await this.forkThread(threadId);
      if (!forked) return null;
      targetId = forked;
    } else if (target.kind === "thread") {
      targetId = target.threadId;
    }

    const res = await this.sendMessage(targetId, message);
    if (res.error) return null;

    // The notes have been delivered; clearing them is what makes a second
    // submission not resend the same review.
    if (t) {
      t.reviewNotes = [];
      this.emitReviewNotes(threadId, []);
      this.persist(t);
    }
    return targetId;
  }

  private emitReviewNotes(threadId: string, notes: ReviewNote[]): void {
    this.emit({
      type: "reviewNotes",
      threadId,
      notes: notes.map(reviewNoteView),
    });
  }

  private emitDelivery(
    threadId: string,
    state: DeliveryState,
    busy: boolean,
  ): void {
    this.emit({
      type: "delivery",
      threadId,
      state: deliveryProgressView(state, busy),
    });
  }

  // -------------------------------------------------------------- worktrees

  private async refreshWorktreeDiff(t: ThreadRuntime): Promise<void> {
    if (!t.worktreePath || !t.worktreeBaseSha) return;
    const diff = await this.git.diffAgainstBase(
      t.worktreePath,
      t.worktreeBaseSha,
    );
    t.diff = diff;
    this.pushView(t.threadId);
  }

  /**
   * Create a worktree for a thread. Returns null on failure, having already
   * reported why — the caller must not fall back to the user's checkout.
   */
  private async setupWorktree(
    cwd: string,
    label: string,
    baseBranch?: string,
  ): Promise<{ path: string; baseSha: string } | null> {
    const suffix = randomUUID().slice(0, 8);
    this.emit({
      type: "checkout",
      threadId: suffix,
      state: { kind: "preparing" },
    });
    const result = await this.git.createWorktree(
      cwd,
      label,
      suffix,
      this.deps.worktreeContainer,
      baseBranch,
    );
    if (!result.ok) {
      this.emit({
        type: "checkout",
        threadId: suffix,
        state: { kind: "failed", message: result.detail, retryable: true },
      });
      this.deps.notify("Worktree setup failed", result.detail);
      this.emit({
        type: "log",
        level: "error",
        message: `worktree ${result.reason}: ${result.detail}`,
      });
      return null;
    }
    return { path: result.path, baseSha: result.baseSha };
  }

  // --------------------------------------------------------------- threads

  async newThread(opts: NewThreadOptions = {}): Promise<string | null> {
    if (!this.client) return null;
    const cwd = opts.cwd ?? this.workspace;
    if (!cwd) return null;

    // A specific branch is a clean starting point. Realize it in a dedicated
    // worktree; checking out the user's local directory would be a surprising
    // destructive side effect of a composer dropdown.
    const useWorktree = Boolean(
      opts.baseBranch ||
      (opts.useWorktree ?? this.store.get().useWorktrees ?? false),
    );
    const projects = this.projects();
    const projectId =
      opts.projectId !== undefined
        ? opts.projectId
        : projectForCwd(this.canonicalPath(cwd), projects);
    this.workspaceRegistry.setActive(projectId);
    if (projectId) this.workspaceRegistry.selectRoot(projectId, cwd);
    if (opts.useWorktree !== undefined) {
      this.store.update((state) => {
        state.useWorktrees = useWorktree;
      });
    }
    this.pushProjects();

    let runCwd = cwd;
    let worktreePath: string | null = null;
    let baseSha: string | null = null;

    if (useWorktree) {
      const wt = await this.setupWorktree(cwd, "thread", opts.baseBranch);
      // Never silently fall back to the user's checkout — that would break
      // the isolation the sandbox posture depends on (plan §6, 3.4).
      if (!wt) return null;
      runCwd = wt.path;
      worktreePath = wt.path;
      baseSha = wt.baseSha;
    }

    try {
      const thread = await this.client.startThread({
        cwd: runCwd,
        model: this.config.currentModel,
        effort: this.config.currentReasoningEffort,
        serviceTier: this.config.currentServiceTier,
        approvalsReviewer: this.approvalsReviewer(),
        ...threadParamsFor(this.approvalMode()),
      });
      const t = emptyThread(thread.id, runCwd, this.createOutbox(), {
        projectId,
        projectIdExplicit: true,
        worktreePath,
        worktreeBaseSha: baseSha,
        // Remember where the worktree came from, so it can be removed later.
        repoRoot: worktreePath ? cwd : null,
        // Freshly started: no server history to fetch, so `openThread` should
        // take the fast path rather than round-tripping for an empty rollout.
        loaded: true,
      });
      this.threads.set(thread.id, t);
      this.persist(t);
      if (worktreePath && baseSha) {
        this.emit({
          type: "checkout",
          threadId: thread.id,
          state: {
            kind: "available",
            root: worktreePath,
            sourceRoot: cwd,
            baseRevision: baseSha,
          },
        });
      }
      await this.openThread(thread.id);
      return thread.id;
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `thread/start failed: ${errText(err)}`,
      });
      return null;
    }
  }

  /** Read-only context for the draft-chat branch picker. */
  readGitBranches(cwd: string): Promise<GitBranchInfo | null> {
    return this.git.readBranches(cwd);
  }

  /**
   * Make a thread visible, loading history if we do not have it.
   *
   * Persisted state is read **before** resuming, because a worktree thread
   * must resume against its own worktree. Resuming with the workspace root
   * and applying the saved path afterwards left the UI showing a worktree
   * while the agent actually ran against the main checkout.
   */
  async openThread(id: string): Promise<void> {
    if (!this.client) return;
    // Reassigned when an unusable thread is replaced by a fresh one below.
    let threadId = id;
    let t = this.threads.get(threadId);

    // Fast path: already in memory with history loaded. Show it immediately.
    if (t && t.loaded !== false) {
      this.activate(t);
      return;
    }

    // Cold open. The blocking part is fetching history from app-server
    // (`resumeThread` + `readThread`), which is the 1-3s the user feels. So we
    // show a skeleton built from persisted state *first* — name, worktree,
    // draft, queue are all on disk — then load the turns in the background and
    // emit an updated view when they arrive. The thread frame appears at once
    // instead of after the round-trips.
    if (!t) {
      const cat = this.catalog.find((c) => c.threadId === threadId);
      const saved = this.store.get().threads[threadId];
      const resumeCwd =
        saved?.worktreePath ?? saved?.cwd ?? cat?.cwd ?? this.workspace;
      if (!resumeCwd) return;

      // The catalog entry is exactly what the sidebar was already showing for
      // this row (name + first-message preview), so seeding the skeleton from
      // it keeps the title stable through the switch. Without this the row
      // briefly degraded to "(empty thread)" until history loaded, because the
      // sparse persisted store has no preview. Fall back to the store for
      // fields the catalog lacks.
      const assignedProjectId = this.projectAssignment(threadId);
      const rootHint = this.workspaceRootHint(threadId);
      t = emptyThread(threadId, resumeCwd, this.createOutbox(saved?.outbox), {
        name: cat?.name ?? saved?.name ?? null,
        preview: cat?.preview ?? "",
        // Opening a cold thread is navigation, not activity. `emptyThread`
        // defaults this to Date.now(), which made a selected historical row
        // jump to the top of recency-sorted project groups. Preserve the same
        // timestamp the sidebar catalog displayed before the click.
        updatedAtMs: cat?.updatedAtMs ?? saved?.updatedAtMs ?? Date.now(),
        worktreePath: saved?.worktreePath ?? cat?.worktreePath ?? null,
        worktreeBaseSha: saved?.worktreeBaseSha ?? null,
        draft: saved?.draft ?? "",
        pinned: saved?.pinned ?? cat?.pinned ?? false,
        projectId: this.navigationProject(
          rootHint ?? resumeCwd,
          assignedProjectId,
        ),
        projectIdExplicit: assignedProjectId !== undefined,
        repoRoot: saved?.worktreePath ? (rootHint ?? null) : null,
        reviewNotes: saved?.reviewNotes ?? [],
        // Must be hydrated before `loadHistory` resumes the thread: resume
        // re-sends the posture, and reading it off an unhydrated skeleton
        // would silently widen a read-only thread to the current default.
        approvalMode: saved?.approvalMode,
        loaded: false,
      });
      this.threads.set(threadId, t);
    }

    // Optimistic switch: the skeleton (or a not-yet-loaded thread) is visible
    // now. History fills in below.
    this.activate(t);
    await this.loadHistory(threadId);
  }

  /** Make an already-built thread the active, visible one. */
  private activate(t: ThreadRuntime): void {
    const threadId = t.threadId;
    t.unread = false;
    this.activeThreadId = threadId;
    this.store.update((s) => {
      s.lastThreadId = threadId;
    });
    this.emit({ type: "activeThread", threadId });
    this.emit({ type: "threadView", view: this.toView(t) });
    this.pushThreads();
  }

  /**
   * Fetch a cold thread's turns from app-server and merge them into the
   * skeleton already on screen. Runs after `activate`, so a slow load never
   * blocks the visible switch.
   */
  private async loadHistory(threadId: string): Promise<void> {
    if (!this.client) return;
    const t = this.threads.get(threadId);
    if (!t || t.loaded) return;

    const resumeCwd = t.worktreePath ?? t.cwd ?? this.workspace;
    if (!resumeCwd) return;

    try {
      const thread = await this.client.resumeThread(threadId, {
        cwd: resumeCwd,
        model: this.config.currentModel,
        effort: this.config.currentReasoningEffort,
        serviceTier: this.config.currentServiceTier,
        // Resume re-accepts the config, so the posture has to be re-sent. We
        // send the thread's *own* saved mode: a thread that was read-only
        // last week comes back read-only rather than silently widening to
        // whatever the current default happens to be (§8.2).
        approvalsReviewer: this.approvalsReviewer(),
        ...threadParamsFor(this.approvalMode(threadId)),
      });
      const full = await this.client.readThread(threadId, true);
      // The skeleton is the source of truth for client-side state (draft,
      // queue); only history and server-derived fields are merged in.
      t.cwd = thread.cwd ?? resumeCwd;
      t.name = full.name ?? t.name;
      t.preview = full.preview ?? t.preview;
      t.entries = [];
      t.completedTurnIds = [];
      for (const turn of full.turns ?? []) {
        const turnDurationMs = completedTurnDurationMs(turn);
        for (const item of turn.items) {
          t.entries.push({
            kind: "item",
            id: item.id,
            item,
            turnId: turn.id,
            ...(turnDurationMs !== undefined ? { turnDurationMs } : {}),
          });
        }
        t.completedTurnIds = [...(t.completedTurnIds ?? []), turn.id];
      }
      t.loaded = true;
      void this.refreshWorktreeDiff(t);
    } catch (err) {
      const message = errText(err);
      const saved = this.store.get().threads[threadId];
      // A thread with no turns has no rollout on disk, so `thread/resume`
      // answers `no rollout found`. Reconstructing it locally is not enough —
      // app-server would then reject `turn/start` with "thread not found".
      // Start a *fresh* server thread and carry the local state (draft, queue,
      // worktree) onto it, so the row keeps working instead of becoming a dead
      // end.
      if (!/no rollout/i.test(message) || !saved) {
        this.emit({
          type: "log",
          level: "error",
          message: `failed to open thread: ${message}`,
        });
        // The optimistic switch put a skeleton on screen; a genuine load
        // failure means it can never resolve, so roll the switch back rather
        // than leave a dead thread visible.
        this.threads.delete(threadId);
        if (this.activeThreadId === threadId) {
          this.activeThreadId = null;
          this.emit({ type: "activeThread", threadId: null });
        }
        return;
      }

      const cwd = saved.worktreePath ?? saved.cwd;
      let replacement;
      try {
        replacement = await this.client.startThread({
          cwd,
          model: this.config.currentModel,
          effort: this.config.currentReasoningEffort,
          serviceTier: this.config.currentServiceTier,
          approvalsReviewer: this.approvalsReviewer(),
          // The thread being replaced kept its own posture; carry it over
          // rather than starting the stand-in under the default.
          ...threadParamsFor(saved.approvalMode ?? this.approvalMode()),
        });
      } catch (startErr) {
        this.emit({
          type: "log",
          level: "error",
          message: `failed to open thread: ${errText(startErr)}`,
        });
        return;
      }

      const fresh = emptyThread(
        replacement.id,
        cwd,
        this.createOutbox(saved.outbox),
        {
          name: saved.name,
          worktreePath: saved.worktreePath,
          worktreeBaseSha: saved.worktreeBaseSha ?? null,
          draft: saved.draft,
          pinned: saved.pinned,
          reviewNotes: saved.reviewNotes ?? [],
          projectId: this.navigationProject(
            this.workspaceRootHint(threadId) ?? cwd,
            this.projectAssignment(threadId),
          ),
          projectIdExplicit: this.projectAssignment(threadId) !== undefined,
          repoRoot: this.workspaceRootHint(threadId) ?? null,
          // The replacement stands in for the same thread, so it keeps its
          // posture rather than reverting to the default.
          approvalMode: saved.approvalMode,
          loaded: true,
        },
      );
      this.threads.set(replacement.id, fresh);
      this.persist(fresh);

      // The old id never had server-side content; drop it so the picker does
      // not show a row that cannot be opened.
      this.threads.delete(threadId);
      this.store.update((st) => {
        delete st.threads[threadId];
        st.pinnedOrder = st.pinnedOrder.map((pid) =>
          pid === threadId ? replacement.id : pid,
        );
      });
      this.workspaceRegistry.clearPlacement(threadId);
      this.catalog = this.catalog.filter((c) => c.threadId !== threadId);
      this.emit({
        type: "log",
        level: "info",
        message: "restarted an empty thread that had no saved history",
      });

      // Only re-point the UI if the user is still looking at the thread that
      // got replaced; a quick switch elsewhere must win.
      if (this.activeThreadId === threadId) {
        this.activate(fresh);
      }
      return;
    }

    // A slow load must not clobber a newer switch: if the user moved on while
    // history was in flight, keep the thread updated in memory but do not
    // steal the visible view back.
    if (this.activeThreadId === threadId) {
      this.emit({ type: "threadView", view: this.toView(t) });
    }
    this.pushThreads();
  }

  /**
   * Fork from a turn boundary (3.5).
   *
   * A fork gets its **own** worktree. Sharing the source thread's checkout
   * let two independent agents edit the same files concurrently, which
   * defeats the isolation and makes the checkpoint meaningless.
   */
  async forkThread(
    threadId: string,
    lastTurnId?: string,
  ): Promise<string | null> {
    const src = this.threads.get(threadId);
    if (!this.client || !src) return null;

    let forkCwd = src.cwd;
    let worktreePath: string | null = null;
    let baseSha: string | null = null;

    if (src.worktreePath) {
      const origin = src.repoRoot ?? this.workspace;
      if (!origin) return null;
      const wt = await this.setupWorktree(origin, "fork");
      if (!wt) return null;
      forkCwd = wt.path;
      worktreePath = wt.path;
      baseSha = wt.baseSha;
    }

    try {
      const thread = await this.client.forkThread(
        threadId,
        {
          cwd: forkCwd,
          model: this.config.currentModel,
          effort: this.config.currentReasoningEffort,
          serviceTier: this.config.currentServiceTier,
          approvalsReviewer: this.approvalsReviewer(),
          // A fork continues the same work, so it inherits the source
          // thread's posture rather than the global default.
          ...threadParamsFor(this.approvalMode(threadId)),
        },
        lastTurnId,
      );
      const t = emptyThread(thread.id, forkCwd, this.createOutbox(), {
        projectId: src.projectId,
        projectIdExplicit: true,
        worktreePath,
        worktreeBaseSha: baseSha,
        repoRoot: src.repoRoot,
        name: src.name ? `${src.name} (fork)` : null,
        approvalMode: src.approvalMode,
        // History is copied in inline below, so no background load is needed.
        loaded: true,
      });
      const full = await this.client.readThread(thread.id, true);
      for (const turn of full.turns ?? []) {
        const turnDurationMs = completedTurnDurationMs(turn);
        for (const item of turn.items) {
          t.entries.push({
            kind: "item",
            id: item.id,
            item,
            turnId: turn.id,
            ...(turnDurationMs !== undefined ? { turnDurationMs } : {}),
          });
        }
        t.completedTurnIds = [...(t.completedTurnIds ?? []), turn.id];
      }
      t.preview = full.preview;
      this.threads.set(thread.id, t);
      this.persist(t);
      await this.openThread(thread.id);
      return thread.id;
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `thread/fork failed: ${errText(err)}`,
      });
      return null;
    }
  }

  async closeThread(threadId: string): Promise<void> {
    await this.client?.unsubscribe(threadId);
    this.threads.delete(threadId);
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.emit({ type: "activeThread", threadId: null });
    }
    this.pushThreads();
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const t = this.threads.get(threadId);
    try {
      await this.client?.setThreadName(threadId, name);
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `rename failed: ${errText(err)}`,
      });
      return;
    }
    if (t) {
      t.name = name;
      this.persist(t);
    }
    this.pushThreads();
  }

  /**
   * Archive, tolerating a thread the server has no rollout for.
   *
   * A thread with no turns has nothing on disk, so app-server answers
   * `no rollout found`. That is not a reason to leave the row in the picker:
   * the user asked for it gone, and locally it is.
   */
  async archiveThread(threadId: string, archived: boolean): Promise<void> {
    try {
      await this.client?.archiveThread(threadId, archived);
    } catch (err) {
      const message = errText(err);
      if (!/no rollout/i.test(message)) {
        this.emit({
          type: "log",
          level: "error",
          message: `archive failed: ${message}`,
        });
        return;
      }
      this.emit({
        type: "log",
        level: "info",
        message: "archived locally (thread had no saved history)",
      });
    }

    const t = this.threads.get(threadId);
    if (t) t.archived = archived;
    const catalogEntry = this.catalog.find((c) => c.threadId === threadId);
    if (catalogEntry) catalogEntry.archived = archived;
    if (archived) {
      if (this.activeThreadId === threadId) {
        this.activeThreadId = null;
        this.emit({ type: "activeThread", threadId: null });
      }
    }
    this.pushThreads();
  }

  /**
   * `thread/delete` is broken in 0.144.4 (upstream: "no such table:
   * agent_jobs" — migration 0042 drops it while the delete path still
   * references it). Archive first so the thread leaves the picker either
   * way, then attempt the delete and report failure rather than pretending.
   */
  async deleteThread(threadId: string): Promise<void> {
    await this.archiveThread(threadId, true);
    try {
      await this.client?.deleteThread(threadId);
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `thread/delete failed (archived instead): ${errText(err)}`,
      });
    }
    this.threads.delete(threadId);
    this.store.update((s) => {
      delete s.threads[threadId];
      s.pinnedOrder = s.pinnedOrder.filter((id) => id !== threadId);
    });
    this.workspaceRegistry.clearPlacement(threadId);
    this.catalog = this.catalog.filter((c) => c.threadId !== threadId);
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.emit({ type: "activeThread", threadId: null });
    }
    this.pushThreads();
  }

  /** Pinning is entirely client state — `ThreadListParams` has no filter. */
  pinThread(threadId: string, pinned: boolean): void {
    const t = this.threads.get(threadId);
    if (t) {
      t.pinned = pinned;
      this.persist(t);
    }
    this.store.update((s) => {
      const existing = s.threads[threadId];
      if (existing) existing.pinned = pinned;
      s.pinnedOrder = pinned
        ? [...s.pinnedOrder.filter((id) => id !== threadId), threadId]
        : s.pinnedOrder.filter((id) => id !== threadId);
    });
    this.pushThreads();
  }

  async interrupt(threadId: string): Promise<void> {
    await this.client?.interrupt(threadId);
  }

  async compactThread(threadId: string): Promise<boolean> {
    if (!this.client || !this.threads.has(threadId)) return false;
    try {
      await this.client.compact(threadId);
      return true;
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `thread/compact/start failed: ${errText(err)}`,
      });
      return false;
    }
  }

  answerRequest(requestId: string | number, answer: RequestAnswer): void {
    this.client?.answerRequest(requestId, answer);
  }

  async startReview(
    threadId: string,
    target: ReviewTarget,
  ): Promise<string | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.startReview(threadId, target);
      const src = this.threads.get(threadId);
      const t = emptyThread(
        res.reviewThreadId,
        src?.cwd ?? this.workspace ?? "",
        this.createOutbox(),
        {
          name: "Review",
          worktreePath: src?.worktreePath ?? null,
          projectId: src?.projectId ?? null,
          projectIdExplicit: true,
          repoRoot: src?.repoRoot ?? null,
          loaded: true,
        },
      );
      this.threads.set(res.reviewThreadId, t);
      this.persist(t);
      await this.openThread(res.reviewThreadId);
      return res.reviewThreadId;
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `review/start failed: ${errText(err)}`,
      });
      return null;
    }
  }

  // ----------------------------------------------------------- catalog/boot

  /**
   * Backfill the project registry and explicit thread ownership from the
   * global historical catalog.
   *
   * Earlier persistence kept workspace records without complete conversation
   * placement. Resolve each unknown cwd through Git first
   * (which maps linked worktrees back to their primary checkout), import the
   * remaining real roots, and then persist the assignment. Temp/generated
   * roots stay unclassified unless the user already added them as projects.
   */
  private async reconcileHistoricalProjects(threads: Thread[]): Promise<void> {
    const registry = this.workspaceRegistry.snapshot();
    const placements = { ...registry.placements };
    const dismissed = registry.dismissedRoots.map((root) =>
      this.canonicalPath(root),
    );
    const canonicalWorkspaces = registry.workspaces.map((workspace) => {
      const roots = [
        ...new Set(workspace.roots.map((root) => this.canonicalPath(root))),
      ];
      const selectedRoot = roots.includes(
        this.canonicalPath(workspace.selectedRoot),
      )
        ? this.canonicalPath(workspace.selectedRoot)
        : (roots[0] ?? this.canonicalPath(workspace.selectedRoot));
      return { ...workspace, roots, selectedRoot };
    });
    const rootsToResolve = [
      ...new Set([
        ...threads.map((thread) => this.canonicalPath(thread.cwd)),
        ...canonicalWorkspaces.flatMap((workspace) => workspace.roots),
      ]),
    ];
    const resolvedGitRoots = new Map<string, string | null>();
    await Promise.all(
      rootsToResolve.map(async (root) => {
        try {
          const gitRoot = await this.git.projectRoot(root);
          resolvedGitRoots.set(
            root,
            gitRoot ? this.canonicalPath(gitRoot) : null,
          );
        } catch {
          resolvedGitRoots.set(root, null);
        }
      }),
    );

    const historicalGitRoots = [
      ...new Set(
        threads.flatMap((thread) => {
          const root = resolvedGitRoots.get(this.canonicalPath(thread.cwd));
          return root ? [root] : [];
        }),
      ),
    ];

    // Old builds persisted auto-discovered folders as if the user had added
    // them. Remove only roots we can identify safely: internal/generated
    // storage, plus legacy non-Git ancestors that swallowed several distinct
    // repositories. Deliberately added non-Git folders remain valid projects.
    const workspaces = canonicalWorkspaces.flatMap((workspace) => {
      const roots = workspace.roots.filter((root) => {
        if (this.isNeverAutoProjectRoot(root)) return false;
        const isLegacyRepositoryBucket =
          workspace.registeredAt === 0 &&
          !resolvedGitRoots.get(root) &&
          historicalGitRoots.filter((gitRoot) => pathContains(root, gitRoot))
            .length > 1;
        return !isLegacyRepositoryBucket;
      });
      if (roots.length === 0) return [];
      return [
        {
          ...workspace,
          roots,
          selectedRoot: roots.includes(workspace.selectedRoot)
            ? workspace.selectedRoot
            : roots[0]!,
        },
      ];
    });
    const projects = workspaces.map(workspaceRecordToProject);

    const candidates = new Map<string, string>();
    const sourceRoots = new Map<string, string>();
    for (const thread of threads) {
      const placement = placements[thread.id];
      const assigned =
        placement?.kind === "registered"
          ? placement.workspaceId
          : placement?.kind === "unassigned"
            ? null
            : undefined;
      if (assigned === null) continue;

      const canonicalCwd = this.canonicalPath(thread.cwd);
      const hinted =
        placement?.kind === "registered"
          ? placement.navigationRoot
          : placement?.kind === "unregistered"
            ? placement.root
            : undefined;
      const gitRoot = resolvedGitRoots.get(canonicalCwd);
      const sourceRoot = this.canonicalPath(gitRoot ?? hinted ?? canonicalCwd);
      sourceRoots.set(thread.id, sourceRoot);

      // Only Git can promote historical catalog data into a project. An
      // ordinary folder remains a recent chat until the user adds it.
      if (!gitRoot) continue;
      if (projectForCwd(sourceRoot, projects)) continue;
      if (!this.shouldDiscoverProjectRoot(sourceRoot, dismissed)) continue;
      candidates.set(sourceRoot, sourceRoot);
    }

    const knownRoots = new Set(
      workspaces.flatMap((workspace) => workspace.roots),
    );
    for (const root of [...candidates.keys()].sort(
      (a, b) => b.length - a.length || a.localeCompare(b),
    )) {
      if (knownRoots.has(root) || projectForCwd(root, projects)) continue;
      const workspace: WorkspaceRecord = {
        id: randomUUID(),
        label: path.basename(root) || "Project",
        roots: [root],
        selectedRoot: root,
        registeredAt: Date.now(),
      };
      workspaces.push(workspace);
      projects.push(workspaceRecordToProject(workspace));
      knownRoots.add(root);
    }

    for (const thread of threads) {
      const placement = placements[thread.id];
      const assigned =
        placement?.kind === "registered"
          ? placement.workspaceId
          : placement?.kind === "unassigned"
            ? null
            : undefined;
      if (assigned === null) continue;
      const sourceRoot =
        sourceRoots.get(thread.id) ??
        (placement?.kind === "registered"
          ? placement.navigationRoot
          : placement?.kind === "unregistered"
            ? placement.root
            : undefined) ??
        this.canonicalPath(thread.cwd);
      const assignedWorkspace =
        typeof assigned === "string"
          ? workspaces.find((workspace) => workspace.id === assigned)
          : undefined;
      const assignedWorkspaceOwnsRoot = assignedWorkspace?.roots.some((root) =>
        pathContains(root, sourceRoot),
      );
      const owner =
        assignedWorkspace && assignedWorkspaceOwnsRoot
          ? assignedWorkspace.id
          : projectForCwd(sourceRoot, projects);
      placements[thread.id] = owner
        ? {
            kind: "registered",
            workspaceId: owner,
            navigationRoot: sourceRoot,
          }
        : { kind: "unregistered", root: sourceRoot };
    }

    const projectsChanged =
      JSON.stringify(workspaces) !== JSON.stringify(registry.workspaces);
    this.workspaceRegistry.replace({
      workspaces,
      activeWorkspaceId:
        registry.activeWorkspaceId &&
        workspaces.some(
          (workspace) => workspace.id === registry.activeWorkspaceId,
        )
          ? registry.activeWorkspaceId
          : null,
      placements,
      dismissedRoots: dismissed,
    });
    this.reassignProjects();
    if (projectsChanged) this.pushProjects();
  }

  /** Roots that may appear in Recents but must never become project headers. */
  private isNeverAutoProjectRoot(root: string): boolean {
    const canonical = this.canonicalPath(root);
    const applicationSupport = this.canonicalPath(
      path.join(homedir(), "Library", "Application Support"),
    );
    if (
      pathContains(applicationSupport, canonical) ||
      pathContains(this.canonicalPath(this.deps.worktreeContainer), canonical)
    ) {
      return true;
    }
    const codexDocuments = this.canonicalPath(
      path.join(homedir(), "Documents", "Codex"),
    );
    const relative = path.relative(codexDocuments, canonical);
    const segments = relative.split(path.sep).filter(Boolean);
    return (
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      segments.length >= 2 &&
      /^\d{4}-\d{2}-\d{2}$/.test(segments[0]!)
    );
  }

  /** Whether an unassigned catalog task is useful enough for Recents. */
  private isRecentEligibleRoot(root: string): boolean {
    const canonical = this.canonicalPath(root);
    const blocked = [
      this.canonicalPath(tmpdir()),
      this.canonicalPath("/tmp"),
      this.canonicalPath("/private/tmp"),
      this.canonicalPath("/var/tmp"),
      this.canonicalPath("/private/var/tmp"),
      this.canonicalPath(this.deps.worktreeContainer),
      this.canonicalPath(
        path.join(homedir(), "Library", "Application Support"),
      ),
    ];
    if (canonical === path.parse(canonical).root) return false;
    if (canonical === this.canonicalPath(homedir())) return false;
    if (/[/\\]worktrees[/\\][0-9a-f]{8}$/i.test(canonical)) return false;
    return !blocked.some((base) => pathContains(base, canonical));
  }

  private shouldDiscoverProjectRoot(
    root: string,
    dismissed: string[],
  ): boolean {
    const canonical = this.canonicalPath(root);
    if (
      !this.isRecentEligibleRoot(canonical) ||
      this.isNeverAutoProjectRoot(canonical)
    ) {
      return false;
    }
    return !dismissed.some((base) => pathContains(base, canonical));
  }

  async refreshCatalog(): Promise<void> {
    if (!this.client) return;
    try {
      const pages = await Promise.all([
        this.listCatalog(false),
        this.listCatalog(true),
      ]);
      const allThreads = pages.flatMap((page) => page.threads);
      await this.reconcileHistoricalProjects(allThreads);
      const persisted = this.store.get().threads;
      const byId = new Map<string, ThreadListEntry>();
      const hiddenCatalogThreadIds = new Set<string>();
      for (const { archived, threads } of pages) {
        for (const th of threads) {
          const saved = persisted[th.id];
          const sourceRoot = this.workspaceRootHint(th.id);
          const projectId = this.navigationProject(
            sourceRoot ?? th.cwd,
            this.projectAssignment(th.id),
          );
          if (
            projectId === null &&
            !this.isRecentEligibleRoot(sourceRoot ?? th.cwd)
          ) {
            hiddenCatalogThreadIds.add(th.id);
          }
          byId.set(th.id, {
            threadId: th.id,
            name: th.name,
            preview: th.preview,
            cwd: th.cwd,
            projectId,
            run: { kind: "offline" as const },
            pinned: saved?.pinned ?? false,
            archived,
            unread: false,
            updatedAtMs:
              saved?.updatedAtMs ??
              (th.recencyAt ?? th.updatedAt ?? th.createdAt) * 1_000,
            worktreePath: saved?.worktreePath ?? null,
            checkout:
              saved?.worktreePath && sourceRoot && saved.worktreeBaseSha
                ? {
                    kind: "available" as const,
                    root: saved.worktreePath,
                    sourceRoot,
                    baseRevision: saved.worktreeBaseSha,
                  }
                : saved?.worktreePath
                  ? {
                      kind: "failed" as const,
                      message:
                        "This isolated checkout is missing its source metadata.",
                      retryable: false,
                    }
                  : { kind: "notRequested" as const },
            loaded: false,
          });
        }
      }
      this.catalog = [...byId.values()];
      this.hiddenCatalogThreadIds = hiddenCatalogThreadIds;
      this.pushThreads();
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `thread/list failed: ${errText(err)}`,
      });
    }
  }

  /** Load the complete global catalog; projectless chats require no cwd filter. */
  private async listCatalog(
    archived: boolean,
  ): Promise<{ archived: boolean; threads: Thread[] }> {
    const threads: Thread[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client!.listThreads({
        limit: 100,
        fast: true,
        archived,
        ...(cursor ? { cursor } : {}),
      });
      threads.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { archived, threads };
  }

  /**
   * Reconcile with app-server after a restart (3.3).
   *
   * `thread/loaded/list` answers "what is still live server-side" directly,
   * so a thread we left mid-turn is re-attached rather than being guessed at.
   * Then reopen whatever the user was last looking at.
   */
  async recover(): Promise<void> {
    if (!this.client) return;

    let live: string[] = [];
    try {
      live = await this.client.loadedThreadIds();
    } catch {
      // Non-fatal: recovery degrades to "open the last thread".
    }

    for (const threadId of live) {
      if (this.threads.has(threadId)) continue;
      const saved = this.store.get().threads[threadId];
      if (!saved) continue; // not ours
      await this.openThread(threadId);
    }

    const last = this.store.get().lastThreadId;
    if (last && last !== this.activeThreadId) {
      await this.openThread(last);
    }

    // A thread the server still considers active gets its status back.
    for (const threadId of live) {
      const t = this.threads.get(threadId);
      const activeTurnId = this.client.activeTurnId(threadId);
      if (t && activeTurnId) {
        t.run = transitionAgentRun(t.run, {
          type: "turnStarted",
          turnId: activeTurnId,
          startedAt: Date.now(),
        });
      }
    }
    this.pushThreads();
  }

  async useWorkspace(dir: string): Promise<boolean> {
    // `thread/start` does not validate `cwd` (verified against 0.144.4), so
    // validate here or the failure surfaces later as a mid-turn error.
    let canonical: string;
    try {
      canonical = this.canonicalize(dir);
    } catch (err) {
      this.emit({
        type: "log",
        level: "error",
        message: `cannot use workspace ${dir}: ${errText(err)}`,
      });
      return false;
    }

    this.workspace = canonical;
    this.syncCapabilityContext();
    this.store.update((s) => {
      s.recents = [
        canonical,
        ...s.recents.filter((r) => r !== canonical),
      ].slice(0, 8);
    });
    // Every workspace the user picks becomes a project entry, so the
    // picker is a list of names rather than a list of paths (4.1).
    this.addProject("", canonical);
    this.emit({
      type: "workspace",
      cwd: canonical,
      recents: this.store.get().recents,
    });
    await this.refreshCatalog();
    return true;
  }

  setNotifyMode(mode: NotifyMode): void {
    this.store.update((s) => {
      s.notifyMode = mode;
    });
  }

  /**
   * Read the usage report (§8.6).
   *
   * Pulled on demand rather than pushed: it is a settings-page number, not a
   * live one, and polling it would spend requests on something nobody is
   * looking at.
   */
  async readUsage(): Promise<UsageReport | null> {
    return (await this.client?.readUsage()) ?? null;
  }

  /**
   * Redeem a rate-limit reset credit (§8.6).
   *
   * The idempotency key is minted here and held for the thread of this
   * attempt, so a user who clicks twice redeems one credit rather than two.
   */
  async consumeResetCredit(): Promise<boolean> {
    if (!this.client || this.resetCreditInFlight) return false;
    this.resetCreditInFlight = randomUUID();
    try {
      return await this.client.consumeResetCredit(this.resetCreditInFlight);
    } finally {
      this.resetCreditInFlight = null;
    }
  }

  /** The app's current approval posture (§8.2). */
  private approvalsReviewer(): ApprovalsReviewer {
    return this.store.get().approvalsReviewer ?? "user";
  }

  /**
   * Change who answers approvals (§8.2).
   *
   * This only affects threads started or resumed *after* it — the protocol
   * takes `approvalsReviewer` at thread config time, and there is no method
   * to change it on a live thread. Saying so in the UI matters: silently
   * applying it to nothing is how a safety setting becomes a lie.
   */
  setApprovalsReviewer(reviewer: ApprovalsReviewer): void {
    this.store.update((s) => {
      s.approvalsReviewer = reviewer;
    });
    this.config = { ...this.config, approvalsReviewer: reviewer };
    this.emit({ type: "config", config: this.config });
  }

  /**
   * The posture a thread runs under: its own mode when it has chosen one,
   * otherwise the global default. A thread that has never been given a mode
   * follows the default as it changes, which is what makes the default
   * meaningful rather than a value only new threads ever see.
   *
   * The result is narrowed to what the operator permits. A saved mode
   * outlives the policy that allowed it, so a thread saved as full-access
   * must not keep running that way after an admin tightens the rules.
   */
  private approvalMode(threadId?: string | null): ApprovalMode {
    const thread = threadId ? this.threads.get(threadId) : null;
    const saved =
      thread?.approvalMode ??
      this.store.get().approvalMode ??
      DEFAULT_APPROVAL_MODE;
    const allowed = this.config.allowedApprovalModes;
    return allowed ? effectiveApprovalMode(saved, allowed) : saved;
  }

  /**
   * Change the approval posture (§8.2).
   *
   * With a `threadId` this sets that thread's own mode; with null it sets the
   * default for threads that have not chosen one. Unlike `approvalsReviewer`,
   * this reaches the *running* thread: `turn/start` accepts the policy and
   * sandbox "for this turn and subsequent turns", so the next message sent
   * uses the new posture rather than waiting for a fresh thread.
   */
  setApprovalMode(threadId: string | null, mode: ApprovalMode): void {
    // Operator policy is enforced here, not only in the picker: the renderer
    // is not the security boundary, and a stale window could still hold a
    // control for a mode an admin has since forbidden.
    const allowed = this.config.allowedApprovalModes;
    if (allowed && !allowed.includes(mode)) return;
    if (threadId) {
      const t = this.threads.get(threadId);
      if (!t) return;
      t.approvalMode = mode;
      this.persist(t);
      this.pushView(threadId);
      return;
    }
    this.store.update((s) => {
      s.approvalMode = mode;
    });
    this.config = { ...this.config, approvalMode: mode };
    this.emit({ type: "config", config: this.config });
  }

  // ------------------------------------------- capabilities (§4.5 / V2.4)

  async refreshSkills(force = false): Promise<void> {
    this.syncCapabilityContext();
    await this.capabilityDomain.refreshSkills(force);
  }

  async setSkillEnabled(path: string, enabled: boolean): Promise<void> {
    this.syncCapabilityContext();
    await this.capabilityDomain.setSkillEnabled(path, enabled);
  }

  async refreshCapabilities(): Promise<void> {
    this.syncCapabilityContext();
    await this.capabilityDomain.refreshInventory();
  }

  applyMcpStatusUpdate(update: McpStatusUpdate): void {
    this.syncCapabilityContext();
    this.capabilityDomain.applyMcpStatus(update);
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    this.syncCapabilityContext();
    await this.capabilityDomain.setPluginEnabled(pluginId, enabled);
  }

  async reloadMcpServers(): Promise<void> {
    this.syncCapabilityContext();
    await this.capabilityDomain.reloadMcpServers();
  }

  async loadWebSearchMode(): Promise<void> {
    this.syncCapabilityContext();
    await this.capabilityDomain.loadWebSearch();
  }

  async setWebSearchMode(mode: WebSearchMode): Promise<void> {
    this.syncCapabilityContext();
    await this.capabilityDomain.setWebSearchMode(mode);
  }

  setUseWorktrees(enabled: boolean): void {
    this.store.update((s) => {
      s.useWorktrees = enabled;
    });
  }

  setModel(model: string | null): void {
    const selected = this.config.models.find(
      (candidate) => candidate.id === model,
    );
    const keepEffort =
      this.config.currentReasoningEffort === null ||
      !selected ||
      selected.supportedReasoningEfforts.some(
        (option) =>
          option.reasoningEffort === this.config.currentReasoningEffort,
      );
    const keepServiceTier =
      this.config.currentServiceTier === null ||
      !selected ||
      selected.serviceTiers.some(
        (tier) => tier.id === this.config.currentServiceTier,
      );
    this.config = {
      ...this.config,
      currentModel: model,
      currentReasoningEffort: keepEffort
        ? this.config.currentReasoningEffort
        : null,
      currentServiceTier: keepServiceTier
        ? this.config.currentServiceTier
        : null,
    };
    this.store.update((s) => {
      s.currentModel = this.config.currentModel;
      s.currentReasoningEffort = this.config.currentReasoningEffort;
      s.currentServiceTier = this.config.currentServiceTier;
    });
    this.emit({ type: "config", config: this.config });
  }

  setReasoningEffort(effort: ReasoningEffort | null): void {
    const selected = this.config.models.find(
      (candidate) => candidate.id === this.config.currentModel,
    );
    if (
      effort &&
      selected &&
      !selected.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === effort,
      )
    ) {
      return;
    }
    this.config = { ...this.config, currentReasoningEffort: effort };
    this.store.update((s) => {
      s.currentReasoningEffort = effort;
    });
    this.emit({ type: "config", config: this.config });
  }

  setServiceTier(tier: string | null): void {
    const selected =
      this.config.models.find(
        (candidate) => candidate.id === this.config.currentModel,
      ) ??
      this.config.models.find((candidate) => candidate.isDefault) ??
      this.config.models[0];
    if (
      tier &&
      (!selected || !selected.serviceTiers.some((item) => item.id === tier))
    ) {
      return;
    }
    this.config = { ...this.config, currentServiceTier: tier };
    this.store.update((state) => {
      state.currentServiceTier = tier;
    });
    this.emit({ type: "config", config: this.config });
  }

  async searchFiles(query: string, requestedRoot?: string): Promise<unknown[]> {
    if (!this.client) return [];
    const active = this.activeThreadId
      ? this.threads.get(this.activeThreadId)
      : null;
    // New-chat mentions search the project selected in its context bar. The
    // hint crosses IPC, so accept it only when it is already a known project,
    // workspace, or loaded worktree root.
    const allowedRoots = [
      this.workspace,
      ...this.projects().flatMap((project) => project.roots),
      ...this.worktreeRoots(),
    ]
      .filter((root): root is string => Boolean(root))
      .map((root) => this.canonicalPath(root));
    const hintedRoot = requestedRoot ? this.canonicalPath(requestedRoot) : null;
    const root =
      (hintedRoot && allowedRoots.includes(hintedRoot) ? hintedRoot : null) ??
      active?.worktreePath ??
      active?.cwd ??
      this.workspace;
    if (!root) return [];

    // On a bare `@` there is nothing to fuzzy-match against, so
    // `fuzzyFileSearch` returns nothing. Show the root's own files instead —
    // the same list the file tree would, so the mention picker opens with
    // suggestions rather than an empty box.
    if (!query.trim()) {
      const listed = (await this.deps.listDir?.(root)) ?? [];
      return listed.filter((f) => !IGNORED_MENTION_PATHS.test(f.path));
    }

    try {
      const res = await this.client.searchFiles(query, [root]);
      // `.git` internals (hook samples especially) crowd out real matches and
      // are never what an @mention means.
      return res.files.filter((f) => {
        const p = (f as { path?: string }).path ?? "";
        return !IGNORED_MENTION_PATHS.test(p);
      });
    } catch {
      return [];
    }
  }

  /** Worktree paths of loaded threads — allowlisted for file reads. */
  worktreeRoots(): string[] {
    return [...this.threads.values()]
      .map((t) => t.worktreePath)
      .filter((p): p is string => Boolean(p));
  }

  /** Remove worktrees for threads that no longer exist. Best effort. */
  async cleanupWorktree(threadId: string, force = false): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t?.worktreePath || !t.repoRoot) return;
    await this.git.removeWorktree(t.repoRoot, t.worktreePath, force);
  }
}

/** Paths an @mention should never offer. */
export const IGNORED_MENTION_PATHS =
  /(^|\/)(\.git|node_modules|\.venv|__pycache__|\.next|dist|build)(\/|$)/;

/** Preserve the server's exact turn timing when transcript history reloads. */
function completedTurnDurationMs(
  turn: Thread["turns"][number],
): number | undefined {
  if (turn.durationMs !== null) return turn.durationMs;
  if (turn.startedAt === null || turn.completedAt === null) return undefined;
  return Math.max(0, (turn.completedAt - turn.startedAt) * 1_000);
}

/** Segment-aware containment; `/repo-two` is not inside `/repo`. */
function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Shape one parsed file for the renderer. Shared by both scopes. */
function toFileView(f: DiffFile) {
  return {
    path: f.path,
    oldPath: f.oldPath,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    suppressed: f.suppressed,
    suppressedReason: f.suppressedReason,
    hunks: f.hunks.map((h) => ({
      hunkId: h.hunkId,
      hunkIndex: h.hunkIndex,
      header: h.header,
      context: h.context,
      lines: h.lines,
    })),
  };
}

/**
 * A queued message as protocol input (§8.1).
 *
 * Attachments come first because `UserInput` has no ordering guarantee and
 * the text reads as a caption for what precedes it — the same shape
 * `composeInput` uses for a live send.
 */
function outboxInput(entry: OutboxEntry): UserInput[] {
  return [
    ...entry.assets.map((asset) =>
      asset.kind === "image"
        ? ({ type: "localImage", path: asset.path } as UserInput)
        : ({
            type: "mention",
            name: asset.name,
            path: asset.path,
          } as UserInput),
    ),
    { type: "text", text: entry.text, text_elements: [] },
  ];
}

/**
 * Recognise `activeTurnNotSteerable` in a rejected steer (§8.1).
 *
 * The error arrives as a JSON-RPC failure whose data carries `CodexErrorInfo`,
 * and that variant is an object rather than a bare string. This is a refusal
 * rather than a fault: the two turn kinds that produce it (`review`, `compact`)
 * never accept steering, so the caller waits for turn end instead of retrying.
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function describeRequest(kind: string): string {
  switch (kind) {
    case "commandApproval":
      return "A command needs approval.";
    case "fileChangeApproval":
      return "A file change needs approval.";
    case "permissions":
      return "Additional permissions requested.";
    case "userInput":
      return "The agent asked you a question.";
    case "elicitation":
      return "An MCP server needs input.";
    default:
      return "Attention needed.";
  }
}

export { path };
