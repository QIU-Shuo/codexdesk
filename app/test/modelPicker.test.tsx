import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigState } from "../src/shared/ipc";
import { ModelPicker } from "../src/renderer/main_window/ModelPicker";

function config(over: Partial<ConfigState> = {}): ConfigState {
  return {
    models: [
      {
        id: "sol",
        displayName: "GPT Sol",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper reasoning" },
        ],
        serviceTiers: [
          { id: "fast", name: "Fast", description: "Faster responses" },
        ],
        defaultServiceTier: null,
        isDefault: true,
      } as never,
    ],
    permissionProfiles: [],
    skills: { status: "ready", items: [] },
    skillErrors: [],
    currentModel: null,
    currentReasoningEffort: null,
    currentServiceTier: null,
    approvalsReviewer: "user",
    approvalMode: "auto",
    allowedApprovalModes: null,
    webSearchMode: null,
    allowedWebSearchModes: null,
    ...over,
  };
}

afterEach(cleanup);

describe("ModelPicker", () => {
  it("offers the standard tier alongside server-provided speed tiers", () => {
    const onSelectServiceTier = vi.fn();
    render(
      <ModelPicker
        config={config()}
        onSelectModel={() => {}}
        onSelectEffort={() => {}}
        onSelectServiceTier={onSelectServiceTier}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /GPT Sol High/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    expect(onSelectServiceTier).toHaveBeenLastCalledWith("fast");
    fireEvent.click(screen.getByRole("button", { name: "Standard" }));
    expect(onSelectServiceTier).toHaveBeenLastCalledWith(null);
  });

  it("shows the selected speed tier in the compact trigger", () => {
    render(
      <ModelPicker
        config={config({ currentServiceTier: "fast" })}
        onSelectModel={() => {}}
        onSelectEffort={() => {}}
        onSelectServiceTier={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /GPT Sol High Fast/ }),
    ).toBeTruthy();
  });
});
