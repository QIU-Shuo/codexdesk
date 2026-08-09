import path from "node:path";
import { digestReviewContext } from "../../application/domains/review/ReviewAnchor";
import type { ReviewNote } from "../../application/domains/review/ReviewNote";
import type {
  WorkspacePlacement,
  WorkspaceRecord,
} from "../../application/domains/workspaces/WorkspacePlacement";
import {
  emptyPersistedState,
  type PersistedState,
  type PersistedThread,
} from "./stateSchema";

type LegacyProject = {
  id: string;
  name: string;
  roots: string[];
  activeRoot: string;
};

type LegacyComment = {
  commentId: string;
  filePath: string;
  side: "left" | "right";
  startLine: number;
  endLine: number;
  hunkId: string;
  commentText: string;
  quotedLines: string[];
  createdAtMs: number;
  stale?: boolean;
};

type LegacyQueuedMessage = {
  id: string;
  text: string;
  queuedAtMs: number;
  attachments?: Array<{
    id: string;
    kind: "image" | "file";
    name: string;
    path: string;
    preview?: string;
  }>;
};

type LegacyThread = Omit<PersistedThread, "outbox" | "reviewNotes"> & {
  queue?: LegacyQueuedMessage[];
  projectId?: string | null;
  comments?: LegacyComment[];
};

type LegacyState = Partial<Omit<PersistedState, "workspaceRegistry">> & {
  projects?: LegacyProject[];
  activeProjectId?: string | null;
  threadProjectAssignments?: Record<string, string | null>;
  threadWorkspaceRootHints?: Record<string, string>;
  dismissedProjectRoots?: string[];
  threads?: Record<string, LegacyThread | undefined>;
};

function ownerForRoot(
  root: string,
  workspaces: WorkspaceRecord[],
): string | null {
  const resolved = path.resolve(root);
  return (
    workspaces
      .flatMap((workspace) =>
        workspace.roots.map((candidate) => ({
          id: workspace.id,
          root: candidate,
        })),
      )
      .filter((candidate) => {
        const relative = path.relative(path.resolve(candidate.root), resolved);
        return (
          relative === "" ||
          (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
        );
      })
      .sort((a, b) => b.root.length - a.root.length)[0]?.id ?? null
  );
}

function migrateReviewNote(
  conversationId: string,
  comment: LegacyComment,
  baseRevision: string | null,
): ReviewNote {
  const context = { before: [], selected: comment.quotedLines, after: [] };
  const side = comment.side === "left" ? "before" : "after";
  return {
    id: comment.commentId,
    originConversationId: conversationId,
    anchor: {
      path: comment.filePath,
      side,
      span: { start: comment.startLine, end: comment.endLine },
      contextDigest: digestReviewContext(context),
      context,
      baseRevision,
    },
    body: comment.commentText,
    assets: [],
    resolution: comment.stale ? "missing" : "located",
    currentLocation: comment.stale
      ? null
      : {
          path: comment.filePath,
          side,
          span: { start: comment.startLine, end: comment.endLine },
          sectionId: comment.hunkId,
        },
    createdAt: comment.createdAtMs,
  };
}

function migrateThread(
  conversationId: string,
  thread: LegacyThread,
): PersistedThread {
  return {
    draft: thread.draft,
    outbox: {
      entries: (thread.queue ?? []).map((message) => ({
        id: message.id,
        text: message.text,
        createdAt: message.queuedAtMs,
        assets: (message.attachments ?? []).map((attachment) => ({
          ...attachment,
        })),
        schedule: "afterTurn",
        lastFailure: null,
      })),
    },
    pinned: thread.pinned,
    name: thread.name,
    cwd: thread.cwd,
    worktreePath: thread.worktreePath,
    worktreeBaseSha: thread.worktreeBaseSha ?? null,
    reviewNotes: (thread.comments ?? []).map((comment) =>
      migrateReviewNote(
        conversationId,
        comment,
        thread.worktreeBaseSha ?? null,
      ),
    ),
    updatedAtMs: thread.updatedAtMs,
  };
}

/** The only production module that recognizes v1/v2 workspace field names. */
export function readLegacyV2(raw: LegacyState): PersistedState {
  const empty = emptyPersistedState();
  const threads = Object.fromEntries(
    Object.entries(raw.threads ?? {}).flatMap(([conversationId, thread]) =>
      thread ? [[conversationId, migrateThread(conversationId, thread)]] : [],
    ),
  );
  const workspaces: WorkspaceRecord[] = (raw.projects ?? []).map((project) => ({
    id: project.id,
    label: project.name,
    roots: [...project.roots],
    selectedRoot: project.roots.includes(project.activeRoot)
      ? project.activeRoot
      : (project.roots[0] ?? project.activeRoot),
    registeredAt: 0,
  }));
  const placements: Record<string, WorkspacePlacement> = {};
  const ids = new Set([
    ...Object.keys(threads),
    ...Object.keys(raw.threadProjectAssignments ?? {}),
    ...Object.keys(raw.threadWorkspaceRootHints ?? {}),
  ]);

  for (const conversationId of ids) {
    const thread = raw.threads?.[conversationId];
    const assignments = raw.threadProjectAssignments ?? {};
    const hasAssignment = Object.prototype.hasOwnProperty.call(
      assignments,
      conversationId,
    );
    const hasThreadAssignment = Boolean(
      thread && Object.prototype.hasOwnProperty.call(thread, "projectId"),
    );
    const assigned = hasAssignment
      ? assignments[conversationId]
      : hasThreadAssignment
        ? thread?.projectId
        : undefined;
    const root =
      raw.threadWorkspaceRootHints?.[conversationId] ?? thread?.cwd ?? null;

    if (assigned === null) {
      placements[conversationId] = { kind: "unassigned" };
      continue;
    }
    if (typeof assigned === "string") {
      placements[conversationId] = {
        kind: "registered",
        workspaceId: assigned,
        navigationRoot:
          root ??
          workspaces.find((workspace) => workspace.id === assigned)
            ?.selectedRoot ??
          "",
      };
      continue;
    }
    if (!root) continue;
    const inferred = ownerForRoot(root, workspaces);
    placements[conversationId] = inferred
      ? { kind: "registered", workspaceId: inferred, navigationRoot: root }
      : { kind: "unregistered", root };
  }

  return {
    ...empty,
    version: 3,
    threads,
    pinnedOrder: raw.pinnedOrder ?? [],
    recents: raw.recents ?? [],
    lastThreadId: raw.lastThreadId ?? null,
    notifyMode: raw.notifyMode ?? empty.notifyMode,
    useWorktrees: raw.useWorktrees ?? empty.useWorktrees,
    approvalsReviewer: raw.approvalsReviewer ?? empty.approvalsReviewer,
    approvalMode: raw.approvalMode ?? empty.approvalMode,
    currentModel: raw.currentModel ?? null,
    currentReasoningEffort: raw.currentReasoningEffort ?? null,
    currentServiceTier: raw.currentServiceTier ?? null,
    workspaceRegistry: {
      workspaces,
      activeWorkspaceId:
        raw.activeProjectId &&
        workspaces.some((workspace) => workspace.id === raw.activeProjectId)
          ? raw.activeProjectId
          : null,
      placements,
      dismissedRoots: [...(raw.dismissedProjectRoots ?? [])],
    },
  };
}
