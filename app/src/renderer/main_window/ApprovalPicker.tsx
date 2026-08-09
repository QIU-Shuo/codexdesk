import { useEffect, useRef, useState } from "react";
import { APPROVAL_MODES, type ApprovalMode } from "../../contracts/approvals";
import type { ConfigState } from "../../shared/ipc";
import { useAnchoredPopover } from "./useAnchoredPopover";

/**
 * The approval posture control, sitting beside the model picker.
 *
 * It lives in the composer rather than a settings panel because that is where
 * the choice has consequences: the posture applies to the message about to be
 * sent, so it should be visible and changeable at that moment.
 */
const MODE_LABELS: Record<ApprovalMode, { title: string; detail: string }> = {
  "read-only": {
    title: "Read Only",
    detail:
      "Reads files in this workspace. Editing files or reaching the network needs approval.",
  },
  auto: {
    title: "Auto",
    detail:
      "Reads, edits, and runs commands in this workspace. Anything outside it needs approval.",
  },
  "full-access": {
    title: "Full Access",
    detail:
      "Edits files anywhere and reaches the network without asking. Nothing is held back for approval.",
  },
};

export function ApprovalPicker({
  config,
  mode,
  disabled = false,
  onSelect,
}: {
  config: ConfigState;
  mode: ApprovalMode;
  disabled?: boolean;
  onSelect: (mode: ApprovalMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useAnchoredPopover(open, triggerRef, menuRef);

  /**
   * `allowedApprovalModes` is operator policy, already resolved in the main
   * process from `configRequirements/read`. Null means unconstrained; a list
   * means only those. Offering a mode outside it would present a control an
   * admin has disabled.
   */
  const allowed = config.allowedApprovalModes;
  const permitted =
    allowed && allowed.length > 0
      ? APPROVAL_MODES.filter((candidate) => allowed.includes(candidate))
      : [...APPROVAL_MODES];

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (next: ApprovalMode) => {
    onSelect(next);
    setOpen(false);
  };

  return (
    <div className="model-picker approval-picker" ref={ref}>
      <button
        ref={triggerRef}
        className="model-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title="Approval mode"
        onClick={() => setOpen((shown) => !shown)}
      >
        <span>{MODE_LABELS[mode].title}</span>
        <span className="model-caret">⌄</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="model-menu approval-menu"
          role="dialog"
          aria-label="Approval mode"
          style={menuStyle}
        >
          <section className="picker-panel">
            <div className="picker-heading">Approval mode</div>
            <div className="approval-choices">
              {permitted.map((candidate) => {
                const active = candidate === mode;
                return (
                  <button
                    key={candidate}
                    className={`model-choice${active ? " active" : ""}`}
                    type="button"
                    onClick={() => choose(candidate)}
                  >
                    <span className="choice-check" aria-hidden="true">
                      {active ? "✓" : ""}
                    </span>
                    <span className="approval-choice-copy">
                      <span className="choice-name">
                        {MODE_LABELS[candidate].title}
                        {active && <small>Current</small>}
                        {candidate === "full-access" && (
                          <small className="no-prompts">No prompts</small>
                        )}
                      </span>
                      <span className="choice-description">
                        {MODE_LABELS[candidate].detail}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {permitted.length < APPROVAL_MODES.length && (
              <p className="hint">
                Some modes are unavailable because of your organization's
                policy.
              </p>
            )}
          </section>
          <div className="approval-config-key">
            <code>approval_policy</code>
            <span>·</span>
            <code>sandbox_mode</code>
          </div>
        </div>
      )}
    </div>
  );
}
