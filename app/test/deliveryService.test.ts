import { describe, expect, it } from "vitest";
import { deliveryIssue } from "../src/application/domains/delivery/DeliveryIssue";
import {
  nextDeliveryStage,
  type DeliveryObservation,
} from "../src/application/domains/delivery/DeliveryService";
import { deliveryProgressView } from "../src/application/domains/delivery/projection";
import { presentDelivery } from "../src/renderer/compatibility/deliveryPresentation";

function observation(
  overrides: Partial<DeliveryObservation> = {},
): DeliveryObservation {
  return {
    repoRoot: "/repo",
    branch: "codexdesk/refactor",
    defaultBranch: "main",
    remote: "origin",
    upstream: null,
    files: [],
    changes: [],
    additions: 0,
    deletions: 0,
    committedSha: null,
    pushed: false,
    prUrl: null,
    issue: null,
    ...overrides,
  };
}

describe("delivery application policy", () => {
  it.each([
    [observation({ files: ["src/a.ts"] }), "commit"],
    [observation({ committedSha: "abc123" }), "push"],
    [observation({ committedSha: "abc123", pushed: true }), "pullRequest"],
    [
      observation({
        committedSha: "abc123",
        pushed: true,
        prUrl: "https://example.invalid/pull/1",
      }),
      "done",
    ],
  ] as const)("selects and repeats the next stage", (state, expected) => {
    expect(nextDeliveryStage(state)).toBe(expected);
    expect(nextDeliveryStage(state)).toBe(expected);
  });

  it.each([
    ["notRepository", "unavailable"],
    ["noChanges", "unavailable"],
    ["unsafeBranch", "chooseBranch"],
    ["missingRemote", "userAction"],
    ["missingUpstream", "userAction"],
    ["missingTool", "unavailable"],
    ["authentication", "userAction"],
    ["rejected", "userAction"],
    ["hook", "userAction"],
    ["unknown", "retry"],
  ] as const)(
    "preserves the %s issue through the renderer contract",
    (cause, recovery) => {
      const issue = deliveryIssue("push", cause, recovery, `${cause} detail`);
      const state = observation({ issue });

      expect(nextDeliveryStage(state)).toBe("push");
      const contract = deliveryProgressView(
        { ...state, next: nextDeliveryStage(state) },
        false,
      );
      expect(contract.issue).toEqual(issue);
      expect(presentDelivery(contract).notice).toMatchObject({
        detail: `${cause} detail`,
        recoverable: recovery !== "unavailable",
      });
    },
  );
});
