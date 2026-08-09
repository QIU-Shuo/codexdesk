export type DeliveryIssueView = {
  stage: "inspect" | "commit" | "push" | "pullRequest";
  cause:
    | "notRepository"
    | "noChanges"
    | "unsafeBranch"
    | "missingRemote"
    | "missingUpstream"
    | "missingTool"
    | "authentication"
    | "rejected"
    | "hook"
    | "unknown";
  recovery: "retry" | "userAction" | "chooseBranch" | "unavailable";
  detail: string;
};

export type ChangedPathView = {
  path: string;
  untracked: boolean;
  staged: boolean;
  unstaged: boolean;
};

export type DeliveryProgressView = {
  next: "inspect" | "commit" | "push" | "pullRequest" | "done";
  branch: string | null;
  defaultBranch: string | null;
  remote: string | null;
  upstream: string | null;
  files: string[];
  changes: ChangedPathView[];
  additions: number;
  deletions: number;
  committedSha: string | null;
  pushed: boolean;
  prUrl: string | null;
  issue: DeliveryIssueView | null;
  busy: boolean;
};
