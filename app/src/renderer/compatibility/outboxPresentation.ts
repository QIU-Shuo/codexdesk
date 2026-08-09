/**
 * Temporary current-UI projection.
 *
 * Delete this adapter when the independent UI-redesign milestone renders the
 * input-outbox contract directly.
 */
import type { InputOutboxView } from "../../contracts/views/conversations";

export type CurrentQueuedMessage = {
  id: string;
  text: string;
  queuedAtMs: number;
  attachments?: InputOutboxView["entries"][number]["assets"];
};

export type CurrentSteerState =
  | { kind: "idle" }
  | { kind: "steering" }
  | { kind: "notSteerable"; turnKind: string }
  | { kind: "failed"; message: string };

export type CurrentOutboxPresentation = {
  messages: CurrentQueuedMessage[];
  steer: CurrentSteerState;
  capacity: number;
};

export function presentOutbox(
  outbox: InputOutboxView,
): CurrentOutboxPresentation {
  const steer: CurrentSteerState =
    outbox.dispatch.kind === "sending"
      ? { kind: "steering" }
      : outbox.dispatch.kind === "failed"
        ? { kind: "failed", message: outbox.dispatch.message }
        : outbox.dispatch.kind === "deferred" &&
            outbox.dispatch.reason === "turnNotSteerable"
          ? {
              kind: "notSteerable",
              turnKind: outbox.dispatch.detail ?? "turn",
            }
          : { kind: "idle" };
  return {
    messages: outbox.entries.map((entry) => ({
      id: entry.id,
      text: entry.text,
      queuedAtMs: entry.createdAt,
      attachments: entry.assets.map((asset) => ({ ...asset })),
    })),
    steer,
    capacity: outbox.capacity,
  };
}
