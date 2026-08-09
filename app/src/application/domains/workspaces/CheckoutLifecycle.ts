import type { CheckoutState } from "../../../contracts/views/conversations";

export type CheckoutRecord = {
  root: string | null;
  sourceRoot: string | null;
  baseRevision: string | null;
};

/** Derive durable checkout availability without mixing in navigation state. */
export function checkoutState(record: CheckoutRecord): CheckoutState {
  if (!record.root) return { kind: "notRequested" };
  if (!record.sourceRoot || !record.baseRevision) {
    return {
      kind: "failed",
      message: "This isolated checkout is missing its source metadata.",
      retryable: false,
    };
  }
  return {
    kind: "available",
    root: record.root,
    sourceRoot: record.sourceRoot,
    baseRevision: record.baseRevision,
  };
}
