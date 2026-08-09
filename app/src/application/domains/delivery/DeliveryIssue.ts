export type DeliveryStage = "inspect" | "commit" | "push" | "pullRequest";

export type DeliveryIssue = {
  stage: DeliveryStage;
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

export function deliveryIssue(
  stage: DeliveryStage,
  cause: DeliveryIssue["cause"],
  recovery: DeliveryIssue["recovery"],
  detail: string,
): DeliveryIssue {
  return { stage, cause, recovery, detail };
}
