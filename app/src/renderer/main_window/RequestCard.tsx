import { useState } from "react";
import type { PendingRequest, RequestAnswer } from "../../shared/ipc";
import type { CommandExecutionApprovalDecision } from "../../protocol/generated/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "../../protocol/generated/v2/FileChangeApprovalDecision";
import type { FileSystemPath } from "../../protocol/generated/v2/FileSystemPath";

/**
 * Server-initiated requests, docked immediately above the composer.
 *
 * Deliberately not modals: they are one lifecycle keyed by `requestId`, and
 * several can be open at once. A card that is dismissed without answering
 * would stall the turn silently (plan §9.1), so there is no dismiss — only
 * decisions.
 */
export function RequestCard({
  request,
  onAnswer,
  requestPosition = 1,
  requestCount = 1,
}: {
  request: PendingRequest;
  onAnswer: (requestId: string | number, answer: RequestAnswer) => void;
  requestPosition?: number;
  requestCount?: number;
}) {
  const answer = (a: RequestAnswer) => onAnswer(request.requestId, a);

  const card = (() => {
    switch (request.kind) {
      case "commandApproval":
        return <CommandApproval params={request.params} onAnswer={answer} />;
      case "fileChangeApproval":
        return <FileChangeApproval params={request.params} onAnswer={answer} />;
      case "permissions":
        return <PermissionRequest params={request.params} onAnswer={answer} />;
      case "userInput":
        return <QuestionCard params={request.params} onAnswer={answer} />;
      case "elicitation":
        return <ElicitationCard params={request.params} onAnswer={answer} />;
    }
  })();

  return (
    <div className={`request-frame${requestCount > 1 ? " has-count" : ""}`}>
      {requestCount > 1 && (
        <span className="request-count">
          {requestPosition} / {requestCount}
        </span>
      )}
      {card}
    </div>
  );
}

type Answer = (a: RequestAnswer) => void;

function CommandApproval({
  params,
  onAnswer,
}: {
  params: Extract<PendingRequest, { kind: "commandApproval" }>["params"];
  onAnswer: Answer;
}) {
  const decide = (decision: CommandExecutionApprovalDecision) =>
    onAnswer({ kind: "commandApproval", decision });

  return (
    <div className="request">
      <div className="request-title">Run a shell command?</div>
      <pre>$ {params.command ?? "(command unavailable)"}</pre>
      {params.cwd && <div className="muted">in {params.cwd}</div>}
      {params.reason && <div className="reason">{params.reason}</div>}
      {params.networkApprovalContext && (
        <div className="reason">
          network: {params.networkApprovalContext.host} (
          {params.networkApprovalContext.protocol})
        </div>
      )}
      <div className="actions">
        <button onClick={() => decide("acceptForSession")}>
          Approve for session
        </button>
        {/* Structured variants: objects, not bare strings. Sending
            "acceptWithExecpolicyAmendment" as a string is rejected (§5). */}
        {params.proposedExecpolicyAmendment && (
          <button
            onClick={() =>
              decide({
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: params.proposedExecpolicyAmendment!,
                },
              })
            }
          >
            Always allow this kind
          </button>
        )}
        {params.proposedNetworkPolicyAmendments?.map((amendment, i) => (
          <button
            key={i}
            onClick={() =>
              decide({
                applyNetworkPolicyAmendment: {
                  network_policy_amendment: amendment,
                },
              })
            }
          >
            Apply network rule
          </button>
        ))}
        <button onClick={() => decide("decline")}>Decline</button>
        <button className="request-primary" onClick={() => decide("accept")}>
          Approve once
        </button>
      </div>
    </div>
  );
}

function FileChangeApproval({
  params,
  onAnswer,
}: {
  params: Extract<PendingRequest, { kind: "fileChangeApproval" }>["params"];
  onAnswer: Answer;
}) {
  const decide = (decision: FileChangeApprovalDecision) =>
    onAnswer({ kind: "fileChangeApproval", decision });

  return (
    <div className="request">
      <div className="request-title">Allow file changes?</div>
      {params.reason && <div className="reason">{params.reason}</div>}
      {params.grantRoot && (
        <div className="muted">write access under {params.grantRoot}</div>
      )}
      <div className="actions">
        <button onClick={() => decide("acceptForSession")}>
          Approve for session
        </button>
        <button onClick={() => decide("decline")}>Decline</button>
        <button className="request-primary" onClick={() => decide("accept")}>
          Approve once
        </button>
      </div>
    </div>
  );
}

/**
 * Permission grants are a capability, not one command — kept visually and
 * structurally distinct from command approval on purpose (plan §5, step 1.1).
 */
function PermissionRequest({
  params,
  onAnswer,
}: {
  params: Extract<PendingRequest, { kind: "permissions" }>["params"];
  onAnswer: Answer;
}) {
  const { network, fileSystem } = params.permissions;

  // `network` is an *object* with an `enabled` field, so `network ?` is true
  // even for `{enabled: false}` — that granted network access the server had
  // explicitly not asked for. Compare the field, never the object.
  const wantsNetwork = network?.enabled === true;

  // `read`/`write` are documented as being replaced by `entries`, so handle
  // both: an entry names a path (or glob, or a special location) plus the
  // access mode being requested.
  const entries = fileSystem?.entries ?? [];
  const readPaths = [
    ...(fileSystem?.read ?? []),
    ...entries.filter((e) => e.access === "read").map(describePath),
  ];
  const writePaths = [
    ...(fileSystem?.write ?? []),
    ...entries.filter((e) => e.access === "write").map(describePath),
  ];
  const denied = entries.filter((e) => e.access === "deny").map(describePath);

  const nothingRequested =
    !wantsNetwork && readPaths.length === 0 && writePaths.length === 0;

  const grant = (scope: "turn" | "session") =>
    onAnswer({
      kind: "permissions",
      scope,
      granted: {
        // Only send `network` when it was actually requested; sending
        // `false` is a different statement from staying silent.
        ...(wantsNetwork ? { network: true } : {}),
        ...(readPaths.length ? { readPaths } : {}),
        ...(writePaths.length ? { writePaths } : {}),
      },
    });

  return (
    <div className="request permissions">
      <div className="request-title">Grant additional access?</div>
      {params.reason && <div className="reason">{params.reason}</div>}
      <div className="muted">in {params.cwd}</div>
      <ul>
        {wantsNetwork && <li>Network access</li>}
        {readPaths.map((p) => (
          <li key={`r${p}`}>Read {p}</li>
        ))}
        {writePaths.map((p) => (
          <li key={`w${p}`}>Write {p}</li>
        ))}
        {denied.map((p) => (
          <li key={`d${p}`} className="muted">
            Explicitly denied: {p}
          </li>
        ))}
        {nothingRequested && (
          <li className="muted">
            No additional access requested (nothing will be granted).
          </li>
        )}
      </ul>
      <div className="actions">
        <button onClick={() => grant("session")} disabled={nothingRequested}>
          Allow for session
        </button>
        <button
          onClick={() =>
            onAnswer({ kind: "permissions", scope: "turn", granted: null })
          }
        >
          {nothingRequested ? "Dismiss" : "Deny"}
        </button>
        <button
          className="request-primary"
          onClick={() => grant("turn")}
          disabled={nothingRequested}
        >
          Allow for this turn
        </button>
      </div>
    </div>
  );
}

/** `FileSystemPath` is a union: a literal path, a glob, or a named location. */
function describePath(entry: { path: FileSystemPath }): string {
  const p = entry.path;
  switch (p.type) {
    case "path":
      return p.path;
    case "glob_pattern":
      return p.pattern;
    case "special":
      return String(p.value);
  }
}

/**
 * `requestUserInput` can carry several questions at once, each with options,
 * a free-form "other" path, and secret fields. The response is a map keyed by
 * question id — not an array (plan §5, step 1.2).
 */
function QuestionCard({
  params,
  onAnswer,
}: {
  params: Extract<PendingRequest, { kind: "userInput" }>["params"];
  onAnswer: Answer;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  const submit = () => {
    const answers: Record<string, string[]> = {};
    for (const q of params.questions) {
      const v = values[q.id];
      answers[q.id] = v ? [v] : [];
    }
    onAnswer({ kind: "userInput", answers });
  };

  return (
    <div className="request question">
      <div className="request-title">Answer a question</div>
      {params.questions.map((q) => (
        <div key={q.id} className="field">
          <div className="qheader">{q.header}</div>
          <div>{q.question}</div>
          {q.options?.length ? (
            <div className="options">
              {q.options.map((o) => (
                <button
                  key={o.label}
                  className={values[q.id] === o.label ? "selected" : ""}
                  title={o.description}
                  onClick={() =>
                    setValues((prev) => ({ ...prev, [q.id]: o.label }))
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
          {(q.isOther || !q.options?.length) && (
            <input
              type={q.isSecret ? "password" : "text"}
              value={values[q.id] ?? ""}
              placeholder={q.isSecret ? "hidden" : "Your answer"}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [q.id]: e.target.value }))
              }
            />
          )}
        </div>
      ))}
      <div className="actions">
        <button onClick={() => onAnswer({ kind: "decline" })}>Skip</button>
        <button className="request-primary" onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  );
}

/**
 * MCP elicitation. Three modes; `url` just opens a link, `form` collects
 * flat string fields. Full schema rendering is deferred — an unanswered
 * elicitation deadlocks an otherwise ordinary turn, so covering the safe
 * minimum matters more than covering every schema type (plan §5, step 1.3).
 */
function ElicitationCard({
  params,
  onAnswer,
}: {
  params: Extract<PendingRequest, { kind: "elicitation" }>["params"];
  onAnswer: Answer;
}) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const isForm = params.mode === "form" || params.mode === "openai/form";
  const properties =
    params.mode === "form"
      ? Object.keys(params.requestedSchema.properties ?? {})
      : [];

  return (
    <div className="request elicitation">
      <div className="request-title">{params.serverName} needs input</div>
      <div>{params.message}</div>

      {params.mode === "url" && (
        <div className="actions">
          <a href={params.url} target="_blank" rel="noreferrer">
            {params.url}
          </a>
        </div>
      )}

      {params.mode === "form" &&
        properties.map((name) => (
          <div key={name} className="field">
            <label>{name}</label>
            <input
              value={fields[name] ?? ""}
              onChange={(e) =>
                setFields((prev) => ({ ...prev, [name]: e.target.value }))
              }
            />
          </div>
        ))}

      <div className="actions">
        <button
          onClick={() =>
            onAnswer({ kind: "elicitation", action: "cancel", content: null })
          }
        >
          Cancel
        </button>
        <button
          onClick={() =>
            onAnswer({ kind: "elicitation", action: "decline", content: null })
          }
        >
          Decline
        </button>
        <button
          className="request-primary"
          onClick={() =>
            onAnswer({
              kind: "elicitation",
              action: "accept",
              content: isForm ? fields : null,
            })
          }
        >
          Accept
        </button>
      </div>
    </div>
  );
}
