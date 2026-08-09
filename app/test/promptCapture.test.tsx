import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PromptCapture } from "../src/renderer/main_window/PromptCapture";

describe("PromptCapture", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("migrates the previous local draft key", () => {
    localStorage.setItem("occo:quickChatDraft", "Saved prompt");

    render(<PromptCapture />);

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Saved prompt",
    );
    expect(localStorage.getItem("codexdesk:promptCaptureDraft")).toBe(
      "Saved prompt",
    );
    expect(localStorage.getItem("occo:quickChatDraft")).toBeNull();
  });
});
