import type { DeliveryIssue } from "./DeliveryIssue";

export type ChangedPath = {
  path: string;
  untracked: boolean;
  staged: boolean;
  unstaged: boolean;
};

export type DeliveryState = {
  next: "inspect" | "commit" | "push" | "pullRequest" | "done";
  repoRoot: string;
  branch: string | null;
  defaultBranch: string | null;
  remote: string | null;
  upstream: string | null;
  files: string[];
  changes: ChangedPath[];
  additions: number;
  deletions: number;
  committedSha: string | null;
  pushed: boolean;
  prUrl: string | null;
  issue: DeliveryIssue | null;
};

export type DeliveryObservation = Omit<DeliveryState, "next">;

/** Application policy for continuing from an observed repository state. */
export function nextDeliveryStage(
  state: DeliveryObservation,
): DeliveryState["next"] {
  if (state.issue) return state.issue.stage;
  if (state.files.length > 0) return "commit";
  if (!state.committedSha) return "inspect";
  if (!state.pushed) return "push";
  if (!state.prUrl) return "pullRequest";
  return "done";
}
