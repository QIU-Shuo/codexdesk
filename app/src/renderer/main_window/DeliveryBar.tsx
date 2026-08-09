import { useEffect, useState } from "react";
import type { ReviewSubmissionTarget } from "../../shared/ipc";
import type { CurrentDeliveryView } from "../compatibility/deliveryPresentation";
import type { CurrentReviewComment } from "../compatibility/reviewPresentation";

/**
 * Commit → push → draft PR, and the comment submission that sits alongside it
 * (plan §7.2, §7.3).
 *
 * The design rule here is §7.2's: **a disabled button with no explanation is
 * not debuggable.** Every blocker the state machine can report has a sentence
 * and, where one exists, the action that clears it. The step indicator shows
 * where the flow actually is — which after a restart is wherever the
 * repository says, not wherever we left off.
 */

const STEPS = ["commit", "push", "pr"] as const;

const STEP_LABEL: Record<(typeof STEPS)[number], string> = {
  commit: "Commit",
  push: "Push",
  pr: "Draft PR",
};

export function DeliveryBar({
  delivery,
  comments,
  onPrepare,
  onCommit,
  onPush,
  onCreatePr,
  onProposeMessage,
  onSubmitComments,
  refreshToken = 0,
}: {
  delivery: CurrentDeliveryView | null;
  comments: CurrentReviewComment[];
  onPrepare: () => void;
  onCommit: (message: string, selected: string[]) => void;
  onPush: () => void;
  onCreatePr: (title: string, body: string) => void;
  onProposeMessage: () => Promise<string>;
  onSubmitComments: (text: string, target: ReviewSubmissionTarget) => void;
  /** Bumped by the parent when the working tree changes or a turn ends. */
  refreshToken?: number;
}) {
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [commentText, setCommentText] = useState("");
  const [target, setTarget] = useState<"fork" | "same">("fork");
  const [open, setOpen] = useState(false);

  /**
   * Re-observe whenever the working tree might have moved.
   *
   * On mount only was not enough: the panel read the repository once, before
   * the agent had written anything, and then said "Nothing to deliver yet"
   * while the changes pane beside it listed three modified files. The step has
   * to come from the repository *now*, not from the first time we looked.
   */
  useEffect(() => {
    onPrepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const step = delivery?.step ?? "prepare";
  const busy = delivery?.busy ?? false;
  const notice = delivery?.notice ?? null;
  // Defaulted rather than read through `delivery`: these arrive over IPC, and
  // a payload emitted by a main process that has not caught up to a renderer
  // reload can be missing a newly added field. TypeScript cannot see across
  // that boundary, so the guard has to be here.
  const files = delivery?.files ?? [];
  const changes = delivery?.changes ?? [];

  /**
   * Which paths go into the commit.
   *
   * `null` means "the user has not touched this yet", so the default below
   * applies. Ticking or unticking anything makes it an explicit set.
   *
   * **The default excludes work the user staged themselves.** A path that is
   * staged with a clean worktree (`staged && !unstaged`) was put in the index
   * deliberately and nothing has touched it since — folding that into our
   * commit is what §7.2 forbids, and defaulting every box to ticked did
   * exactly that.
   *
   * This is *not* a return of the classifier that used to live in
   * `splitStagedByOwner`. That version **filtered** — a failed pre-commit hook
   * left the agent's own files staged, they were reclassified as the user's,
   * and the pane then said there was nothing to deliver, with no way back.
   * The distinction that makes this safe is that nothing is hidden: every
   * changed path is listed, tagged `staged`, and one click from being
   * included. A wrong guess costs a tick, not a dead end.
   */
  const [selected, setSelected] = useState<Set<string> | null>(null);

  /** Staged with a clean worktree: the user put it there on purpose. */
  const preStaged = (p: string) => {
    const info = changes.find((c) => c.path === p);
    return Boolean(info?.staged) && !info?.unstaged && !info?.untracked;
  };
  const defaultSelection = () => files.filter((f) => !preStaged(f));

  // A new file list invalidates a selection made against the old one.
  useEffect(() => {
    setSelected(null);
  }, [files.join("\u0000")]);

  const isSelected = (p: string) =>
    selected === null ? !preStaged(p) : selected.has(p);
  const toggleFile = (p: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? defaultSelection());
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const chosen = files.filter(isSelected);

  // Offer a message the moment there is something to commit, so the common
  // path is "glance, adjust, commit" rather than "stare at an empty box".
  useEffect(() => {
    if (step === "commit" && !message) {
      void onProposeMessage().then((m) => m && setMessage(m));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const reached = (s: (typeof STEPS)[number]) => {
    const order = ["prepare", "commit", "push", "pr", "done"];
    return order.indexOf(step) > order.indexOf(s);
  };

  return (
    <div className="delivery">
      <button
        className="delivery-summary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="delivery-title">Ship</span>
        <span className="delivery-steps">
          {STEPS.map((s) => (
            <span
              key={s}
              className={`pip${step === s ? " current" : ""}${
                reached(s) ? " done" : ""
              }`}
            >
              {STEP_LABEL[s]}
            </span>
          ))}
        </span>
        {delivery?.branch && (
          <code className="delivery-branch" title={delivery.branch}>
            {delivery.branch}
          </code>
        )}
        {comments.length > 0 && (
          <span className="delivery-comments">{comments.length} comments</span>
        )}
      </button>

      {open && (
        <div className="delivery-body">
          {notice && (
            <div
              className={`blocker${notice.recoverable ? "" : " fatal"}`}
              role="status"
            >
              <strong>{notice.title}</strong>
              <span>{notice.detail}</span>
            </div>
          )}

          {/* Comments go first: reviewing produces corrections, and sending
              them is what you do *before* shipping (§7.3). */}
          {comments.length > 0 && (
            <section className="delivery-section">
              <h4>Send {comments.length} comments</h4>
              <textarea
                rows={2}
                value={commentText}
                placeholder="Anything to add? (optional)"
                onChange={(e) => setCommentText(e.target.value)}
              />
              <div className="row">
                <label className="choice">
                  <input
                    type="radio"
                    checked={target === "fork"}
                    onChange={() => setTarget("fork")}
                  />
                  To a fork
                </label>
                <label className="choice">
                  <input
                    type="radio"
                    checked={target === "same"}
                    onChange={() => setTarget("same")}
                  />
                  To this thread
                </label>
                <button
                  className="primary"
                  onClick={() => {
                    onSubmitComments(commentText, { kind: target });
                    setCommentText("");
                  }}
                >
                  Send
                </button>
              </div>
              <p className="hint">
                A fork keeps this thread intact as the one you reviewed.
              </p>
            </section>
          )}

          {step === "commit" && (
            <section className="delivery-section">
              <h4>
                Commit {chosen.length} of {files.length} files
                {delivery ? (
                  <span className="counts">
                    <span className="add">+{delivery.additions}</span>
                    <span className="del">−{delivery.deletions}</span>
                  </span>
                ) : null}
              </h4>
              {files.length > 0 && (
                <ul className="delivery-files">
                  {files.map((f) => {
                    const info = changes.find((c) => c.path === f);
                    return (
                      <li key={f}>
                        <label className="file-choice">
                          <input
                            type="checkbox"
                            checked={isSelected(f)}
                            onChange={() => toggleFile(f)}
                          />
                          <span className="file-path">{f}</span>
                          {info?.untracked && (
                            <span className="file-tag new">new</span>
                          )}
                          {info?.staged && (
                            <span className="file-tag staged">staged</span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <textarea
                rows={3}
                value={message}
                placeholder="Commit message"
                onChange={(e) => setMessage(e.target.value)}
              />
              {files.some(preStaged) && (
                <p className="hint">
                  Unticked files were already staged before this task, so they
                  are left out by default. Tick one to include it. Everything
                  ticked goes into the commit; nothing else is touched.
                </p>
              )}
              <div className="row end">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !message.trim() ||
                    Boolean(notice) ||
                    chosen.length === 0
                  }
                  onClick={() => onCommit(message, chosen)}
                >
                  {busy ? "Committing…" : "Commit"}
                </button>
              </div>
            </section>
          )}

          {step === "push" && (
            <section className="delivery-section">
              <h4>Push {delivery?.branch}</h4>
              <p className="hint">
                {delivery?.upstream
                  ? `Updating ${delivery.upstream}.`
                  : `Setting upstream on ${delivery?.remote ?? "origin"}.`}
              </p>
              <div className="row end">
                <button className="primary" disabled={busy} onClick={onPush}>
                  {busy ? "Pushing…" : "Push"}
                </button>
              </div>
            </section>
          )}

          {step === "pr" && (
            <section className="delivery-section">
              <h4>Open a draft pull request</h4>
              <input
                value={prTitle}
                placeholder="Title"
                onChange={(e) => setPrTitle(e.target.value)}
              />
              <textarea
                rows={4}
                value={prBody}
                placeholder="Description"
                onChange={(e) => setPrBody(e.target.value)}
              />
              <div className="row end">
                <button
                  className="primary"
                  disabled={busy || !prTitle.trim()}
                  onClick={() => onCreatePr(prTitle, prBody)}
                >
                  {busy ? "Creating…" : "Create draft PR"}
                </button>
              </div>
            </section>
          )}

          {delivery?.prUrl && (
            <section className="delivery-section done">
              <h4>Pull request open</h4>
              <a href={delivery.prUrl} target="_blank" rel="noreferrer">
                {delivery.prUrl}
              </a>
            </section>
          )}

          {step === "prepare" && !notice && (
            <p className="hint">Nothing to deliver yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
