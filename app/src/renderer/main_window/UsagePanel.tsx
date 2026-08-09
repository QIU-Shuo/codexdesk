import { useEffect, useState } from "react";
import type { Budget, UsageReport } from "../../shared/ipc";
import { BudgetBar } from "./BudgetBar";

/**
 * Account usage, and the live headroom that used to sit in the header.
 *
 * Two different questions share this panel deliberately. The report answers
 * *what have I spent over time* and is pulled on open. `BudgetBar` answers
 * *how close am I to a wall right now* — it used to occupy a permanent strip
 * under the topbar, which spent fixed vertical space on every thread to
 * answer a question the user asks occasionally. Both now live behind the
 * sidebar's Usage control.
 *
 * `account/usage/read` is unavailable on some accounts (signed out, and
 * API-key accounts with no usage backend). That reads as an absence, not a
 * fault, so it says so plainly rather than showing an error. The live budget
 * is independent of it and still renders in that case.
 */
export function UsagePanel({
  onClose,
  budget,
  onRedeem,
}: {
  onClose: () => void;
  /** Live context and rate-limit headroom for the active thread. */
  budget?: Budget;
  onRedeem?: () => void;
}) {
  const [report, setReport] = useState<UsageReport | null | "loading">(
    "loading",
  );

  useEffect(() => {
    let live = true;
    void window.codexDesk.readUsage().then((r) => {
      if (live) setReport(r);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="usage-panel">
      <div className="usage-head">
        <strong>Usage</strong>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {budget && <BudgetBar budget={budget} onRedeem={onRedeem} />}

      {report === "loading" && <p className="hint">Reading usage…</p>}

      {report === null && (
        <p className="hint">This account does not report usage.</p>
      )}

      {report && report !== "loading" && (
        <>
          <dl className="usage-stats">
            <Stat label="Lifetime tokens" value={report.lifetimeTokens} />
            <Stat label="Peak day" value={report.peakDailyTokens} />
            <Stat
              label="Current streak"
              value={report.currentStreakDays}
              unit="days"
            />
            <Stat
              label="Longest streak"
              value={report.longestStreakDays}
              unit="days"
            />
            <Stat
              label="Longest turn"
              value={report.longestRunningTurnSec}
              unit="s"
            />
          </dl>
          <DailyChart buckets={report.dailyBuckets} />
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null;
  unit?: string;
}) {
  // A missing figure is not a zero, and showing "0" for one would be a lie.
  if (value == null) return null;
  return (
    <div className="usage-stat">
      <dt>{label}</dt>
      <dd>
        {value.toLocaleString()}
        {unit ? ` ${unit}` : ""}
      </dd>
    </div>
  );
}

/**
 * Daily buckets as bars.
 *
 * The shape of usage over time is the part a table cannot convey at a glance,
 * and the data is already ordered and one-dimensional, so bars are the whole
 * chart — no axes, no library.
 */
function DailyChart({ buckets }: { buckets: UsageReport["dailyBuckets"] }) {
  if (buckets.length === 0) return null;
  const peak = Math.max(...buckets.map((b) => b.tokens), 1);

  return (
    <div className="usage-chart" role="img" aria-label="Daily token usage">
      {buckets.map((b) => (
        <div
          key={b.startDate}
          className="usage-bar"
          title={`${b.startDate}: ${b.tokens.toLocaleString()} tokens`}
          style={{ height: `${Math.max(2, (b.tokens / peak) * 100)}%` }}
        />
      ))}
    </div>
  );
}
