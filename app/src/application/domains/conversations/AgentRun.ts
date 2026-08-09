import type { AgentRunState } from "../../../contracts/views/conversations";

export type AgentRunEvent =
  | { type: "turnStarted"; turnId: string; startedAt: number }
  | {
      type: "attentionRequested";
      turnId: string | null;
      requestId: string;
      reason: "approval" | "input";
    }
  | { type: "attentionResolved"; activeTurnId: string | null }
  | { type: "turnCompleted" }
  | { type: "failed"; message: string; retryable: boolean }
  | { type: "offline" };

/** Pure activity transition; navigation/unread state is deliberately absent. */
export function transitionAgentRun(
  _current: AgentRunState,
  event: AgentRunEvent,
): AgentRunState {
  switch (event.type) {
    case "turnStarted":
      return {
        kind: "running",
        turnId: event.turnId,
        startedAt: event.startedAt,
      };
    case "attentionRequested":
      return {
        kind: "waiting",
        turnId: event.turnId,
        requestId: event.requestId,
        reason: event.reason,
      };
    case "attentionResolved":
      return event.activeTurnId
        ? {
            kind: "running",
            turnId: event.activeTurnId,
            startedAt: null,
          }
        : { kind: "ready" };
    case "turnCompleted":
      return { kind: "ready" };
    case "failed":
      return {
        kind: "failed",
        message: event.message,
        retryable: event.retryable,
      };
    case "offline":
      return { kind: "offline" };
  }
}
