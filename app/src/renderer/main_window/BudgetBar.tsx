import type { Budget } from "../../shared/ipc";

/**
 * Context and rate-limit headroom (plan §5, step 2.4).
 *
 * The point is to show a wall *before* you hit it: these are the same
 * conditions as `contextWindowExceeded` and `usageLimitExceeded` in
 * `CodexErrorInfo`, surfaced ahead of the failure instead of after it.
 */
export function BudgetBar({
  budget,
  onRedeem,
}: {
  budget: Budget;
  /** Redeem an earned rate-limit reset (§8.6). */
  onRedeem?: () => void;
}) {
  const { tokenUsage, rateLimits } = budget;
  if (!tokenUsage && !rateLimits) return null;

  const window = tokenUsage?.modelContextWindow ?? null;
  const used = tokenUsage?.total.totalTokens ?? 0;
  const contextPct = window ? Math.min(100, (used / window) * 100) : null;

  const primary = rateLimits?.primary ?? null;
  const secondary = rateLimits?.secondary ?? null;

  return (
    <div className="budget">
      {contextPct !== null && (
        <span className={contextPct > 80 ? "warn" : ""}>
          context {contextPct.toFixed(0)}%
          <span className="muted"> ({used.toLocaleString()} tok)</span>
        </span>
      )}
      {primary && (
        <span className={primary.usedPercent > 80 ? "warn" : ""}>
          limit {primary.usedPercent.toFixed(0)}%
          {primary.resetsAt ? (
            <span className="muted"> · resets {formatReset(primary.resetsAt)}</span>
          ) : null}
        </span>
      )}
      {secondary && (
        <span className="muted">
          secondary {secondary.usedPercent.toFixed(0)}%
        </span>
      )}
      {/* Credits are the answer to "I hit the limit, now what" — worth
          showing next to the limit rather than on a settings page. */}
      {rateLimits?.credits?.hasCredits && (
        <span className="muted">
          {rateLimits.credits.unlimited
            ? "credits: unlimited"
            : `credits: ${rateLimits.credits.balance ?? "available"}`}
        </span>
      )}
      {rateLimits?.rateLimitReachedType && (
        <span className="error">
          limit reached: {rateLimits.rateLimitReachedType}
          {/* An earned reset is only useful at the moment the limit bites,
              so the redeem action lives here rather than in the report. */}
          {onRedeem && (
            <button className="linkish" onClick={onRedeem}>
              Use a reset credit
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function formatReset(resetsAt: number): string {
  // Unix seconds upstream; tolerate millisecond values defensively.
  const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const delta = ms - Date.now();
  if (delta <= 0) return "now";
  const mins = Math.round(delta / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
