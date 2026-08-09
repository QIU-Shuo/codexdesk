import type { AutoReview } from "../../shared/ipc";

/**
 * A decision made on the user's behalf by `approvalsReviewer: "auto_review"`.
 *
 * The point of this card is that a delegated decision must stay *legible*:
 * what was decided, how risky it was judged, and why. Rendering it as a
 * silent gap in the transcript would be worse than prompting (plan §12.1).
 *
 * Risk is the field that earns its own treatment. `high` and `critical` are
 * decisions the user would likely have wanted to make themselves, and a
 * delegated approval they never notice is exactly the failure this surface
 * exists to prevent — so risk reads as a badge, not as a word in a sentence.
 *
 * The `[UNSTABLE]` guardian payload is flattened in the client facade, so
 * this component sees only our own `AutoReview` shape.
 */
export function AutoReviewCard({ review }: { review: AutoReview }) {
  const inProgress = review.status === "inProgress";
  const denied = review.status === "denied";
  // `timedOut` and `aborted` are neither denials nor approvals: the action
  // never got a decision. Calling that out stops it reading as a quiet yes.
  const undecided = review.status === "timedOut" || review.status === "aborted";
  const elevated =
    review.riskLevel === "high" || review.riskLevel === "critical";

  return (
    <div
      className={`item autoReview${denied ? " failed" : ""}${
        elevated ? " elevated" : ""
      }`}
    >
      <div className="tag">
        <span>auto-review · {STATUS_WORD[review.status] ?? review.status}</span>
        {review.riskLevel && (
          <span className={`risk risk-${review.riskLevel}`}>
            {review.riskLevel} risk
          </span>
        )}
      </div>
      <div className="autoReview-action">{describeAction(review.action)}</div>
      {/* `started` arrives before `completed`, so review-in-progress is
          visible rather than an unexplained pause. */}
      {inProgress ? (
        <div className="muted">reviewing…</div>
      ) : (
        <>
          {undecided && (
            <div className="muted">
              No decision was reached; the action did not run.
            </div>
          )}
          {review.rationale && <div className="reason">{review.rationale}</div>}
        </>
      )}
    </div>
  );
}

/** Protocol status values are camelCase; these are for reading. */
const STATUS_WORD: Record<string, string> = {
  inProgress: "in progress",
  approved: "approved",
  denied: "denied",
  timedOut: "timed out",
  aborted: "aborted",
};

function describeAction(action: AutoReview["action"]): string {
  switch (action.type) {
    case "command":
      return `$ ${action.command}`;
    case "execve":
      return `$ ${action.program} ${action.argv.join(" ")}`;
    case "applyPatch":
      return `patch ${action.files.length} file(s)`;
    case "networkAccess":
      return `network ${action.protocol}://${action.host}:${action.port}`;
    case "mcpToolCall":
      return `${action.server} · ${action.toolTitle ?? action.toolName}`;
    case "requestPermissions":
      return action.reason ?? "requested additional permissions";
  }
}
