/** Renderer-safe conversation state. All variants are JSON serializable. */
export type AgentRunState =
  | { kind: "ready" }
  | { kind: "running"; turnId: string | null; startedAt: number | null }
  | {
      kind: "waiting";
      turnId: string | null;
      requestId: string | null;
      reason: "approval" | "input";
    }
  | { kind: "failed"; message: string; retryable: boolean }
  | { kind: "offline" };

export type CheckoutState =
  | { kind: "notRequested" }
  | { kind: "preparing" }
  | {
      kind: "available";
      root: string;
      sourceRoot: string;
      baseRevision: string;
    }
  | { kind: "failed"; message: string; retryable: boolean };

export type OutboxEntryView = {
  id: string;
  text: string;
  createdAt: number;
  assets: Array<{
    id: string;
    kind: "image" | "file";
    name: string;
    path: string;
    preview?: string;
  }>;
  schedule: "afterTurn" | "now";
  lastFailure: {
    message: string;
    retryable: boolean;
    at: number;
  } | null;
};

export type InputOutboxView = {
  entries: OutboxEntryView[];
  dispatch:
    | { kind: "idle" }
    | { kind: "sending"; entryId: string; expectedTurnId: string | null }
    | {
        kind: "deferred";
        reason: "turnEnded" | "turnNotSteerable";
        detail: string | null;
      }
    | { kind: "failed"; entryId: string; message: string; retryable: boolean };
  capacity: number;
};

export type ConversationView = {
  id: string;
  title: string | null;
  executionRoot: string;
  run: AgentRunState;
  checkout: CheckoutState;
  outbox: InputOutboxView;
};
