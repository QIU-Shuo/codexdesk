import { useState } from "react";
import type { TurnPlan } from "../../shared/ipc";

/**
 * The plan strip (§8.3).
 *
 * `turn/plan/updated` replaces the whole plan each time, so this is a view of
 * current state rather than a log. Three things it has to get right:
 *
 * - **Progress before detail.** A long plan pushes the transcript off screen,
 *   so it collapses to one line once the user has read it. The line still
 *   carries the count and the step in flight, which is the part worth
 *   glancing at while the agent works.
 * - **A finished turn is not a finished plan.** When a turn ends with steps
 *   still pending, that is work the agent did not do. Left unmarked it reads
 *   as an in-progress plan that has quietly stopped moving.
 * - **The explanation is the model's reasoning about the plan**, which is
 *   worth keeping but not worth showing above the steps it explains.
 */
export function PlanStrip({ plan }: { plan: TurnPlan }) {
  const [open, setOpen] = useState(true);

  if (plan.steps.length === 0) return null;

  const done = plan.steps.filter((s) => s.status === "completed").length;
  const current = plan.steps.find((s) => s.status === "inProgress");
  const pending = plan.steps.filter((s) => s.status === "pending").length;
  const abandoned = plan.turnEnded && (pending > 0 || Boolean(current));

  return (
    <div className={`plan${abandoned ? " abandoned" : ""}`}>
      <button
        className="plan-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="plan-count">
          {done}/{plan.steps.length}
        </span>
        <span className="plan-summary">
          {abandoned
            ? `plan incomplete — ${pending + (current ? 1 : 0)} step${
                pending + (current ? 1 : 0) === 1 ? "" : "s"
              } not done`
            : (current?.step ?? (done === plan.steps.length ? "plan complete" : "plan"))}
        </span>
        <span className="plan-toggle">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <>
          <ol className="plan-steps">
            {plan.steps.map((s, i) => (
              <li key={i} className={`step ${s.status}`}>
                <span className="step-mark" aria-hidden="true">
                  {s.status === "completed"
                    ? "✓"
                    : s.status === "inProgress"
                      ? "▸"
                      : "○"}
                </span>
                <span className="step-text">{s.step}</span>
              </li>
            ))}
          </ol>
          {plan.explanation && (
            <p className="plan-explanation">{plan.explanation}</p>
          )}
        </>
      )}
    </div>
  );
}
