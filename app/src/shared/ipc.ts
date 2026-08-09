/**
 * Events the main process forwards to the renderer, and the commands it
 * accepts back. Kept in one file temporarily so the preload, main, and
 * renderer agree on one vocabulary (plan §2.2).
 *
 * Dependency direction: `main/` imports from here, never the reverse. Types
 * shared by both live here even when the main process is their primary user.
 */
import type { ThreadItem } from "../protocol/generated/v2/ThreadItem";
import type { Turn } from "../protocol/generated/v2/Turn";
import type { TurnError } from "../protocol/generated/v2/TurnError";
import type { Account } from "../protocol/generated/v2/Account";
import type { CommandExecutionRequestApprovalParams } from "../protocol/generated/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeRequestApprovalParams } from "../protocol/generated/v2/FileChangeRequestApprovalParams";
import type { PermissionsRequestApprovalParams } from "../protocol/generated/v2/PermissionsRequestApprovalParams";
import type { ToolRequestUserInputParams } from "../protocol/generated/v2/ToolRequestUserInputParams";
import type { McpServerElicitationRequestParams } from "../protocol/generated/v2/McpServerElicitationRequestParams";
import type { CommandExecutionApprovalDecision } from "../protocol/generated/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "../protocol/generated/v2/FileChangeApprovalDecision";
import type { PermissionGrantScope } from "../protocol/generated/v2/PermissionGrantScope";
import type { McpServerElicitationAction } from "../protocol/generated/v2/McpServerElicitationAction";
import type { TurnPlanStep } from "../protocol/generated/v2/TurnPlanStep";
import type { ThreadTokenUsage } from "../protocol/generated/v2/ThreadTokenUsage";
import type { RateLimitSnapshot } from "../protocol/generated/v2/RateLimitSnapshot";
import type { GuardianApprovalReview } from "../protocol/generated/v2/GuardianApprovalReview";
import type { GuardianApprovalReviewAction } from "../protocol/generated/v2/GuardianApprovalReviewAction";
import type { FuzzyFileSearchResult } from "../protocol/generated/FuzzyFileSearchResult";
import type { Model } from "../protocol/generated/v2/Model";
import type { PermissionProfileSummary } from "../protocol/generated/v2/PermissionProfileSummary";
import type { ApprovalsReviewer } from "../protocol/generated/v2/ApprovalsReviewer";
import type { ApprovalMode } from "../contracts/approvals";
import type { ReviewTarget } from "../protocol/generated/v2/ReviewTarget";
import type { ReasoningEffort } from "../protocol/generated/ReasoningEffort";
import type {
  CapabilitiesState,
  CollectionState,
  SkillErrorView,
  SkillView,
  WebSearchMode,
} from "../contracts/views/capabilities";
import type { InputOutboxView } from "../contracts/views/conversations";
import type {
  AgentRunState,
  CheckoutState,
} from "../contracts/views/conversations";
import type { DeliveryProgressView } from "../contracts/views/delivery";
import type { ReviewNoteView } from "../contracts/views/review";

export type {
  CapabilitiesState,
  CollectionState,
  McpServerView,
  PluginView,
  SkillErrorView,
  SkillView,
  WebSearchMode,
} from "../contracts/views/capabilities";
export type { ReviewNoteView } from "../contracts/views/review";
export type { InputOutboxView } from "../contracts/views/conversations";
export type {
  AgentRunState,
  CheckoutState,
} from "../contracts/views/conversations";
export type { DeliveryProgressView } from "../contracts/views/delivery";

export type RuntimeInstallStage =
  | "checkingSource"
  | "downloading"
  | "verifying"
  | "installing";

export type PreflightState =
  | { kind: "checking" }
  | { kind: "runtimeMissing"; version: string; sizeBytes: number }
  | {
      kind: "runtimeInstalling";
      version: string;
      stage: RuntimeInstallStage;
      downloadedBytes: number;
      totalBytes: number;
    }
  | { kind: "runtimeError"; version: string; detail: string }
  | {
      kind: "ready";
      version: string;
      warning: string | null;
      runtimePath?: string;
    };

export type AuthState =
  | { kind: "unknown" }
  | { kind: "signedOut"; requiresOpenaiAuth: boolean }
  | { kind: "signedIn"; account: Account }
  /**
   * Authenticated, but app-server returned no `account` object.
   *
   * `account/read` answers `{ account, requiresOpenaiAuth }` and those two are
   * independent: a valid ChatGPT session can produce `account: null` with
   * `requiresOpenaiAuth: false`. Treating "no account" as signed-out told a
   * working install to sign in — verified live against 0.144.4 with a session
   * the CLI reported as `Logged in using ChatGPT`.
   */
  | { kind: "authenticated" };

/**
 * A sign-in attempt in flight (§8.5).
 *
 * The browser flow is asynchronous: `account/login/start` only *starts* it and
 * the outcome arrives later as `account/login/completed`. So the UI needs a
 * state between "signed out" and "signed in" — without it, clicking Sign in
 * appears to do nothing while the browser tab is open.
 */
export type LoginState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "awaitingBrowser"; loginId: string; authUrl: string }
  | { kind: "failed"; message: string };

/** Which sign-in method the user picked. */
export type LoginMethod =
  { kind: "chatgpt" } | { kind: "apiKey"; apiKey: string };

/**
 * A server-initiated request awaiting an answer.
 *
 * These are one lifecycle, not a collection of modals (plan §5, Phase 1):
 * every kind is stored by `requestId`, rendered inline, and resolved either by
 * the user or by `serverRequest/resolved` when the server clears it. An
 * unanswered request stalls the turn silently (§9.1), so `pending` is the
 * state that matters most in this file.
 */
export type PendingRequest = {
  requestId: string | number;
  receivedAtMs: number;
  /** Which thread asked. Several threads can have open requests at once. */
  threadId: string;
} & (
  | { kind: "commandApproval"; params: CommandExecutionRequestApprovalParams }
  | { kind: "fileChangeApproval"; params: FileChangeRequestApprovalParams }
  | { kind: "permissions"; params: PermissionsRequestApprovalParams }
  | { kind: "userInput"; params: ToolRequestUserInputParams }
  | { kind: "elicitation"; params: McpServerElicitationRequestParams }
);

/** Renderer -> main answers, discriminated the same way. */
export type RequestAnswer =
  | { kind: "commandApproval"; decision: CommandExecutionApprovalDecision }
  | { kind: "fileChangeApproval"; decision: FileChangeApprovalDecision }
  | {
      kind: "permissions";
      // `null` declines — the protocol has no explicit "deny" decision here,
      // so an empty grant is how a refusal is expressed.
      granted: {
        network?: boolean;
        readPaths?: string[];
        writePaths?: string[];
      } | null;
      scope: PermissionGrantScope;
    }
  | { kind: "userInput"; answers: Record<string, string[]> }
  | {
      kind: "elicitation";
      action: McpServerElicitationAction;
      content: unknown;
    }
  /** Answering with the shape the server expects, but declining. */
  | { kind: "decline" };

/**
 * A decision made on the user's behalf by `approvalsReviewer: "auto_review"`.
 * `[UNSTABLE]` upstream — kept behind this boundary rather than threaded
 * through the renderer (plan §12.1).
 */
export type AutoReview = {
  reviewId: string;
  targetItemId: string | null;
  status: GuardianApprovalReview["status"];
  riskLevel: GuardianApprovalReview["riskLevel"];
  rationale: string | null;
  action: GuardianApprovalReviewAction;
  startedAtMs: number;
  completedAtMs: number | null;
};

/**
 * A composer attachment (plan §6, 4.4). `UserInput` already has `localImage`
 * and `mention` variants, so this is composer work rather than protocol work.
 * Images are written to a temp file by the main process; the renderer never
 * gets filesystem authority.
 */
export type Attachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  /** Absolute path in the main process. Never used by the renderer. */
  path: string;
  /** Small preview for images, as a data URL. */
  preview?: string;
};

/**
 * The account usage report (§8.6).
 *
 * Deliberately not the protocol shape: `GetAccountTokenUsageResponse` uses
 * `bigint` for every count, and a bigint cannot survive `JSON.stringify` —
 * which is what Electron IPC does to everything crossing it. Narrowing at the
 * client facade keeps that failure out of the renderer entirely.
 */
export type UsageReport = {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyBuckets: { startDate: string; tokens: number }[];
};

export type Budget = {
  tokenUsage: ThreadTokenUsage | null;
  rateLimits: RateLimitSnapshot | null;
};

export type TurnPlan = {
  explanation: string | null;
  steps: TurnPlanStep[];
  /**
   * Which turn produced this plan (§8.3).
   *
   * `turn/plan/updated` carries a `turnId` and the app keys its own
   * `planImplementation` item by it. Without it the plan is a floating strip
   * that cannot say whether it describes what the agent is doing now or what
   * it did three turns ago.
   */
  turnId: string | null;
  /**
   * True once the turn that owns this plan has ended. A plan whose turn is
   * over is a record, not a forecast, and the two should not look alike —
   * especially when the agent stopped with steps still pending.
   */
  turnEnded: boolean;
};

/** One row of a thread transcript: server items, requests, and reviews. */
export type ThreadItemEntry =
  | {
      kind: "item";
      id: string;
      item: ThreadItem;
      /** The protocol turn that owns this item. Required for branching from
       * an exact response instead of guessing from transcript position. */
      turnId: string;
      /** Server lifecycle timestamps, used for compact work-duration labels. */
      startedAtMs?: number;
      completedAtMs?: number;
      /** Owning turn duration, preserved when completed history is reloaded. */
      turnDurationMs?: number;
    }
  | { kind: "request"; id: string; request: PendingRequest }
  | { kind: "review"; id: string; review: AutoReview }
  /**
   * A retryable stream error, as a transcript row (§9.1).
   *
   * `error` with `willRetry: true` was previously written only to
   * `lastError`, a single string the *next* error overwrites and that no
   * completed turn ever clears. A thread that reconnected five times showed
   * one banner and left no trace afterwards, so a turn that took four
   * minutes because the connection kept dropping was indistinguishable from
   * one that was simply slow.
   *
   * Each retry is recorded as transcript history. `attempt` and `max` are
   * optional because the counters are present only when the server provides
   * structured progress in its message.
   */
  | {
      kind: "retry";
      id: string;
      message: string;
      attempt: number | null;
      max: number | null;
      atMs: number;
    };

/**
 * The catalog row shown in the sidebar — deliberately small, because it must
 * render without loading full transcripts (plan §6, 3.2).
 */
export type ThreadListEntry = {
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string;
  /** Client-side navigation owner. Null means the cwd matches no project. */
  projectId: string | null;
  run: AgentRunState;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  updatedAtMs: number;
  worktreePath: string | null;
  checkout: CheckoutState;
  loaded: boolean;
};

/** Everything the renderer needs to display one thread. */
export type ThreadView = {
  threadId: string;
  cwd: string;
  worktreePath: string | null;
  name: string | null;
  entries: ThreadItemEntry[];
  deltas: Record<string, Record<string, Record<number, string>>>;
  outbox: InputOutboxView;
  draft: string;
  attachments: Attachment[];
  plan: TurnPlan | null;
  diff: string;
  budget: Budget;
  run: AgentRunState;
  checkout: CheckoutState;
  lastError: string | null;
  /** Turn ids the user can fork from, oldest first (3.5). */
  turnIds: string[];
  /** The posture this thread runs under, resolved against the default. */
  approvalMode: ApprovalMode;
  /** False while a cold thread's history is still loading from app-server, so
   * the transcript can show a loading state instead of the empty-thread copy. */
  loaded: boolean;
};

/** main -> renderer. Thread-scoped events carry `threadId`. */
export type AppEvent =
  | { type: "preflight"; state: PreflightState }
  | { type: "auth"; state: AuthState }
  | { type: "login"; state: LoginState }
  | { type: "workspace"; cwd: string | null; recents: string[] }
  | { type: "threads"; threads: ThreadListEntry[] }
  | { type: "activeThread"; threadId: string | null }
  | { type: "threadView"; view: ThreadView }
  | { type: "turnStarted"; threadId: string; turnId: string }
  | {
      type: "itemStarted";
      threadId: string;
      turnId: string;
      item: ThreadItem;
      startedAtMs: number;
    }
  | {
      type: "itemCompleted";
      threadId: string;
      turnId: string;
      item: ThreadItem;
      completedAtMs: number;
    }
  | {
      type: "itemDelta";
      threadId: string;
      itemId: string;
      kind: DeltaKind;
      index: number;
      delta: string;
    }
  | { type: "turnCompleted"; threadId: string; turn: Turn }
  | {
      type: "turnError";
      threadId: string;
      error: TurnError;
      willRetry: boolean;
    }
  | { type: "requestPending"; request: PendingRequest }
  | { type: "requestResolved"; threadId: string; requestId: string | number }
  | { type: "autoReview"; threadId: string; review: AutoReview }
  | {
      type: "outbox";
      threadId: string;
      outbox: InputOutboxView;
    }
  | { type: "diff"; threadId: string; diff: string }
  | { type: "plan"; threadId: string; plan: TurnPlan }
  | { type: "budget"; threadId: string; budget: Budget }
  | { type: "compacted"; threadId: string }
  | { type: "checkout"; threadId: string; state: CheckoutState }
  | { type: "mentions"; results: FuzzyFileSearchResult[] }
  | { type: "config"; config: ConfigState }
  /**
   * Plugins and MCP servers. Separate from `config` because MCP startup
   * transitions arrive on their own schedule — folding them in would make
   * every `starting`→`ready` edge rebroadcast the model list.
   */
  | { type: "capabilities"; capabilities: CapabilitiesState }
  | { type: "filesChanged"; paths: string[] }
  | { type: "projects"; projects: Project[]; activeProjectId: string | null }
  | { type: "terminalData"; id: string; data: string }
  | { type: "terminalExit"; id: string; code: number }
  | { type: "changes"; threadId: string; changes: ChangesView }
  | { type: "delivery"; threadId: string; state: DeliveryProgressView }
  | { type: "reviewNotes"; threadId: string; notes: ReviewNoteView[] }
  /**
   * Diagnostics with no UI surface of their own. The log panel that used to
   * render these is gone; the renderer routes them to the console. Several are
   * a failure's only report — handshake, app-server exit, a dropped
   * attachment — so they are kept rather than dropped at the emit site.
   */
  | { type: "log"; level: "info" | "error"; message: string };

// ------------------------------------------------------ changes pane (§7.1)

/**
 * The changes pane's render input. Mirrors the main-process diff model, but
 * kept as its own type so the renderer never imports from `main/`.
 */
export type DiffSideView = "left" | "right";

export type DiffLineView = {
  kind: "context" | "add" | "delete" | "meta";
  text: string;
  leftLine: number | null;
  rightLine: number | null;
};

export type DiffHunkView = {
  hunkId: string;
  hunkIndex: number;
  header: string;
  context: string;
  lines: DiffLineView[];
};

export type DiffFileView = {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  hunks: DiffHunkView[];
  suppressed: boolean;
  suppressedReason: "binary" | "too-large" | null;
};

/**
 * Two scopes, per §7.1. `turn` is what app-server streamed for the last turn;
 * `session` is the whole worktree against its base commit, computed from Git.
 */
export type ChangesScope = "session" | "turn";

export type ChangesView = {
  scope: ChangesScope;
  /** Echoed so the UI can state exactly what is being reviewed against. */
  baseSha: string | null;
  /**
   * Whether a session scope can be offered at all. False for a thread running
   * in the user's checkout, which has no base commit — the control is hidden
   * rather than offering a scope that cannot be computed.
   */
  sessionAvailable: boolean;
  files: DiffFileView[];
  additions: number;
  deletions: number;
  /** Set when the diff could not be computed, rather than showing "no changes". */
  error: string | null;
};

// ------------------------------------------------------------ comments (§7.3)

/** Where a review-note submission goes. */
export type ReviewSubmissionTarget =
  { kind: "same" } | { kind: "fork" } | { kind: "thread"; threadId: string };

/**
 * Delta streams, each with its own index space.
 *
 * Reasoning is the reason this carries an index at all: `textDelta` keys on
 * `contentIndex` and `summaryTextDelta` on `summaryIndex` — two *different*
 * counters — so reasoning needs a buffer per index per item. A single
 * append-only string interleaves blocks into nonsense (plan §5, Phase 2).
 * Streams with no index use 0.
 */
export type DeltaKind =
  "agentMessage" | "commandOutput" | "reasoningText" | "reasoningSummary";

export type ConfigState = {
  models: Model[];
  permissionProfiles: PermissionProfileSummary[];
  skills: CollectionState<SkillView>;
  /**
   * Skills that failed to parse. `SkillsListEntry` reports these alongside
   * the skills and we used to drop them on the floor, which made "why is my
   * skill not showing up" unanswerable — the protocol models the failure, so
   * surface it.
   */
  skillErrors: SkillErrorView[];
  currentModel: string | null;
  /** Null follows the chosen model's default reasoning effort. */
  currentReasoningEffort: ReasoningEffort | null;
  /** Null follows the chosen model's default service tier. */
  currentServiceTier: string | null;
  /**
   * Who answers approval requests (§8.2). Applies to threads started or
   * resumed after it changes — the protocol takes this at thread config time.
   */
  approvalsReviewer: ApprovalsReviewer;
  /**
   * Default approval posture for threads that have not chosen their own, and
   * the postures the operator permits. `allowedApprovalModes` is
   * server-supplied policy from `configRequirements/read`: null means
   * unconstrained, a list means only those.
   */
  approvalMode: ApprovalMode;
  allowedApprovalModes: ApprovalMode[] | null;
  /**
   * Effective `web_search` from `config.toml`, and the modes the operator
   * permits. `allowedWebSearchModes` is server-supplied policy: offering a
   * mode outside it presents a control an admin has disabled.
   */
  webSearchMode: WebSearchMode | null;
  allowedWebSearchModes: WebSearchMode[] | null;
};

export type Snapshot = {
  /** False when the native PTY module failed to build (3.6). */
  terminalAvailable?: boolean;
  preflight: PreflightState;
  auth: AuthState;
  cwd: string | null;
  recents: string[];
  threads: ThreadListEntry[];
  activeThreadId: string | null;
  view: ThreadView | null;
  config: ConfigState;
  capabilities: CapabilitiesState;
  notifyMode: NotifyMode;
  useWorktrees: boolean;
  projects: Project[];
  activeProjectId: string | null;
  /** Set on a window opened for one specific thread (3.2). */
  pinnedThreadId?: string | null;
  /** True in the transient prompt-capture window. */
  promptCapture?: boolean;
};

/** When a completed turn should request native attention. */
export type NotifyMode = "off" | "unfocused" | "always";

/**
 * A project is navigation state, not an agent conversation and not a Git repo
 * (plan §6, 4.1). It names one or more roots the user works in.
 */
export type Project = {
  id: string;
  name: string;
  roots: string[];
  activeRoot: string;
};

export type WorkspaceRegistrationResult = {
  project: Project | null;
  error: string | null;
};

export type NewThreadOptions = {
  cwd?: string;
  /** Explicit navigation owner. Null creates an intentionally projectless chat. */
  projectId?: string | null;
  /** Off by default: worktrees need a git repo with at least one commit. */
  useWorktree?: boolean;
  /**
   * Start an isolated worktree from this local branch rather than from the
   * checkout's current HEAD. Selecting a branch must never silently checkout
   * the user's working directory.
   */
  baseBranch?: string;
};

/** Read-only Git context for the new-chat branch selector. */
export type GitBranchInfo = {
  root: string;
  currentBranch: string | null;
  defaultBranch: string | null;
  branches: string[];
  dirtyCount: number;
};

export type { ReviewTarget, FuzzyFileSearchResult, Model };

export const IPC = {
  event: "codexdesk:event",
  getSnapshot: "codexdesk:getSnapshot",
  installRuntime: "codexdesk:installRuntime",
  selectWorkspace: "codexdesk:selectWorkspace",
  setWorkspace: "codexdesk:setWorkspace",
  readGitBranches: "codexdesk:readGitBranches",
  sendMessage: "codexdesk:sendMessage",
  interrupt: "codexdesk:interrupt",
  answerRequest: "codexdesk:answerRequest",
  removeQueued: "codexdesk:removeQueued",
  // --- queue editing (§8.1) ---
  editQueued: "codexdesk:editQueued",
  moveQueued: "codexdesk:moveQueued",
  steerNow: "codexdesk:steerNow",
  compactThread: "codexdesk:compactThread",
  setNotifyMode: "codexdesk:setNotifyMode",
  setApprovalsReviewer: "codexdesk:setApprovalsReviewer",
  setApprovalMode: "codexdesk:setApprovalMode",
  // --- usage (§8.6) ---
  readUsage: "codexdesk:readUsage",
  consumeResetCredit: "codexdesk:consumeResetCredit",
  // --- sign-in (§8.5) ---
  startLogin: "codexdesk:startLogin",
  cancelLogin: "codexdesk:cancelLogin",
  logout: "codexdesk:logout",
  // --- Phase 3 ---
  newThread: "codexdesk:newThread",
  openThread: "codexdesk:openThread",
  closeThread: "codexdesk:closeThread",
  renameThread: "codexdesk:renameThread",
  archiveThread: "codexdesk:archiveThread",
  deleteThread: "codexdesk:deleteThread",
  pinThread: "codexdesk:pinThread",
  forkThread: "codexdesk:forkThread",
  saveDraft: "codexdesk:saveDraft",
  addAttachment: "codexdesk:addAttachment",
  removeAttachment: "codexdesk:removeAttachment",
  startReview: "codexdesk:startReview",
  setUseWorktrees: "codexdesk:setUseWorktrees",
  // --- Phase 4 ---
  searchFiles: "codexdesk:searchFiles",
  setModel: "codexdesk:setModel",
  setReasoningEffort: "codexdesk:setReasoningEffort",
  setServiceTier: "codexdesk:setServiceTier",
  addProject: "codexdesk:addProject",
  setActiveProject: "codexdesk:setActiveProject",
  renameProject: "codexdesk:renameProject",
  registerIsolatedWorkspace: "codexdesk:registerIsolatedWorkspace",
  revealProject: "codexdesk:revealProject",
  removeProject: "codexdesk:removeProject",
  // --- windows (3.2) and quick chat (4.7) ---
  openInNewWindow: "codexdesk:openInNewWindow",
  promptCaptureSubmit: "codexdesk:promptCaptureSubmit",
  promptCaptureClose: "codexdesk:promptCaptureClose",
  // --- file tree (4.3) ---
  readDir: "codexdesk:readDir",
  readFile: "codexdesk:readFile",
  readImage: "codexdesk:readImage",
  openPath: "codexdesk:openPath",
  // --- file viewer actions ---
  copyFileContents: "codexdesk:copyFileContents",
  revealPath: "codexdesk:revealPath",
  // --- capabilities (§4.5 / V2.4) ---
  setSkillEnabled: "codexdesk:setSkillEnabled",
  refreshSkills: "codexdesk:refreshSkills",
  setPluginEnabled: "codexdesk:setPluginEnabled",
  refreshCapabilities: "codexdesk:refreshCapabilities",
  reloadMcpServers: "codexdesk:reloadMcpServers",
  setWebSearchMode: "codexdesk:setWebSearchMode",
  // --- terminal (3.6) ---
  termOpen: "codexdesk:termOpen",
  termWrite: "codexdesk:termWrite",
  termResize: "codexdesk:termResize",
  termClose: "codexdesk:termClose",
  // --- changes pane, delivery, comments (milestone 3, §7) ---
  refreshChanges: "codexdesk:refreshChanges",
  setChangesScope: "codexdesk:setChangesScope",
  prepareDelivery: "codexdesk:prepareDelivery",
  commitChanges: "codexdesk:commitChanges",
  pushBranch: "codexdesk:pushBranch",
  createPullRequest: "codexdesk:createPullRequest",
  generateCommitMessage: "codexdesk:generateCommitMessage",
  addComment: "codexdesk:addComment",
  removeComment: "codexdesk:removeComment",
  submitComments: "codexdesk:submitComments",
} as const;
