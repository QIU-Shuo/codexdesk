import { useEffect, useRef, useState } from "react";
import { readProductStorage } from "./productStorage";

/**
 * A transient, globally focusable draft that creates a normal conversation.
 * The draft survives dismissal locally; agent state remains in the main
 * conversation service.
 */
const DRAFT_KEY = "codexdesk:promptCaptureDraft";
const LEGACY_DRAFT_KEY = "codexdesk:quickChatDraft";

export function PromptCapture() {
  const [text, setText] = useState(() => {
    try {
      return (
        readProductStorage(DRAFT_KEY) ??
        readProductStorage(LEGACY_DRAFT_KEY) ??
        ""
      );
    } catch {
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, text);
      localStorage.removeItem(LEGACY_DRAFT_KEY);
    } catch {
      // Non-fatal.
    }
  }, [text]);

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const id = await window.codexDesk.promptCaptureSubmit(body);
    if (id) {
      setText("");
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // Non-fatal.
      }
      void window.codexDesk.promptCaptureClose();
    } else {
      setSending(false);
    }
  };

  return (
    <div className="prompt-capture">
      <textarea
        ref={ref}
        value={text}
        placeholder="Ask the agent…  (Enter to send, Esc to dismiss)"
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") void window.codexDesk.promptCaptureClose();
        }}
      />
      <div className="prompt-capture-foot">
        <span className="muted">
          {sending ? "Starting a thread…" : "Starts a new thread"}
        </span>
        <span className="spacer" />
        <button
          disabled={!text.trim() || sending}
          onClick={() => void submit()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
