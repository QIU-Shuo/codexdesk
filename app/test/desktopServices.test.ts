import { describe, expect, it, vi } from "vitest";
import { submitCapturedPrompt } from "../src/application/domains/desktop/PromptCapture";
import { shouldPresentNotification } from "../src/application/domains/desktop/NotificationPolicy";
import {
  dismissOnBlur,
  isSafeExternalUrl,
  isTrustedRendererNavigation,
  reusesExistingWindow,
} from "../src/application/domains/desktop/WindowPolicy";

describe("prompt capture", () => {
  it("trims and submits through conversation ports", async () => {
    const createConversation = vi.fn(async () => "conversation-1");
    const sendPrompt = vi.fn(async () => ({}));
    await expect(
      submitCapturedPrompt("  explain this  ", {
        createConversation,
        sendPrompt,
      }),
    ).resolves.toEqual({
      kind: "submitted",
      conversationId: "conversation-1",
    });
    expect(sendPrompt).toHaveBeenCalledWith("conversation-1", "explain this");
  });

  it("does not create a conversation for an empty draft", async () => {
    const createConversation = vi.fn(async () => "conversation-1");
    await expect(
      submitCapturedPrompt("  ", {
        createConversation,
        sendPrompt: async () => ({}),
      }),
    ).resolves.toEqual({ kind: "invalid" });
    expect(createConversation).not.toHaveBeenCalled();
  });
});

describe("desktop attention policy", () => {
  it("suppresses only visible focused work in unfocused mode", () => {
    expect(
      shouldPresentNotification({
        mode: "unfocused",
        mainWindowFocused: true,
        targetConversationVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldPresentNotification({
        mode: "unfocused",
        mainWindowFocused: true,
        targetConversationVisible: false,
      }),
    ).toBe(true);
    expect(
      shouldPresentNotification({
        mode: "off",
        mainWindowFocused: false,
        targetConversationVisible: false,
      }),
    ).toBe(false);
  });
});

describe("auxiliary window policy", () => {
  it("dismisses and reuses prompt capture without conflating conversation windows", () => {
    expect(dismissOnBlur({ kind: "promptCapture" })).toBe(true);
    expect(
      dismissOnBlur({ kind: "conversation", conversationId: "one" }),
    ).toBe(false);
    expect(
      reusesExistingWindow(
        { kind: "promptCapture" },
        { kind: "promptCapture" },
      ),
    ).toBe(true);
    expect(
      reusesExistingWindow(
        { kind: "conversation", conversationId: "one" },
        { kind: "conversation", conversationId: "two" },
      ),
    ).toBe(false);
  });
});

describe("renderer navigation policy", () => {
  it("keeps navigation on the exact renderer document", () => {
    expect(
      isTrustedRendererNavigation(
        "http://localhost:5173/#conversation-1",
        "http://localhost:5173",
      ),
    ).toBe(true);
    expect(
      isTrustedRendererNavigation(
        "file:///Applications/CodexDesk/resources/index.html#thread",
        "file:///Applications/CodexDesk/resources/index.html",
      ),
    ).toBe(true);

    expect(
      isTrustedRendererNavigation(
        "http://localhost:5173/settings",
        "http://localhost:5173",
      ),
    ).toBe(false);
    expect(
      isTrustedRendererNavigation(
        "http://localhost:5173/?redirect=https://example.com",
        "http://localhost:5173",
      ),
    ).toBe(false);
    expect(
      isTrustedRendererNavigation(
        "http://localhost.attacker.example:5173/",
        "http://localhost:5173",
      ),
    ).toBe(false);
    expect(
      isTrustedRendererNavigation(
        "file:///Applications/CodexDesk/resources/other.html",
        "file:///Applications/CodexDesk/resources/index.html",
      ),
    ).toBe(false);
    expect(
      isTrustedRendererNavigation("not a URL", "http://localhost:5173"),
    ).toBe(false);
  });

  it("routes only HTTP and HTTPS links to the system browser", () => {
    expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:3000/path")).toBe(true);

    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,hello")).toBe(false);
    expect(isSafeExternalUrl("custom-app://open")).toBe(false);
    expect(isSafeExternalUrl("not a URL")).toBe(false);
  });
});
