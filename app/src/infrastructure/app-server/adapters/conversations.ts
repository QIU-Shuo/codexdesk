import type { AgentRunState } from "../../../contracts/views/conversations";
import type { ThreadStatus } from "../../../protocol/generated/v2/ThreadStatus";

/** Convert public app-server activity into CodexDesk's independent run model. */
export function mapThreadStatus(
  status: ThreadStatus,
  activeTurnId: string | null,
): AgentRunState {
  switch (status.type) {
    case "notLoaded":
      return { kind: "offline" };
    case "idle":
      return { kind: "ready" };
    case "systemError":
      return {
        kind: "failed",
        message: "The agent service reported a system error.",
        retryable: true,
      };
    case "active":
      if (status.activeFlags.includes("waitingOnApproval")) {
        return {
          kind: "waiting",
          turnId: activeTurnId,
          requestId: null,
          reason: "approval",
        };
      }
      if (status.activeFlags.includes("waitingOnUserInput")) {
        return {
          kind: "waiting",
          turnId: activeTurnId,
          requestId: null,
          reason: "input",
        };
      }
      return { kind: "running", turnId: activeTurnId, startedAt: null };
  }
}
