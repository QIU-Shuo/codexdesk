import type { WorkspaceRegistryState } from "../../application/domains/workspaces/WorkspacePlacement";
import type { ReviewNote } from "../../application/domains/review/ReviewNote";
import type { InputOutboxState } from "../../application/domains/conversations/InputOutbox";
import type { ApprovalMode } from "../../contracts/approvals";
import { DEFAULT_APPROVAL_MODE } from "../../application/domains/approvals/policy";

export type PersistedThread = {
  draft: string;
  outbox: InputOutboxState;
  pinned: boolean;
  name: string | null;
  cwd: string;
  worktreePath: string | null;
  worktreeBaseSha?: string | null;
  reviewNotes?: ReviewNote[];
  /** This thread's approval posture. Absent means the global default. */
  approvalMode?: ApprovalMode;
  updatedAtMs: number;
};

export type PersistedState = {
  version: number;
  threads: Record<string, PersistedThread>;
  pinnedOrder: string[];
  recents: string[];
  lastThreadId: string | null;
  notifyMode: "off" | "unfocused" | "always";
  useWorktrees?: boolean;
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent";
  /** Default approval posture for threads that have not chosen their own. */
  approvalMode?: ApprovalMode;
  workspaceRegistry: WorkspaceRegistryState;
  currentModel?: string | null;
  currentReasoningEffort?: string | null;
  currentServiceTier?: string | null;
};

export const CURRENT_STATE_VERSION = 3;

export function emptyPersistedState(): PersistedState {
  return {
    version: CURRENT_STATE_VERSION,
    threads: {},
    pinnedOrder: [],
    recents: [],
    lastThreadId: null,
    notifyMode: "unfocused",
    useWorktrees: false,
    approvalsReviewer: "user",
    approvalMode: DEFAULT_APPROVAL_MODE,
    workspaceRegistry: {
      workspaces: [],
      activeWorkspaceId: null,
      placements: {},
      dismissedRoots: [],
    },
    currentModel: null,
    currentReasoningEffort: null,
    currentServiceTier: null,
  };
}
