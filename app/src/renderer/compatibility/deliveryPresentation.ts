/**
 * Temporary current-UI projection. Delete when the delivery redesign renders
 * DeliveryProgressView directly.
 */
import type { DeliveryProgressView } from "../../contracts/views/delivery";

export type CurrentDeliveryNotice = {
  title: string;
  detail: string;
  recoverable: boolean;
};

/**
 * The main process and application use the product-neutral delivery contract.
 * Keeping this translation beside the renderer prevents display terminology
 * from becoming orchestration policy.
 */
export type CurrentDeliveryView = Omit<
  DeliveryProgressView,
  "next" | "issue"
> & {
  step: "prepare" | "commit" | "push" | "pr" | "done";
  notice: CurrentDeliveryNotice | null;
};

export function presentDelivery(
  delivery: DeliveryProgressView,
): CurrentDeliveryView {
  return {
    branch: delivery.branch,
    defaultBranch: delivery.defaultBranch,
    remote: delivery.remote,
    upstream: delivery.upstream,
    files: [...delivery.files],
    changes: delivery.changes.map((change) => ({ ...change })),
    additions: delivery.additions,
    deletions: delivery.deletions,
    committedSha: delivery.committedSha,
    pushed: delivery.pushed,
    prUrl: delivery.prUrl,
    busy: delivery.busy,
    step: presentStage(delivery.next),
    notice: delivery.issue
      ? {
          title: presentIssueTitle(delivery.issue),
          detail: delivery.issue.detail,
          recoverable: delivery.issue.recovery !== "unavailable",
        }
      : null,
  };
}

function presentStage(
  stage: DeliveryProgressView["next"],
): CurrentDeliveryView["step"] {
  if (stage === "inspect") return "prepare";
  if (stage === "pullRequest") return "pr";
  return stage;
}

function presentIssueTitle(
  issue: NonNullable<DeliveryProgressView["issue"]>,
): string {
  switch (issue.cause) {
    case "notRepository":
      return "Not a git repository";
    case "noChanges":
      return "Nothing to commit";
    case "unsafeBranch":
      return "Choose another branch";
    case "missingRemote":
      return "No remote";
    case "missingUpstream":
      return "Not pushed yet";
    case "missingTool":
      return "GitHub CLI missing";
    case "authentication":
      return issue.stage === "pullRequest"
        ? "GitHub sign-in needed"
        : "Authentication failed";
    case "rejected":
      return "Push rejected";
    case "hook":
      return "A git hook rejected this";
    case "unknown":
      return issue.stage === "pullRequest"
        ? "Cannot open a pull request"
        : "Git command failed";
  }
}
