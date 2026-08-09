import { useEffect, useRef, useState } from "react";
import type {
  CurrentQueuedMessage,
  CurrentSteerState,
} from "../compatibility/outboxPresentation";

/**
 * The message queue (§8.1).
 *
 * Typing while the agent works does not block and does not interrupt — the
 * message joins a queue that drains into the running turn by steering. That
 * makes the queue a thing the user manages, not a hidden buffer: entries are
 * editable, removable, and reorderable, because order decides what the agent
 * does next.
 *
 * The header carries `SteerState` for one reason: a message can sit in the
 * queue because it is waiting its turn, or because the server refused to
 * steer this turn kind. Those look identical without a label, and the second
 * one reads as the app being stuck.
 */
export function QueuePane({
  messages,
  steer,
  capacity,
  running,
  onRemove,
  onEdit,
  onMove,
  onSteerNow,
}: {
  messages: CurrentQueuedMessage[];
  steer: CurrentSteerState;
  capacity: number;
  /** A turn is in flight, so the head of the queue can be steered into it. */
  running: boolean;
  onRemove: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onSteerNow: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const steering = steer.kind === "steering";

  // A dispatched entry is immutable in the domain until the server answers.
  // Mirror that boundary in the UI instead of leaving controls enabled that
  // can only appear to work. Also close an editor whose entry drained or was
  // removed by an outbox event.
  useEffect(() => {
    if (
      steering ||
      (editing !== null && !messages.some((message) => message.id === editing))
    ) {
      setEditing(null);
    }
  }, [editing, messages, steering]);

  if (messages.length === 0) return null;

  return (
    <section
      className={`queue${steering ? " steering" : ""}`}
      aria-label="Message queue"
      aria-busy={steering}
    >
      <div className="queue-head" aria-live="polite">
        <span className="queue-count">
          {messages.length === 1
            ? "1 message queued"
            : `${messages.length} messages queued`}
          {messages.length >= capacity && " · full"}
        </span>
        <div className="queue-head-right">
          <SteerStatus steer={steer} />
          {messages.length >= capacity && steer.kind === "idle" && (
            <span className="queue-capacity">capacity {capacity}</span>
          )}
          {/* Queueing waits for turn end by default; this is the "don't
              wait" path, so it only exists while a turn is running. */}
          {running && (steer.kind === "idle" || steer.kind === "failed") && (
            <button
              type="button"
              className="queue-send-now"
              onClick={onSteerNow}
              title="Steer the first message into the current turn"
            >
              Send now
            </button>
          )}
        </div>
      </div>

      <div className="queue-list">
        {messages.map((m, i) => (
          <QueuedRow
            key={m.id}
            message={m}
            index={i}
            last={i === messages.length - 1}
            editing={editing === m.id}
            disabled={steering}
            onStartEdit={() => setEditing(m.id)}
            onEndEdit={() => setEditing(null)}
            onRemove={() => onRemove(m.id)}
            onEdit={(text) => onEdit(m.id, text)}
            onMove={(delta) => onMove(m.id, i + delta)}
          />
        ))}
      </div>
    </section>
  );
}

/** Only the states worth interrupting the user for say anything at all. */
function SteerStatus({ steer }: { steer: CurrentSteerState }) {
  if (steer.kind === "steering") {
    return (
      <span className="steer-status sending" title="Steering into current turn">
        <span className="steer-spinner" aria-hidden="true" />
        Sending…
      </span>
    );
  }
  if (steer.kind === "notSteerable") {
    return (
      <span className="steer-status waiting">
        {steer.turnKind === "review" ? "review" : "compaction"} in progress —
        sends when it finishes
      </span>
    );
  }
  if (steer.kind === "failed") {
    return <span className="steer-status failed">{steer.message}</span>;
  }
  return null;
}

function QueuedRow({
  message,
  index,
  last,
  editing,
  disabled,
  onStartEdit,
  onEndEdit,
  onRemove,
  onEdit,
  onMove,
}: {
  message: CurrentQueuedMessage;
  index: number;
  last: boolean;
  editing: boolean;
  disabled: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onRemove: () => void;
  onEdit: (text: string) => void;
  onMove: (delta: number) => void;
}) {
  const [text, setText] = useState(message.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setText(message.text);
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing, message.text]);

  const commit = () => {
    if (text !== message.text) onEdit(text);
    onEndEdit();
  };

  if (editing) {
    return (
      <div className="queued editing">
        <textarea
          ref={ref}
          value={text}
          rows={2}
          aria-label="Edit queued message"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter commits; Shift+Enter is a newline, matching the composer.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") onEndEdit();
          }}
        />
        <div className="queue-edit-foot">
          <span>Enter saves · Shift+Enter newline · Esc cancels</span>
          <button
            type="button"
            className="primary"
            disabled={disabled}
            onClick={commit}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="queued">
      <span className="queue-pos">{index + 1}</span>
      <span className="queue-text" title={message.text}>
        {message.text}
      </span>
      {(message.attachments?.length ?? 0) > 0 && (
        <span className="queue-attach">
          {message.attachments!.length} attached
        </span>
      )}
      <span className="queue-actions">
        <button
          type="button"
          disabled={disabled || index === 0}
          aria-label="Move up"
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          disabled={disabled || last}
          aria-label="Move down"
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Edit"
          onClick={onStartEdit}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="Remove"
          onClick={onRemove}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
