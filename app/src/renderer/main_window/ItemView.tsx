import { useEffect, useState } from "react";
import type { PendingRequest } from "../../shared/ipc";
import type { ThreadItem } from "../../protocol/generated/v2/ThreadItem";
import type { UserInput } from "../../protocol/generated/v2/UserInput";
import type { CommandAction } from "../../protocol/generated/v2/CommandAction";
import { isReplCall, replSource, replTitle } from "./replCall";
import { Markdown } from "./Markdown";
import {
  buildWorkSections,
  hasReasoningBody,
  type ItemEntry,
  type WorkSection,
} from "./transcriptRows";

/**
 * Buffered deltas for one item: stream name -> index -> accumulated text.
 * Reasoning is why this is two levels deep rather than a flat string — see
 * `DeltaKind` in shared/ipc.ts.
 */
export type ItemStreams = Record<string, Record<number, string>>;

/**
 * One entry in a `fileChange` patch, derived rather than imported.
 *
 * `FileUpdateChange` and `PatchChangeKind` are generated protocol types, and
 * `tools/architecture/check-boundaries.mjs` rejects new renderer imports of
 * those — the three `ItemView.tsx` edges it already tolerates are recorded
 * debt, not a precedent. Reading the shape off `ThreadItem`, which is
 * imported above and already on that list, gives the same types without
 * widening the boundary.
 */
type FileUpdateChange = Extract<
  ThreadItem,
  { type: "fileChange" }
>["changes"][number];
type PatchChangeKind = FileUpdateChange["kind"];

/**
 * Phase 0 rendered five of the eighteen `ThreadItem` variants; everything else
 * falls through to a visible placeholder. Thirteen variants silently vanishing
 * is the §9.1 failure mode again: the UI looks fine while the agent's actual
 * work is invisible.
 */
const RENDERED = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  // Tool, search, generated-image, compaction, and collaboration records.
  // `dynamicToolCall` shares the same presentation family as `mcpToolCall`.
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageGeneration",
  "contextCompaction",
  "subAgentActivity",
  // The remaining variants. None was in the plan's priority list, so all six
  // fell through to the `unrendered:` placeholder — and because the fallback
  // is *inside* the collapsed work disclosure, they were not visible as
  // placeholders either. They simply vanished, which is exactly the §9.1
  // failure the placeholder exists to prevent. Show every one as a progress
  // row.
  "imageView",
  "plan",
  "sleep",
  "hookPrompt",
  "collabAgentToolCall",
  "enteredReviewMode",
  "exitedReviewMode",
]);

/** Concatenate an indexed stream in index order, not arrival order. */
function joinStream(stream: Record<number, string> | undefined): string {
  if (!stream) return "";
  return Object.keys(stream)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => stream[i] ?? "")
    .join("");
}

export function ItemView({
  item,
  streams,
  active = false,
  turnId,
  turnCompleted = false,
  startedAtMs,
  completedAtMs,
  nowMs,
  onBranch,
  onOpenFile,
  workspaceRoot,
}: {
  item: ThreadItem;
  streams?: ItemStreams;
  /** True while the item is still live. Drives stream-then-collapse behavior. */
  active?: boolean;
  /** Protocol identity for the turn that owns this item. */
  turnId?: string;
  /** True only after the owning turn has reached a terminal state. */
  turnCompleted?: boolean;
  /** App-server lifecycle timestamps are exact, unlike renderer mount time. */
  startedAtMs?: number;
  completedAtMs?: number;
  /** Shared live clock from WorkDisclosure, so every visible timer ticks in sync. */
  nowMs?: number;
  onBranch?: (turnId: string) => Promise<string | null>;
  /** Open a changed file in the viewer. Absent where there is no viewer. */
  onOpenFile?: (path: string) => void;
  /** Absolute workspace path, used to shorten the paths rows display. */
  workspaceRoot?: string;
}) {
  const type = item.type;
  const lifecycleDuration = elapsedDuration(
    startedAtMs,
    completedAtMs,
    active ? (nowMs ?? Date.now()) : undefined,
  );

  if (!RENDERED.has(type)) {
    return (
      <div className="item unknown">
        <div className="tag">unrendered: {type}</div>
        <pre>{JSON.stringify(item, null, 2).slice(0, 1200)}</pre>
      </div>
    );
  }

  switch (item.type) {
    case "userMessage":
      return <UserMessage content={item.content} />;

    case "agentMessage": {
      const streamed = joinStream(streams?.agentMessage);
      const text = streamed || item.text;
      // Commentary is progress. It belongs in the Work
      // disclosure, never in the transcript as a final assistant response.
      // This fallback preserves that distinction when ItemView is used
      // without App's turn-level grouping (tests and isolated surfaces).
      if (item.phase === "commentary") {
        return (
          <Reasoning
            body={text}
            active={active || !turnCompleted}
            startedAtMs={startedAtMs}
            completedAtMs={completedAtMs}
          />
        );
      }
      // Agent output is Markdown; rendering it is most of the difference
      // between a readable transcript and a protocol dump.
      return (
        <div className="item agentMessage">
          <Markdown text={text} />
          {turnCompleted && (
            <AgentMessageActions
              copyText={text}
              onBranch={turnId && onBranch ? () => onBranch(turnId) : undefined}
            />
          )}
        </div>
      );
    }

    case "reasoning": {
      // Three independent streams upstream (raw text, summary text, summary
      // parts). We show summary when present and fall back to raw text —
      // merging them into one buffer would interleave unrelated blocks.
      const summary =
        joinStream(streams?.reasoningSummary) || item.summary.join("\n\n");
      const content =
        joinStream(streams?.reasoningText) || item.content.join("\n\n");
      const body = summary || content;
      // Headings with no prose are the residue of a resumed thread, and a
      // thinking operation that expands to nothing is worse than absent.
      // Live turns are unaffected: they stream the prose. See
      // `hasReasoningBody`.
      if (!active && !hasReasoningBody(body)) return null;
      return (
        <Reasoning
          body={body}
          active={active}
          startedAtMs={startedAtMs}
          completedAtMs={completedAtMs}
          nowMs={nowMs}
        />
      );
    }

    case "commandExecution": {
      const output =
        joinStream(streams?.commandOutput) || item.aggregatedOutput || "";
      return (
        <CommandItem
          command={item.command}
          cwd={item.cwd}
          status={String(item.status)}
          output={output}
          active={active}
          actions={item.commandActions}
          duration={
            lifecycleDuration ??
            (item.durationMs != null ? formatDuration(item.durationMs) : null)
          }
        />
      );
    }

    case "fileChange":
      return (
        <FileChangeItem
          changes={item.changes}
          status={String(item.status)}
          onOpenFile={onOpenFile}
          workspaceRoot={workspaceRoot}
          duration={lifecycleDuration}
        />
      );

    case "mcpToolCall": {
      // A `node_repl` call is a program the agent wrote, and it labels its
      // own programs — prefer that label over `node_repl · js`, which is
      // accurate and unreadable. See replCall.ts.
      const title = isReplCall(item.server) ? replTitle(item.arguments) : null;
      const source = title ? replSource(item.arguments) : null;
      return (
        <ToolCallItem
          label={title ?? `${item.server} · ${item.tool}`}
          status={String(item.status)}
          // The program itself is the detail, not the `{code, title}` wrapper.
          args={source ?? item.arguments}
          durationMs={item.durationMs}
          lifecycleDuration={lifecycleDuration}
          error={item.error?.message ?? null}
          result={item.result?.content ?? null}
          // The title already says what the program is for; previewing the
          // source underneath it is what made the visible trajectory unreadable.
          hideArgPreview={Boolean(title)}
        />
      );
    }

    case "dynamicToolCall":
      return (
        <ToolCallItem
          label={
            item.namespace ? `${item.namespace} · ${item.tool}` : item.tool
          }
          status={String(item.status)}
          args={item.arguments}
          durationMs={item.durationMs}
          lifecycleDuration={lifecycleDuration}
          // `success: false` is a failure the status field does not carry.
          error={item.success === false ? "The tool reported a failure." : null}
          result={item.contentItems ?? null}
        />
      );

    case "webSearch":
      return (
        <WebSearchRow
          query={item.query}
          action={item.action}
          duration={lifecycleDuration}
        />
      );

    case "imageGeneration":
      return (
        <ImageGenerationRow
          status={item.status}
          revisedPrompt={item.revisedPrompt}
          savedPath={item.savedPath ?? null}
          duration={lifecycleDuration}
        />
      );

    case "contextCompaction":
      // No fields beyond the id: the event *is* the information.
      return (
        <OpNote
          kind="context"
          title="Compacted the conversation"
          detail="earlier turns summarized"
          duration={lifecycleDuration}
        />
      );

    case "subAgentActivity":
      return (
        <OpNote
          status={item.kind === "interrupted" ? "failed" : "completed"}
          kind="agent"
          title={`Sub-agent ${SUB_AGENT_VERB[item.kind] ?? String(item.kind)}`}
          detail={shortCwd(item.agentPath)}
          duration={lifecycleDuration}
        />
      );

    case "imageView":
      // The temp path usually has a generated name, so keep it in the tooltip.
      return (
        <OpNote
          kind="image"
          title="Viewed an image"
          detail={shortCwd(item.path)}
          duration={lifecycleDuration}
        />
      );

    case "plan":
      // Distinct from `TurnPlan`/PlanStrip, which tracks steps. This is the
      // agent stating a plan as prose, and it is user-facing content — so the
      // body is always open rather than behind a toggle.
      return (
        <OpNote kind="plan" title="Plan" duration={lifecycleDuration}>
          <Markdown text={item.text} />
        </OpNote>
      );

    case "sleep":
      return (
        <OpNote
          kind="wait"
          title="Waited"
          duration={lifecycleDuration ?? formatDuration(item.durationMs)}
        />
      );

    case "hookPrompt":
      // A hook injected text into the prompt. The user did not type it, so it
      // is not a user message — but it changed what the agent was asked, so
      // hiding it makes the transcript a lie about its own input.
      return (
        <OpNote
          kind="context"
          title="Hook added context"
          duration={lifecycleDuration}
        >
          <div className="op-note-text">
            {item.fragments.map((f) => f.text).join("\n")}
          </div>
        </OpNote>
      );

    case "collabAgentToolCall":
      return (
        <OpNote
          status={opStatus(
            item.status === "inProgress" ? "running" : String(item.status),
          )}
          kind="agent"
          title={COLLAB_VERB[item.tool] ?? String(item.tool)}
          detail={
            item.receiverThreadIds.length > 0
              ? `${item.receiverThreadIds.length} agent${
                  item.receiverThreadIds.length === 1 ? "" : "s"
                }`
              : undefined
          }
          duration={lifecycleDuration}
        />
      );

    case "enteredReviewMode":
    case "exitedReviewMode":
      return (
        <OpNote
          kind="review"
          title={
            item.type === "enteredReviewMode"
              ? "Started review"
              : "Finished review"
          }
          detail={item.review ?? undefined}
          duration={lifecycleDuration}
        />
      );

    default:
      return null;
  }
}

/**
 * A user message: text runs plus whatever was attached to them.
 *
 * The previous rendering joined the content array into one string and wrote
 * `[localImage]` for anything that was not text, so a message with three
 * pasted screenshots showed three literal placeholders. Every non-text
 * variant of `UserInput` now renders as itself:
 *
 * - `localImage` is read back through the main process (attachments live
 *   outside the workspace, so `readFile` refuses them — see
 *   `LocalFileSystem.readImage`) and shown inline.
 * - `image` already carries a URL; it is used directly, but only for
 *   `http(s):` and `data:`, matching the scheme guard in `Markdown`.
 * - `skill` and `mention` are names, not blobs, so they render as chips.
 *
 * Text stays plain rather than being reinterpreted as Markdown. Attachments
 * use the same bubble as the message text so a sent prompt reads as one unit.
 */
function UserMessage({ content }: { content: UserInput[] }) {
  const text = content
    .filter((c): c is Extract<UserInput, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const images = content.filter(
    (c): c is Extract<UserInput, { type: "localImage" | "image" }> =>
      c.type === "localImage" ||
      (c.type === "image" && /^(https?:|data:image\/)/i.test(c.url)),
  );
  // Named references, not blobs — these belong with the text, not the strip.
  const refs = content.filter(
    (c): c is Extract<UserInput, { type: "skill" | "mention" }> =>
      c.type === "skill" || c.type === "mention",
  );

  return (
    <div className="usermsg">
      {(text || refs.length > 0 || images.length > 0) && (
        <div
          className={`item userMessage${images.length > 0 ? " has-attachments" : ""}`}
        >
          {images.length > 0 && (
            <div className="msg-thumbs">
              {images.map((c, i) =>
                c.type === "localImage" ? (
                  <LocalImage key={i} path={c.path} />
                ) : (
                  <img key={i} className="msg-thumb" src={c.url} alt="" />
                ),
              )}
            </div>
          )}
          {text && <div className="msgbody">{text}</div>}
          {refs.length > 0 && (
            <div className="msg-refs">
              {refs.map((c, i) => (
                <span key={i} className="msg-chip">
                  {c.type === "skill" ? "/" : "@"}
                  {c.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * An image the composer wrote to disk, loaded on demand.
 *
 * Loading is per-item rather than once for the transcript because a thread
 * resumed from the server can reference clipboard files that have since been
 * cleaned out of the temp directory. That is an expected outcome, not an
 * error, so a missing file degrades to a small placeholder instead of an
 * error card. Generated clipboard filenames stay in the tooltip because they
 * are not useful transcript content.
 */
function LocalImage({
  path,
  variant = "thumb",
}: {
  path: string;
  variant?: "thumb" | "generated";
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    setSrc(null);
    setMissing(false);
    void window.codexDesk.readImage(path).then((dataUrl) => {
      if (!live) return;
      if (dataUrl) setSrc(dataUrl);
      else setMissing(true);
    });
    return () => {
      live = false;
    };
  }, [path]);

  const name = path.split("/").pop() ?? path;
  const className = variant === "generated" ? "generated-image" : "msg-thumb";
  if (missing) {
    return (
      <span
        className={`${className} missing`}
        title={`${name} — no longer on disk`}
      >
        ⃠
      </span>
    );
  }
  if (!src) return <span className={`${className} loading`} />;
  return (
    <img
      className={className}
      src={src}
      alt={name}
      title={name}
      onClick={() => void window.codexDesk.openPath(path)}
    />
  );
}

/**
 * The plain text of a preamble item, from its live stream or its stored value.
 *
 * The first line is what the collapsed row shows. Markdown emphasis is
 * stripped rather than rendered because the row is a single ellipsized line —
 * a bold run inside it reads as a typo, not as emphasis.
 */
function preambleText(entry: ItemEntry, streams?: ItemStreams): string {
  if (entry.item.type === "agentMessage") {
    return joinStream(streams?.agentMessage) || entry.item.text;
  }
  return "";
}

/**
 * Split prose into the line that names it and the body under it.
 *
 * A reasoning summary is normally a bold heading followed by the thought, so
 * the heading becomes the operation title and the thought becomes its body.
 * Commentary that is a single paragraph splits into a heading and nothing,
 * which is the signal that it has no disclosure: the line *is* the item.
 *
 * The heading is stripped of Markdown rather than rendered, because it is one
 * ellipsized line; a bold run inside it reads as a typo, not as emphasis.
 */
function splitHeadingBody(text: string): { head: string; rest: string } {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index === -1) return { head: "", rest: "" };
  const head = lines[index]!.trim()
    .replace(/^#+\s*/, "")
    .replace(/\*\*|__|`/g, "");
  return {
    head,
    rest: lines
      .slice(index + 1)
      .join("\n")
      .trim(),
  };
}

/**
 * One turn's work: a header that sums it, and the sections it is made of.
 *
 * Collapsed is the resting state. Once a final response starts, everything
 * here settles to a single row — the answer is the summary, and the steps
 * that produced it are a receipt the reader can open rather than a wall they
 * have to scroll past. While the turn is live the card is open, because
 * watching it is the point.
 */
export function WorkDisclosure({
  entries,
  deltas,
  workComplete,
  turnComplete = workComplete,
  pendingRequests = [],
  durationMs,
  onOpenFile,
  workspaceRoot,
}: {
  entries: ItemEntry[];
  deltas: Record<string, Record<string, Record<number, string>>>;
  /** True once a final response starts, or the turn otherwise ends. */
  workComplete: boolean;
  /** True only once the owning turn reaches a terminal state. */
  turnComplete?: boolean;
  /** Requests that pause this turn until the user answers the composer dock. */
  pendingRequests?: PendingRequest[];
  /** Exact owning-turn duration, available for completed reloaded history. */
  durationMs?: number;
  onOpenFile?: (path: string) => void;
  workspaceRoot?: string;
}) {
  const active = !workComplete;
  const waiting = active && pendingRequests.length > 0;
  const [now, setNow] = useState(Date.now());
  const [manual, setManual] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  // A final response makes the default presentation settle to `Worked`, but
  // it does not override an explicit user expansion. The response can stream
  // for a while after it begins, so manual state clears only when the owning
  // turn actually reaches a terminal state.
  useEffect(() => {
    if (turnComplete) setManual(false);
  }, [turnComplete]);

  const starts = entries
    .map((entry) => entry.startedAtMs)
    .filter((value): value is number => value !== undefined);
  starts.push(
    ...pendingRequests.map(
      (request) => requestStartMs(request) ?? request.receivedAtMs,
    ),
  );
  const ends = entries
    .map((entry) => entry.completedAtMs)
    .filter((value): value is number => value !== undefined);
  const start = starts.length > 0 ? Math.min(...starts) : undefined;
  const end = active ? now : ends.length > 0 ? Math.max(...ends) : undefined;
  const duration =
    durationMs !== undefined
      ? formatDuration(durationMs)
      : start !== undefined && end !== undefined
        ? formatDuration(end - start)
        : null;
  const open = manual ?? active;

  const sections = buildWorkSections(entries);
  // What the header counts is steps taken, not items recorded: the preambles
  // are how the work is narrated, not part of it, so counting them would make
  // "14 steps" disagree with the fourteen rows underneath.
  const stepCount = sections.reduce((n, s) => n + s.steps.length, 0);

  return (
    <div
      className={`work${active ? " active" : ""}${waiting ? " waiting" : ""}${open ? " open" : ""}`}
    >
      <button
        className="work-head"
        aria-expanded={open}
        onClick={() => setManual(!open)}
      >
        {waiting ? (
          <span className="work-waiting-dot" aria-hidden="true" />
        ) : (
          active && <span className="work-spinner" aria-hidden="true" />
        )}
        <span className="work-verb">
          {waiting ? "Waiting on you" : active ? "Working" : "Worked"}
        </span>
        {stepCount > 0 && (
          <span className="work-steps">
            {stepCount} step{stepCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="work-tail">
          {duration && <span className="work-dur">{duration}</span>}
          <DisclosureChevron />
        </span>
      </button>
      {open && (
        <div className="work-body">
          {sections.map((section, index) => (
            <WorkSectionView
              key={section.id}
              section={section}
              deltas={deltas}
              turnActive={active}
              // While the turn runs, the section being worked on is the one
              // worth reading; the ones behind it have already been summarized
              // by the fact that they finished. Once the turn ends none is
              // privileged, so they all rest closed.
              live={active && index === sections.length - 1}
              nowMs={now}
              pendingRequests={
                index === sections.length - 1 ? pendingRequests : []
              }
              onOpenFile={onOpenFile}
              workspaceRoot={workspaceRoot}
            />
          ))}
          {sections.length === 0 && pendingRequests.length > 0 && (
            <div className="work-steps-list">
              {pendingRequests.map((request) => (
                <PendingRequestRow
                  key={String(request.requestId)}
                  request={request}
                  nowMs={now}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A preamble and the steps taken under it.
 *
 * The preamble is the heading: one line at rest, the full prose when opened.
 * Its steps hang off a left hairline, which is what makes a run of tool calls
 * read as belonging to the sentence above them rather than as a flat list.
 */
function WorkSectionView({
  section,
  deltas,
  turnActive,
  live,
  nowMs,
  pendingRequests,
  onOpenFile,
  workspaceRoot,
}: {
  section: WorkSection;
  deltas: Record<string, Record<string, Record<number, string>>>;
  turnActive: boolean;
  live: boolean;
  nowMs: number;
  pendingRequests: PendingRequest[];
  onOpenFile?: (path: string) => void;
  workspaceRoot?: string;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const preamble = section.preamble;
  const streams = preamble ? deltas[preamble.id] : undefined;
  const text = preamble ? preambleText(preamble, streams) : "";
  const { head, rest } = splitHeadingBody(text);
  // What a section discloses is the prose under its heading *and* the steps
  // it took. At rest it is one line summing both; the heading itself is
  // always on screen, so a section with neither offers no toggle at all —
  // which is what a resumed thread's heading-only reasoning becomes.
  const expandable =
    rest.length > 0 || section.steps.length > 0 || pendingRequests.length > 0;
  const open = manual ?? live;

  // A section spans its heading and every operation it introduced. Timing
  // only the preamble made this value freeze while its commands kept running.
  const sectionEntries = [preamble, ...section.steps].filter(
    (entry): entry is ItemEntry => entry !== null,
  );
  const sectionStarts = sectionEntries
    .map((entry) => entry.startedAtMs)
    .filter((value): value is number => value !== undefined);
  const sectionEnds = sectionEntries
    .map((entry) => entry.completedAtMs)
    .filter((value): value is number => value !== undefined);
  const duration = elapsedDuration(
    sectionStarts.length > 0 ? Math.min(...sectionStarts) : undefined,
    live
      ? undefined
      : sectionEnds.length > 0
        ? Math.max(...sectionEnds)
        : undefined,
    live ? nowMs : undefined,
  );

  const steps = section.steps.map((entry) => (
    <ItemView
      key={entry.id}
      item={entry.item}
      streams={deltas[entry.id]}
      active={
        turnActive &&
        entry.startedAtMs !== undefined &&
        entry.completedAtMs === undefined
      }
      startedAtMs={entry.startedAtMs}
      completedAtMs={entry.completedAtMs}
      nowMs={nowMs}
      onOpenFile={onOpenFile}
      workspaceRoot={workspaceRoot}
    />
  ));
  const pending = pendingRequests.map((request) => (
    <PendingRequestRow
      key={String(request.requestId)}
      request={request}
      nowMs={nowMs}
    />
  ));

  if (!preamble || !head) {
    // Work with nothing introducing it still needs the indent, so a turn that
    // opened with a tool call does not have its first rows sitting further
    // left than every row after them.
    return (
      <div className="work-steps-list">
        {steps}
        {pending}
      </div>
    );
  }

  return (
    <div className={`work-section${live ? " live" : ""}${open ? " open" : ""}`}>
      {expandable ? (
        <button
          className="work-preamble"
          aria-expanded={open}
          onClick={() => setManual(!open)}
        >
          <span className="work-preamble-text">{head}</span>
          <span className="work-tail">
            {duration && <span className="work-dur">{duration}</span>}
            <DisclosureChevron />
          </span>
        </button>
      ) : (
        <div className="work-preamble static">
          <span className="work-preamble-text">{head}</span>
          <span className="work-tail">
            {duration && <span className="work-dur">{duration}</span>}
          </span>
        </div>
      )}
      {open && rest.length > 0 && (
        <div className="work-preamble-body">
          <Markdown text={rest} />
        </div>
      )}
      {open && (steps.length > 0 || pending.length > 0) && (
        <div className="work-steps-list">
          {steps}
          {pending}
        </div>
      )}
    </div>
  );
}

/** The paused operation that connects the trajectory to the request dock. */
function PendingRequestRow({
  request,
  nowMs,
}: {
  request: PendingRequest;
  nowMs: number;
}) {
  const startedAtMs = requestStartMs(request) ?? request.receivedAtMs;
  const duration = formatDuration(Math.max(0, nowMs - startedAtMs));
  const summary = pendingRequestSummary(request);

  return (
    <OpRow
      status="waiting"
      kind="approval"
      title={summary.title}
      detail={summary.detail}
      duration={duration}
    />
  );
}

function requestStartMs(request: PendingRequest): number | undefined {
  return "startedAtMs" in request.params
    ? request.params.startedAtMs
    : undefined;
}

function pendingRequestSummary(request: PendingRequest): {
  title: string;
  detail?: string;
} {
  switch (request.kind) {
    case "commandApproval":
      return {
        title: "Waiting on approval",
        detail:
          request.params.command ?? request.params.reason ?? "shell command",
      };
    case "fileChangeApproval":
      return {
        title: "Waiting on file approval",
        detail:
          request.params.reason ?? request.params.grantRoot ?? "file changes",
      };
    case "permissions":
      return {
        title: "Waiting on permission",
        detail: request.params.reason ?? request.params.cwd,
      };
    case "userInput":
      return {
        title: "Waiting on your answer",
        detail: `${request.params.questions.length} question${
          request.params.questions.length === 1 ? "" : "s"
        }`,
      };
    case "elicitation":
      return {
        title: "Waiting on MCP input",
        detail: request.params.serverName,
      };
  }
}

type ActionState = "idle" | "working" | "done" | "error";

/**
 * Keep response actions in the message flow, but visually quiet until
 * the response is hovered or keyboard-focused. Copy uses source Markdown;
 * Branch is anchored to the response's owning turn rather than its row index.
 */
function AgentMessageActions({
  copyText,
  onBranch,
}: {
  copyText: string;
  onBranch?: () => Promise<string | null>;
}) {
  const [copyState, setCopyState] = useState<ActionState>("idle");
  const [branchState, setBranchState] = useState<ActionState>("idle");

  useEffect(() => {
    if (copyState !== "done" && copyState !== "error") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1_800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (branchState !== "error") return;
    const timer = window.setTimeout(() => setBranchState("idle"), 1_800);
    return () => window.clearTimeout(timer);
  }, [branchState]);

  const copyLabel =
    copyState === "done"
      ? "Copied"
      : copyState === "error"
        ? "Couldn't copy"
        : "Copy";
  const branchLabel =
    branchState === "error"
      ? "Couldn't continue in new chat"
      : "Continue in new chat";

  return (
    <div className="agent-message-actions">
      <button
        className="agent-message-action"
        type="button"
        title={copyLabel}
        aria-label={copyLabel}
        onClick={async () => {
          setCopyState("working");
          try {
            await navigator.clipboard.writeText(copyText);
            setCopyState("done");
          } catch {
            setCopyState("error");
          }
        }}
      >
        {copyState === "done" ? <CheckIcon /> : <CopyIcon />}
      </button>
      {onBranch && (
        <button
          className="agent-message-action"
          type="button"
          title={branchLabel}
          aria-label="Continue in new chat from here"
          aria-busy={branchState === "working" || undefined}
          disabled={branchState === "working"}
          onClick={async () => {
            setBranchState("working");
            try {
              const forked = await onBranch();
              setBranchState(forked ? "done" : "error");
            } catch {
              setBranchState("error");
            }
          }}
        >
          <BranchIcon />
        </button>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "done"
          ? "Response copied"
          : copyState === "error"
            ? "Response could not be copied"
            : branchState === "error"
              ? "Could not continue in a new chat"
              : ""}
      </span>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.25" />
      <path d="M10.75 5.25V4.5c0-.69-.56-1.25-1.25-1.25h-5A1.25 1.25 0 0 0 3.25 4.5v5c0 .69.56 1.25 1.25 1.25h.75" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.25 2.75 2.75 6.25-6.25" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.25" />
      <circle cx="12" cy="4.5" r="1.25" />
      <circle cx="4" cy="12.5" r="1.25" />
      <path d="M4 4.75v6.5M5.25 8h2.5A4.25 4.25 0 0 0 12 5.75" />
    </svg>
  );
}

const SUB_AGENT_VERB: Record<string, string> = {
  started: "started",
  interacted: "reported back",
  interrupted: "was interrupted",
};

/** `CollabAgentTool` reads as an API name; these are what it means. */
const COLLAB_VERB: Record<string, string> = {
  spawnAgent: "Started an agent",
  sendInput: "Sent input to an agent",
  resumeAgent: "Resumed an agent",
  wait: "Waited for an agent",
  closeAgent: "Closed an agent",
};

/** Compact JSON for a tool's arguments — one line unless it is genuinely big. */
function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  try {
    const text = JSON.stringify(args);
    if (!text || text === "{}" || text === "null") return "";
    return text;
  } catch {
    return "";
  }
}

/**
 * MCP and dynamic tool calls (§8.4).
 *
 * `mcpToolCall` and `dynamicToolCall` are close enough in shape to share this.
 * Both are work, not narration, so they follow command execution's treatment:
 * one-line summary that says who did what, with the payload behind a toggle.
 * A tool call that dumps its whole JSON result inline turns the transcript
 * back into the protocol debugger the review complained about.
 */
function ToolCallItem({
  label,
  status,
  args,
  durationMs,
  lifecycleDuration,
  error,
  result,
  hideArgPreview = false,
}: {
  label: string;
  status: string;
  args: unknown;
  durationMs: number | null;
  lifecycleDuration?: string | null;
  error: string | null;
  result: unknown[] | null;
  /**
   * Suppress the collapsed one-line argument preview.
   *
   * A generic MCP call's arguments are a small object worth previewing. A
   * `node_repl` call's are a whole program, and the label above it already
   * says what the program is for — so the preview is several lines of source
   * per row, which is what turned the newly-visible trajectory back into a
   * wall of text. Keep the collapsed label concise.
   */
  hideArgPreview?: boolean;
}) {
  const argText = summarizeArgs(args);
  const failed = status === "failed" || Boolean(error);
  const hasBody = Boolean(argText) || Boolean(result && result.length > 0);

  return (
    <OpRow
      status={opStatus(status, failed)}
      kind="tool"
      title={label}
      // The collapsed preview is the arguments, unless the label already
      // stands for them — a `node_repl` row would otherwise carry a whole
      // program on its detail line. See `hideArgPreview`.
      detail={hideArgPreview ? undefined : argText || undefined}
      duration={
        lifecycleDuration ??
        (durationMs != null ? formatDuration(durationMs) : null)
      }
      // A failure is not a detail. It stays on screen whether or not the row
      // is open, because an error you have to go looking for is one you find
      // after you have already been misled by the transcript.
      after={error ? <div className="op-error">{error}</div> : undefined}
      body={
        hasBody ? (
          <>
            {argText && (
              <>
                <div className="op-body-label">arguments</div>
                <pre className="output">{pretty(args)}</pre>
              </>
            )}
            {result && result.length > 0 && (
              <>
                <div className="op-body-label">result</div>
                <pre className="output">{pretty(result)}</pre>
              </>
            )}
          </>
        ) : undefined
      }
    />
  );
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * A web search (§8.4).
 *
 * `action` is a union — `search` carries `query`/`queries`, `openPage` a URL,
 * `findInPage` both. The top-level `query` is always present, so it is the
 * fallback when the action is `other` or absent.
 */
function WebSearchRow({
  query,
  action,
  duration,
}: {
  query: string;
  duration?: string | null;
  action:
    | { type: "search"; query: string | null; queries: string[] | null }
    | { type: "openPage"; url: string | null }
    | { type: "findInPage"; url: string | null; pattern: string | null }
    | { type: "other" }
    | null;
}) {
  let detail = query;
  if (action?.type === "search") {
    detail = action.queries?.join(", ") || action.query || query;
  } else if (action?.type === "openPage") {
    detail = action.url ?? query;
  } else if (action?.type === "findInPage") {
    detail = [action.pattern, action.url].filter(Boolean).join(" in ") || query;
  }

  return (
    <OpNote
      kind="search"
      title={action?.type === "openPage" ? "Opened a page" : "Searched the web"}
      detail={detail}
      duration={duration}
    />
  );
}

/** A generated image (§8.4). `savedPath` is optional — it may still be
 * in flight, in which case only the status is worth showing. */
function ImageGenerationRow({
  status,
  revisedPrompt,
  savedPath,
  duration,
}: {
  status: string;
  revisedPrompt: string | null;
  savedPath: string | null;
  duration?: string | null;
}) {
  return (
    <OpNote
      status={opStatus(status)}
      kind="image"
      title="Generated an image"
      detail={savedPath ? shortCwd(savedPath) : undefined}
      duration={duration}
    >
      {revisedPrompt && <div className="op-note-text">{revisedPrompt}</div>}
      {savedPath && <LocalImage path={savedPath} variant="generated" />}
    </OpNote>
  );
}

/**
 * Reasoning is an operation within the current preamble-headed section.
 *
 * Its summary heading is the operation title and its prose is the disclosed
 * body. Treating that title as a section preamble fragmented one narrated run
 * into several false sections; using the same operation grammar as commands
 * keeps the hierarchy honest while preserving every word.
 *
 * The app-server supplies lifecycle timestamps, so the duration survives
 * re-renders and tells the truth even if a virtualized row leaves the screen.
 */
function Reasoning({
  body,
  active,
  startedAtMs,
  completedAtMs,
  nowMs,
}: {
  body: string;
  active: boolean;
  startedAtMs?: number;
  completedAtMs?: number;
  nowMs?: number;
}) {
  const [localNow, setLocalNow] = useState(Date.now());

  useEffect(() => {
    // WorkDisclosure supplies one shared clock. Isolated ItemViews still need
    // a local clock so their live duration does not freeze.
    if (nowMs !== undefined) return;
    if (!active) return;
    const t = setInterval(() => setLocalNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, nowMs]);

  const duration = elapsedDuration(
    startedAtMs,
    completedAtMs,
    active ? (nowMs ?? localNow) : undefined,
  );
  const { head, rest } = splitHeadingBody(body);

  return (
    <OpRow
      status={active ? "running" : "completed"}
      kind="reasoning"
      title={head || "Thinking"}
      duration={duration}
      body={rest ? <Markdown text={rest} /> : undefined}
      defaultOpen={active}
      reopenOn={active}
    />
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return "<1s";
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function elapsedDuration(
  startedAtMs: number | undefined,
  completedAtMs: number | undefined,
  liveNowMs: number | undefined,
): string | null {
  const end = completedAtMs ?? liveNowMs;
  return startedAtMs !== undefined && end !== undefined
    ? formatDuration(Math.max(0, end - startedAtMs))
    : null;
}

/** The three states any step can be in. Everything else is a variation. */
type OpStatus = "completed" | "failed" | "running" | "waiting";

type OpKind =
  | "reasoning"
  | "read"
  | "search"
  | "list"
  | "edit"
  | "command"
  | "tool"
  | "image"
  | "plan"
  | "wait"
  | "agent"
  | "context"
  | "review"
  | "approval";

function opStatus(status: string, failed = false): OpStatus {
  if (failed || status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "running";
}

/** The semantic operation mark; status is conveyed through its color and row. */
function OpMark({ status, kind }: { status: OpStatus; kind: OpKind }) {
  return (
    <span
      className={`op-mark op-icon ${status}`}
      data-operation-icon={kind}
      aria-hidden="true"
    >
      <OperationIcon kind={kind} />
    </span>
  );
}

/** Semantic operation marks from the trajectory mockup, kept on one stroke
 * system so a dense receipt scans as a set rather than a collection of emoji. */
function OperationIcon({ kind }: { kind: OpKind }) {
  switch (kind) {
    case "reasoning":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a6 6 0 0 0-3.5 10.9c.4.3.5.8.5 1.1v1h6v-1c0-.3.1-.8.5-1.1A6 6 0 0 0 12 2Z" />
        </svg>
      );
    case "read":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M16 13H8M16 17H8" />
        </svg>
      );
    case "search":
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "list":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      );
    case "edit":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M21.2 5.5 18.5 2.8a2 2 0 0 0-2.8 0L4 14.5V20h5.5L21.2 8.3a2 2 0 0 0 0-2.8Z" />
        </svg>
      );
    case "tool":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L20 16.4a2.5 2.5 0 1 1-3.6 3.6l-7.7-7.7" />
        </svg>
      );
    case "image":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9" r="1.5" />
          <path d="m21 15-5-5L5 20" />
        </svg>
      );
    case "plan":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="m3.5 6 .8.8L6 5M3.5 12l.8.8L6 11M3.5 18l.8.8L6 17" />
        </svg>
      );
    case "wait":
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 8v8M14.5 8v8" />
        </svg>
      );
    case "agent":
      return (
        <svg viewBox="0 0 24 24">
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="8" r="2" />
          <circle cx="8" cy="18" r="2" />
          <path d="m7.7 7 8.6.7M7 7.8l.7 8.3" />
        </svg>
      );
    case "context":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M4 7h11M4 12h16M4 17h9" />
          <path d="m16 5 3 2-3 2" />
        </svg>
      );
    case "review":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="m8 12 2.5 2.5L16 9" />
        </svg>
      );
    case "approval":
      return (
        <svg viewBox="0 0 24 24">
          <path d="M12 3 19 6v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6Z" />
          <path d="M12 9v3M12 15h.01" />
        </svg>
      );
    case "command":
    default:
      return (
        <svg viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h4" />
        </svg>
      );
  }
}

function DisclosureChevron() {
  return <span className="op-chevron" aria-hidden="true" />;
}

function OpTail({
  duration,
  disclosure,
}: {
  duration?: string | null;
  disclosure: boolean;
}) {
  if (!duration && !disclosure) return null;
  return (
    <span className="op-tail">
      {duration ? <span className="op-dur">{duration}</span> : null}
      {disclosure ? <DisclosureChevron /> : null}
    </span>
  );
}

/**
 * One step in a turn's work — the row the whole transcript is built from.
 *
 * Three grid slots on one baseline: a semantic icon in a fixed 14px column,
 * the flexible title/detail line, and a fixed duration/disclosure tail. The
 * detail is what ellipsizes because it is the part a reader scans rather than
 * reads; a truncated title would cost the row its meaning.
 *
 * With a `body` the row is a button that discloses it. Without one it is a
 * plain div and draws no chevron — a control that does nothing is worse than
 * no control, and several item types (a sleep, a compaction) genuinely have
 * nothing behind them.
 */
function OpRow({
  status,
  kind = "command",
  title,
  detail,
  duration,
  body,
  after,
  defaultOpen = false,
  reopenOn,
}: {
  status: OpStatus;
  kind?: OpKind;
  title: React.ReactNode;
  detail?: React.ReactNode;
  duration?: string | null;
  body?: React.ReactNode;
  /**
   * Content that stays visible whether or not the row is open.
   *
   * A failure is the case this exists for: an error behind a disclosure is an
   * error the reader has to already suspect in order to find. Anything that
   * changes what the row *means* belongs here rather than in `body`.
   */
  after?: React.ReactNode;
  defaultOpen?: boolean;
  /**
   * Re-apply `defaultOpen` when this value changes.
   *
   * A running command is expanded so its output can be watched, and collapses
   * when it finishes. That is a change of presentation state driven by the
   * item's lifecycle, not by the user, so it has to survive the initial mount
   * — hence a signal rather than a plain initial value.
   */
  reopenOn?: unknown;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (reopenOn === undefined) return;
    setOpen(defaultOpen);
  }, [reopenOn, defaultOpen]);

  const line = (
    <>
      <OpMark status={status} kind={kind} />
      <span className="op-line">
        <span className="op-title">{title}</span>
        {detail ? <span className="op-detail">{detail}</span> : null}
      </span>
      <OpTail duration={duration} disclosure={Boolean(body)} />
    </>
  );

  if (!body) {
    return (
      <div className={`op-row ${status}`}>
        <div className="op-head static">{line}</div>
        {after && <div className="op-body always">{after}</div>}
      </div>
    );
  }

  return (
    <div className={`op-row ${status}${open ? " open" : ""}`}>
      <button
        className="op-head"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        {line}
      </button>
      {after && <div className="op-body always">{after}</div>}
      {open && <div className="op-body">{body}</div>}
    </div>
  );
}

/**
 * A row whose body is the point.
 *
 * A plan or an injected hook prompt is prose the user is meant to read;
 * putting it behind a toggle that starts closed hides the only thing the item
 * carries. So these draw the same row grammar with the body always under it
 * and no chevron at all.
 */
function OpNote({
  status = "completed",
  kind = "command",
  title,
  detail,
  duration,
  children,
}: {
  status?: OpStatus;
  kind?: OpKind;
  title: React.ReactNode;
  detail?: React.ReactNode;
  duration?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className={`op-row ${status}`}>
      <div className="op-head static">
        <OpMark status={status} kind={kind} />
        <span className="op-line">
          <span className="op-title">{title}</span>
          {detail ? <span className="op-detail">{detail}</span> : null}
        </span>
        <OpTail duration={duration} disclosure={false} />
      </div>
      {children ? <div className="op-body always">{children}</div> : null}
    </div>
  );
}

/** Long output is the common case; show the tail and let it expand. */
/**
 * What a command *did*, from the protocol's own parse of it.
 *
 * `commandExecution.commandActions` is a best-effort structural reading of
 * the shell line — `read` with a file name, `listFiles`, `search` with a
 * query — and we were ignoring it in favour of showing the raw command. That
 * distinguishes file and search actions from a wall of raw shell commands.
 *
 * A skill read reaches the client the same way: it is a command summarized by
 * intent, whether or not the renderer has a separate skill concept.
 *
 * Returns null when the parse says nothing useful, leaving the raw command.
 */
function summarizeActions(actions: CommandAction[]): string | null {
  if (actions.length === 0) return null;

  const named = (a: Extract<CommandAction, { type: "read" }>) =>
    a.name || a.path.split("/").pop() || a.path;

  const reads = actions.filter(
    (a): a is Extract<CommandAction, { type: "read" }> => a.type === "read",
  );
  // A skill definition is a read of SKILL.md; name the skill, not the
  // file, since every skill's file has the same name.
  const skills = reads.filter((a) => /(^|\/)skill\.md$/i.test(a.path));
  if (skills.length > 0 && skills.length === reads.length) {
    const names = skills.map((a) => skillNameOf(a.path));
    return names.length === 1
      ? `Read ${names[0]} skill`
      : `Read ${names.length} skills`;
  }

  const searches = actions.filter(
    (a): a is Extract<CommandAction, { type: "search" }> => a.type === "search",
  );
  const lists = actions.filter((a) => a.type === "listFiles");
  const unknown = actions.filter((a) => a.type === "unknown");

  // One action of one kind names its subject; anything mixed stays generic.
  // Naming every subject in a mixed batch produces a header longer than the
  // disclosure it labels, so those fall back to the verb list built below.
  if (actions.length === 1) {
    if (reads.length === 1) return `Read ${named(reads[0]!)}`;
    if (searches.length === 1) {
      const q = searches[0]!.query;
      return q ? `Searched for ${q}` : "Searched";
    }
    if (lists.length === 1) return "Listed files";
    return null;
  }

  const parts: string[] = [];
  if (reads.length > 0) parts.push("Read files");
  if (searches.length > 0) parts.push("searched");
  if (lists.length > 0) parts.push("listed files");
  if (unknown.length > 0) {
    parts.push(unknown.length === 1 ? "ran a command" : "ran commands");
  }
  if (parts.length === 0) return null;
  const joined = parts.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** `.../skills/control-in-app-browser/SKILL.md` -> `Control In App Browser`. */
function skillNameOf(path: string): string {
  const dir = path.split("/").slice(-2)[0] ?? "";
  if (!dir) return "a";
  return dir
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A shell command.
 *
 * The title is what the command *meant* (`summarizeActions` reading the
 * protocol's own parse of it) and the mono detail is the line itself, so the
 * row reads as a sentence with the evidence beside it. Expanding shows the
 * full command and its output — the detail is elided to one line, and a
 * command long enough to be truncated is exactly the one worth opening.
 */
function CommandItem({
  command,
  cwd,
  status,
  output,
  active,
  actions = [],
  duration,
}: {
  command: string;
  cwd: string;
  status: string;
  output: string;
  active: boolean;
  actions?: CommandAction[];
  duration?: string | null;
}) {
  const summary = summarizeActions(actions);
  const failed = status === "failed";

  return (
    <OpRow
      status={opStatus(status)}
      kind={commandOperationKind(command, actions)}
      title={
        failed
          ? "Command failed"
          : (summary ?? (active ? "Running command" : "Ran a command"))
      }
      detail={summarizeCommand(command)}
      duration={duration}
      // The currently running command earns screen space; a finished one is
      // audit trail, not story, and settles back to its single line.
      defaultOpen={active}
      reopenOn={active}
      body={
        <>
          <pre className="cmd">
            <span className="prompt">$</span> {command}
            <span className="cmd-cwd">{shortCwd(cwd)}</span>
          </pre>
          {output && <pre className="output">{output}</pre>}
        </>
      }
    />
  );
}

function commandOperationKind(
  command: string,
  actions: CommandAction[],
): OpKind {
  const kinds = new Set(actions.map((action) => action.type));
  if (kinds.size === 1) {
    if (kinds.has("read")) return "read";
    if (kinds.has("search")) return "search";
    if (kinds.has("listFiles")) return "list";
  }

  // Older stored trajectories predate commandActions. Keep their icons
  // useful by recognizing the small set of commands that maps cleanly to the
  // same semantic verbs; anything ambiguous remains a terminal command.
  const executable = command
    .trim()
    .replace(/^(?:sudo\s+)?/, "")
    .split(/\s+/)[0]
    ?.split("/")
    .pop()
    ?.toLowerCase();
  if (
    ["cat", "head", "tail", "less", "sed", "wc"].includes(executable ?? "")
  ) {
    return "read";
  }
  if (["rg", "grep", "find", "fd"].includes(executable ?? "")) {
    return "search";
  }
  if (["ls", "tree"].includes(executable ?? "")) return "list";
  if (executable === "apply_patch") return "edit";
  return "command";
}

/**
 * The changes a patch made, one row per file.
 *
 * The previous rendering said "edited 3 files" and hid the names behind a
 * toggle, which is the one fact the reader already knew. A file the agent
 * touched is the most consequential thing in a turn, so each gets its own
 * row: what happened to it, its path, and how much moved.
 *
 * `kind` and `diff` were being dropped on the floor — `item.changes` was
 * mapped to bare paths. Both come straight from `FileUpdateChange`, so the
 * add/edit/move/delete verb and the +/− counts are read, not invented.
 */
function FileChangeItem({
  changes,
  status,
  onOpenFile,
  workspaceRoot,
  duration,
}: {
  changes: FileUpdateChange[];
  status: string;
  onOpenFile?: (path: string) => void;
  workspaceRoot?: string;
  duration?: string | null;
}) {
  return (
    <div className="op-group">
      {changes.map((change) => (
        <FileChangeRow
          key={change.path}
          change={change}
          status={status}
          onOpenFile={onOpenFile}
          workspaceRoot={workspaceRoot}
          duration={duration}
        />
      ))}
    </div>
  );
}

function FileChangeRow({
  change,
  status,
  onOpenFile,
  workspaceRoot,
  duration,
}: {
  change: FileUpdateChange;
  status: string;
  onOpenFile?: (path: string) => void;
  workspaceRoot?: string;
  duration?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const stat = diffStat(change.diff);
  const move = change.kind.type === "update" ? change.kind.move_path : null;
  const failed = status === "failed";
  const shown = displayPath(change.path, workspaceRoot);
  const expandable = change.diff.trim().length > 0;

  const line = (
    <>
      <OpMark status={opStatus(status)} kind="edit" />
      <span className="fc-kind">{changeVerb(change.kind, move)}</span>
      <span
        className={`fc-path${failed ? " failed" : ""}`}
        onClick={
          onOpenFile
            ? (event) => {
                // The row's own disclosure is the default action; opening
                // the file is a second one on the same line, so it must not
                // also toggle the diff underneath it.
                event.stopPropagation();
                onOpenFile(change.path);
              }
            : undefined
        }
        title={change.path}
      >
        <span className="fc-dir">{dirOf(shown)}</span>
        <span className="fc-name">
          {baseOf(shown)}
          {move ? ` → ${baseOf(move)}` : ""}
        </span>
      </span>
      {stat.added > 0 || stat.removed > 0 ? (
        <span className="fc-stat">
          {stat.added > 0 && <span className="added">+{stat.added}</span>}
          {stat.removed > 0 && <span className="removed">−{stat.removed}</span>}
        </span>
      ) : (
        <span className="fc-stat" />
      )}
      <OpTail duration={duration} disclosure={expandable} />
    </>
  );

  return (
    <div
      className={`op-row filechange ${opStatus(status)}${expandable && open ? " open" : ""}`}
    >
      {expandable ? (
        <button
          className="op-head"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          {line}
        </button>
      ) : (
        <div className="op-head static">{line}</div>
      )}
      {expandable && open && (
        <div className="op-body">
          <DiffBlock diff={change.diff} />
        </div>
      )}
    </div>
  );
}

/** `update` covers both an edit in place and a rename; only the path says which. */
function changeVerb(kind: PatchChangeKind, move: string | null): string {
  if (kind.type === "add") return "add";
  if (kind.type === "delete") return "delete";
  return move ? "move" : "edit";
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut + 1);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Drop the workspace prefix from a path for display.
 *
 * The protocol sends absolute paths. Drawn in full they are mostly the same
 * forty characters on every row — `/Users/…/CodexDesk/` repeated down the
 * column — and since the directory is what gives up width first, the part
 * that ellipsizes is the part that actually differs between two rows. The
 * absolute path stays on the element's `title` and is what gets opened.
 */
export function displayPath(path: string, root?: string): string {
  if (!root) return path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Count changed lines in a unified diff.
 *
 * `+++`/`---` are the file headers, not content, so they are skipped before
 * the leading character is read. Everything else is a context or hunk line.
 */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * A unified diff, coloured by line.
 *
 * This is the one place green appears in the app, and it means "added" — not
 * "succeeded". Hunk headers are dimmed rather than coloured: they locate the
 * change without being part of it.
 */
function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split("\n").map((line, i) => {
        const kind =
          line.startsWith("+++") || line.startsWith("---")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "added"
                : line.startsWith("-")
                  ? "removed"
                  : "context";
        return (
          <span className={`diff-line ${kind}`} key={i}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function summarizeCommand(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > 86 ? `${compact.slice(0, 83)}…` : compact;
}
