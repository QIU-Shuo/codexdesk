/**
 * Temporary current-UI projection. Delete when the sidebar/activity redesign
 * renders AgentRunState and CheckoutState directly.
 */
import type { AgentRunState } from "../../contracts/views/conversations";
import type { ThreadListEntry, ThreadView } from "../../shared/ipc";

export type CurrentThreadRuntimeStatus =
  | "notLoaded"
  | "idle"
  | "running"
  | "waitingOnApproval"
  | "waitingOnUserInput"
  | "failed";

export type CurrentThreadListEntry = Omit<
  ThreadListEntry,
  "run" | "checkout"
> & {
  status: CurrentThreadRuntimeStatus;
  /** Start of the active run, used by the live duration in the sidebar. */
  startedAtMs: number | null;
  /** Preserved for the failed-row tooltip without loading the transcript. */
  failureMessage: string | null;
};

export type CurrentThreadView = Omit<ThreadView, "run" | "checkout"> & {
  status: CurrentThreadRuntimeStatus;
  running: boolean;
};

/** Remove with the sidebar/activity UI redesign. */
export function presentThreadList(
  threads: ThreadListEntry[],
): CurrentThreadListEntry[] {
  return threads.map((thread) => ({
    threadId: thread.threadId,
    name: thread.name,
    preview: thread.preview,
    cwd: thread.cwd,
    projectId: thread.projectId,
    status: presentRunStatus(thread.run),
    startedAtMs:
      thread.run.kind === "running" ? thread.run.startedAt : null,
    failureMessage:
      thread.run.kind === "failed" ? thread.run.message : null,
    pinned: thread.pinned,
    archived: thread.archived,
    unread: thread.unread,
    updatedAtMs: thread.updatedAtMs,
    worktreePath: thread.worktreePath,
    loaded: thread.loaded,
  }));
}

export function presentThreadView(view: ThreadView): CurrentThreadView {
  return {
    threadId: view.threadId,
    cwd: view.cwd,
    worktreePath: view.worktreePath,
    name: view.name,
    entries: view.entries,
    deltas: view.deltas,
    outbox: view.outbox,
    draft: view.draft,
    attachments: view.attachments,
    plan: view.plan,
    diff: view.diff,
    budget: view.budget,
    status: presentRunStatus(view.run),
    running: view.run.kind === "running" || view.run.kind === "waiting",
    lastError: view.lastError,
    turnIds: [...view.turnIds],
    approvalMode: view.approvalMode,
    loaded: view.loaded,
  };
}

function presentRunStatus(run: AgentRunState): CurrentThreadRuntimeStatus {
  switch (run.kind) {
    case "ready":
      return "idle";
    case "running":
      return "running";
    case "waiting":
      return run.reason === "approval"
        ? "waitingOnApproval"
        : "waitingOnUserInput";
    case "failed":
      return "failed";
    case "offline":
      return "notLoaded";
  }
}
