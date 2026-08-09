import { describe, expect, it } from "vitest";
import { transitionAgentRun } from "../src/application/domains/conversations/AgentRun";

describe("agent activity transitions", () => {
  it("keeps activity separate from navigation attention", () => {
    const running = transitionAgentRun(
      { kind: "ready" },
      { type: "turnStarted", turnId: "turn-1", startedAt: 10 },
    );
    expect(running).toEqual({
      kind: "running",
      turnId: "turn-1",
      startedAt: 10,
    });

    const waiting = transitionAgentRun(running, {
      type: "attentionRequested",
      turnId: "turn-1",
      requestId: "request-1",
      reason: "approval",
    });
    expect(waiting).toEqual({
      kind: "waiting",
      turnId: "turn-1",
      requestId: "request-1",
      reason: "approval",
    });

    expect(
      transitionAgentRun(waiting, {
        type: "attentionResolved",
        activeTurnId: "turn-1",
      }),
    ).toEqual({ kind: "running", turnId: "turn-1", startedAt: null });
  });

  it("covers completion, failure, and disconnect without an implicit default", () => {
    expect(
      transitionAgentRun(
        { kind: "running", turnId: "turn-1", startedAt: null },
        { type: "turnCompleted" },
      ),
    ).toEqual({ kind: "ready" });
    expect(
      transitionAgentRun(
        { kind: "ready" },
        { type: "failed", message: "boom", retryable: false },
      ),
    ).toEqual({ kind: "failed", message: "boom", retryable: false });
    expect(transitionAgentRun({ kind: "ready" }, { type: "offline" })).toEqual({
      kind: "offline",
    });
  });
});
