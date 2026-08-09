/**
 * Per-thread state, owned by the main process.
 *
 * Milestone 1 had exactly one thread and kept its state in module-level
 * variables. Everything in Phase 3 — the catalog, recovery, worktrees —
 * needs several threads alive at once, with only one visible. Splitting this
 * out first is what makes the rest additive rather than a rewrite.
 *
 * The renderer holds view state only; this is the source of truth.
 */
import path from "node:path";
import type {
  Attachment,
  AutoReview,
  Budget,
  PendingRequest,
  ThreadItemEntry,
  ThreadListEntry,
  TurnPlan,
  Project,
} from "../shared/ipc";
import type { AgentRunState } from "../contracts/views/conversations";
import { checkoutState } from "../application/domains/workspaces/CheckoutLifecycle";
import type { ChangesScope } from "../shared/ipc";
import type { ParsedDiff } from "./git/diff";
import type { DeliveryState } from "../application/domains/delivery/DeliveryService";
import type { ReviewNote } from "../application/domains/review/ReviewNote";
import type { InputOutbox } from "../application/domains/conversations/InputOutbox";
import type { ApprovalMode } from "../contracts/approvals";

export type ThreadRuntime = {
  threadId: string;
  cwd: string;
  /** Navigation owner, independent of a worktree's runtime cwd. */
  projectId: string | null;
  /** Whether projectId is durable ownership rather than an unmatched fallback. */
  projectIdExplicit: boolean;
  /** Present when the thread runs in a dedicated git worktree (3.4). */
  worktreePath: string | null;
  /**
   * Commit the worktree was branched from. Persisted, not just in-memory:
   * without it a restart leaves the session diff silently empty, and §7.1
   * needs the exact base to diff against.
   */
  worktreeBaseSha?: string | null;
  /** The repository the worktree came from — needed to remove it later. */
  repoRoot?: string | null;
  name: string | null;
  preview: string;
  createdAtMs: number;
  updatedAtMs: number;

  // --- live turn state ---
  activeTurnId: string | null;
  entries: ThreadItemEntry[];
  /** itemId -> stream -> index -> text */
  deltas: Record<string, Record<string, Record<number, string>>>;
  pending: PendingRequest[];
  reviews: Record<string, AutoReview>;
  plan: TurnPlan | null;
  diff: string;
  budget: Budget;

  // --- client-side, persisted (3.3) ---
  draft: string;
  attachments: Attachment[];
  outbox: InputOutbox;
  pinned: boolean;
  archived: boolean;

  /**
   * This thread's approval posture. Per-thread rather than global so an
   * exploratory read-only thread can sit beside a full-access one; unset
   * until the user chooses, at which point the global default applies.
   */
  approvalMode?: ApprovalMode;

  /** Completed turn ids, oldest first — fork points for 3.5. */
  completedTurnIds?: string[];

  /**
   * True once the thread's history has been fetched from app-server. A thread
   * opened optimistically (skeleton from persisted state, shown instantly) is
   * `false` until `readThread` resolves, which is how `openThread` knows an
   * in-memory thread still needs its turns loaded.
   */
  loaded?: boolean;

  // --- review and ship (milestone 3, §7) ---
  /** Parsed diff currently shown, kept so comments can anchor into it (§7.1). */
  changes?: ParsedDiff | null;
  /**
   * Which scope the changes pane is showing (§7.1). Per thread, not global:
   * you might be reviewing one thread's whole session while checking what
   * another just did. Not persisted — a scope is a way of looking, and
   * defaulting to the session on open is the safer of the two.
   */
  changesScope?: ChangesScope;
  /** Last observed delivery state (§7.2). Not persisted — `prepare` re-reads
   * the repository, which is the truth a journal could disagree with. */
  delivery?: DeliveryState | null;
  /** Durable review notes against the current change set. */
  reviewNotes?: ReviewNote[];

  // --- catalog state (3.2) ---
  run: AgentRunState;
  /** Set when a turn ends while this thread is not the visible one. */
  unread: boolean;
  lastError: string | null;
};

export function emptyThread(
  threadId: string,
  cwd: string,
  outbox: InputOutbox,
  overrides: Partial<ThreadRuntime> = {},
): ThreadRuntime {
  const now = Date.now();
  return {
    threadId,
    cwd,
    projectId: null,
    projectIdExplicit: false,
    worktreePath: null,
    worktreeBaseSha: null,
    repoRoot: null,
    name: null,
    preview: "",
    createdAtMs: now,
    updatedAtMs: now,
    activeTurnId: null,
    entries: [],
    deltas: {},
    pending: [],
    reviews: {},
    plan: null,
    diff: "",
    budget: { tokenUsage: null, rateLimits: null },
    draft: "",
    attachments: [],
    outbox,
    pinned: false,
    archived: false,
    run: { kind: "ready" },
    unread: false,
    lastError: null,
    ...overrides,
  };
}

export function toListEntry(
  t: ThreadRuntime,
  loaded: boolean,
): ThreadListEntry {
  return {
    threadId: t.threadId,
    name: t.name,
    preview: t.preview,
    cwd: t.cwd,
    projectId: t.projectId,
    run: { ...t.run },
    pinned: t.pinned,
    archived: t.archived,
    unread: t.unread,
    updatedAtMs: t.updatedAtMs,
    worktreePath: t.worktreePath,
    checkout: checkoutState({
      root: t.worktreePath,
      sourceRoot: t.repoRoot ?? null,
      baseRevision: t.worktreeBaseSha ?? null,
    }),
    loaded,
  };
}

/**
 * Attribute a cwd to the most specific project root. A nested project wins
 * over its parent; segment-aware `relative` checks avoid `/repo-a` matching
 * `/repo`. Project roots are already canonicalized when they are added.
 */
export function projectForCwd(cwd: string, projects: Project[]): string | null {
  const matches = projects
    .flatMap((project) =>
      project.roots.map((root) => ({ projectId: project.id, root })),
    )
    .filter(({ root }) => {
      const relative = path.relative(path.resolve(root), path.resolve(cwd));
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    })
    .sort((a, b) => b.root.length - a.root.length);
  return matches[0]?.projectId ?? null;
}

/**
 * Sort order for the sidebar: pinned first (in their stored order), then by
 * recency. Pinning is entirely client state — there is no `isPinned` filter
 * in `ThreadListParams` (plan §6, 3.1).
 */
export function sortThreads(
  entries: ThreadListEntry[],
  pinnedOrder: string[],
): ThreadListEntry[] {
  return [...entries].sort((a, b) => {
    const ai = pinnedOrder.indexOf(a.threadId);
    const bi = pinnedOrder.indexOf(b.threadId);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return b.updatedAtMs - a.updatedAtMs;
  });
}
