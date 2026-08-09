import { useEffect, useRef, useState } from "react";
import type { ReasoningEffort } from "../../protocol/generated/ReasoningEffort";
import type { ConfigState } from "../../shared/ipc";
import { useAnchoredPopover } from "./useAnchoredPopover";

/** One compact control for the model and the two model-scoped options. */
export function ModelPicker({
  config,
  disabled = false,
  onSelectModel,
  onSelectEffort,
  onSelectServiceTier,
}: {
  config: ConfigState;
  disabled?: boolean;
  onSelectModel: (model: string | null) => void;
  onSelectEffort: (effort: ReasoningEffort | null) => void;
  onSelectServiceTier: (tier: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useAnchoredPopover(open, triggerRef, menuRef);
  const selected =
    config.models.find((model) => model.id === config.currentModel) ??
    config.models.find((model) => model.isDefault) ??
    config.models[0];
  const effectiveEffort =
    config.currentReasoningEffort ?? selected?.defaultReasoningEffort ?? null;
  const effectiveTier =
    config.currentServiceTier ?? selected?.defaultServiceTier ?? null;
  const tierName =
    selected?.serviceTiers.find((tier) => tier.id === effectiveTier)?.name ??
    null;

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

  return (
    <div className="model-picker" ref={ref}>
      <button
        ref={triggerRef}
        className="model-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={[
          selected?.displayName ?? "Default model",
          effectiveEffort ? formatEffort(effectiveEffort) : null,
          tierName,
        ]
          .filter(Boolean)
          .join(" ")}
        disabled={disabled}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span>{selected?.displayName ?? "Default model"}</span>
        {effectiveEffort && (
          <span className="model-effort">{formatEffort(effectiveEffort)}</span>
        )}
        {tierName && <span className="model-tier">{tierName}</span>}
        <span className="model-caret">⌄</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="model-menu model-menu-merged"
          role="dialog"
          aria-label="Model settings"
          style={menuStyle}
        >
          <div className="picker-heading">Model</div>
          <div className="model-catalog">
            {config.models.map((model) => {
              const active = selected?.id === model.id;
              const modelEffort = active
                ? effectiveEffort
                : model.defaultReasoningEffort;
              const modelTierId = active
                ? effectiveTier
                : model.defaultServiceTier;
              const modelTier = model.serviceTiers.find(
                (tier) => tier.id === modelTierId,
              );
              return (
                <div
                  key={model.id}
                  className={`model-catalog-item${active ? " active" : ""}`}
                >
                  <button
                    className="model-catalog-row"
                    type="button"
                    onClick={() => onSelectModel(model.id)}
                  >
                    <span className="choice-check" aria-hidden="true">
                      {active ? "✓" : ""}
                    </span>
                    <span className="choice-name">{model.displayName}</span>
                    <span className="model-choice-summary">
                      {modelEffort ? formatEffort(modelEffort) : "Default"}
                      {modelTier ? ` · ${modelTier.name}` : ""}
                    </span>
                  </button>
                  {active && (
                    <div className="model-inline-settings">
                      {model.supportedReasoningEfforts.length > 0 && (
                        <div className="model-setting-row">
                          <span className="model-setting-label">Effort</span>
                          <div className="model-chips">
                            {model.supportedReasoningEfforts.map((option) => (
                              <button
                                key={option.reasoningEffort}
                                type="button"
                                className={
                                  effectiveEffort === option.reasoningEffort
                                    ? "active"
                                    : ""
                                }
                                title={option.description || undefined}
                                onClick={() =>
                                  onSelectEffort(option.reasoningEffort)
                                }
                              >
                                {formatEffort(option.reasoningEffort)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {model.serviceTiers.length > 0 && (
                        <div className="model-setting-row">
                          <span className="model-setting-label">Speed</span>
                          <div className="model-chips">
                            <button
                              type="button"
                              className={effectiveTier === null ? "active" : ""}
                              title="Use the standard service tier"
                              onClick={() => onSelectServiceTier(null)}
                            >
                              Standard
                            </button>
                            {model.serviceTiers.map((tier) => (
                              <button
                                key={tier.id}
                                type="button"
                                className={
                                  effectiveTier === tier.id ? "active" : ""
                                }
                                title={tier.description || undefined}
                                onClick={() => onSelectServiceTier(tier.id)}
                              >
                                {tier.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="picker-footer">
            <button
              type="button"
              onClick={() => {
                onSelectModel(null);
                onSelectEffort(null);
                onSelectServiceTier(null);
              }}
            >
              Reset to defaults
            </button>
            <kbd>esc</kbd>
          </div>
        </div>
      )}
    </div>
  );
}

function formatEffort(effort: string): string {
  if (effort === "xhigh") return "Extra High";
  return effort
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}
