import type { PendingRequest, ThreadItemEntry } from "../../shared/ipc";

export type ItemEntry = Extract<ThreadItemEntry, { kind: "item" }>;

/**
 * Whether a reasoning body is worth showing at all.
 *
 * A reasoning summary block normally looks like a bold heading followed by a
 * paragraph. **On a resumed thread the paragraphs are gone** — app-server
 * persists the headings alone, so a turn that streamed a dozen thoughts
 * reloads as a dozen bare titles ("Planning parallel TypeScript checks",
 * "Investigating workspace project consistency") with nothing under them.
 * That is a list of chapter names with no chapters: it takes more vertical
 * space than the trace it sits in and says less.
 *
 * So the rule is *has a body*, not *is reasoning*. A live turn streams the
 * prose and keeps rendering normally; only the hollowed-out remains after a
 * reload are dropped. Tool rows are untouched — they are the trajectory, and
 * they are what the user is actually reading.
 */
export function hasReasoningBody(text: string): boolean {
  if (!text.trim()) return false;
  // Strip every leading `**heading**` line, then see whether prose remains.
  const rest = text
    .split("\n")
    .filter((line) => !/^\s*(\*\*|##+\s).*?(\*\*)?\s*$/.test(line.trim()))
    .join("")
    .trim();
  return rest.length > 0;
}

export type TranscriptRow =
  | ThreadItemEntry
  | {
      kind: "work";
      id: string;
      turnId: string;
      entries: ItemEntry[];
      /** Server requests that currently pause this turn for the user. */
      pendingRequests?: PendingRequest[];
      /** Exact owning-turn duration when app-server supplied it. */
      durationMs?: number;
    };

/**
 * Treat commentary as progress, not as a final assistant response. Group a
 * turn's collapsible work into one disclosure, leaving only the final answer
 * in the main transcript.
 *
 * `phase: null` deliberately remains outside the group: providers do not all
 * emit phases, and the generated type requires compatibility behavior for
 * those legacy messages.
 */
export function buildTranscriptRows(
  entries: ThreadItemEntry[],
  /**
   * Live delta buffers, keyed by item id.
   *
   * Required for correctness, not decoration: a reasoning item's stored
   * `summary` is empty until the item completes, so filtering on the stored
   * value alone would drop every thought *while it is being streamed* and pop
   * it back in at the end. An item with buffered deltas is live and always
   * kept.
   */
  deltas: Record<string, unknown> = {},
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const workByTurn = new Map<
    string,
    Extract<TranscriptRow, { kind: "work" }>
  >();

  const workFor = (turnId: string) => {
    let work = workByTurn.get(turnId);
    if (!work) {
      work = {
        kind: "work",
        id: `work:${turnId}`,
        turnId,
        entries: [],
        pendingRequests: [],
      };
      workByTurn.set(turnId, work);
      rows.push(work);
    }
    return work;
  };

  for (const entry of entries) {
    // Drop hollowed-out reasoning before grouping, not while rendering: an
    // empty item still creates the `work` row it belongs to, so a resumed
    // turn whose only collapsible content was heading-only reasoning would
    // otherwise show a `Worked` disclosure that expands to nothing.
    if (entry.kind === "item" && entry.item.type === "reasoning") {
      const streaming = deltas[entry.id] !== undefined;
      const body =
        entry.item.summary.join("\n\n") || entry.item.content.join("\n\n");
      if (!streaming && !hasReasoningBody(body)) continue;
    }

    // A request is not a third kind of transcript speaker. It is the point
    // where Codex's current turn pauses for the user, so attach it to that
    // turn's work receipt. This also creates a receipt when approval arrives
    // before the first ordinary item: otherwise the dock appears above the
    // composer while the trajectory above it is completely blank.
    if (entry.kind === "request") {
      const correlatedTurn = entry.request.params.turnId;
      const turnId =
        correlatedTurn ?? `request:${String(entry.request.requestId)}`;
      workFor(turnId).pendingRequests!.push(entry.request);
      continue;
    }

    if (entry.kind !== "item" || !isCollapsibleWork(entry)) {
      rows.push(entry);
      continue;
    }

    const work = workFor(entry.turnId);
    work.entries.push(entry);
    if (entry.turnDurationMs !== undefined) {
      work.durationMs = entry.turnDurationMs;
    }
  }

  return rows;
}

/**
 * Who a transcript row is attributed to.
 *
 * `null` is not a third speaker — it is a row that belongs to no one, like a
 * reconnect notice. Those keep the alignment column but leave its label
 * empty, so nothing in the transcript ever appears to have been said by the
 * app itself.
 */
export type Speaker = "user" | "codex" | null;

export function speakerOf(row: TranscriptRow): Speaker {
  if (row.kind === "work") return "codex";
  if (row.kind !== "item") {
    // Approval requests are addressed *to* the user but are not theirs, and a
    // review is the agent's output. Both read as Codex's side of the thread.
    return row.kind === "request" || row.kind === "review" ? "codex" : null;
  }
  return row.item.type === "userMessage" ? "user" : "codex";
}

/**
 * Whether this row should draw the speaker's name.
 *
 * The turn shell is an alignment column, and the label belongs at the top of
 * a run rather than on every row in it — repeating "Codex" down six
 * consecutive rows is noise, and the column is what carries the attribution
 * once the name has been established.
 *
 * This is a function of the row *before* it rather than a flag baked into the
 * row, because the transcript is virtualized: rows render independently and
 * by index, so there is no parent that could hold the run.
 */
export function startsSpeakerRun(
  rows: TranscriptRow[],
  index: number,
): boolean {
  const speaker = speakerOf(rows[index]!);
  if (speaker === null) return false;
  const previous = rows[index - 1];
  return previous === undefined || speakerOf(previous) !== speaker;
}

/**
 * The last independently-virtualized row belonging to one speaker.
 *
 * The design groups a Codex work receipt and its final answer with an 11px
 * internal gap, then leaves 17px before the next speaker. Virtualization means
 * there is no shared DOM parent on which to express that rhythm, so each row
 * needs to know whether it closes the run.
 */
export function endsSpeakerRun(
  rows: TranscriptRow[],
  index: number,
): boolean {
  const speaker = speakerOf(rows[index]!);
  if (speaker === null) return true;
  const next = rows[index + 1];
  return next === undefined || speakerOf(next) !== speaker;
}

/**
 * One preamble and the operations performed under it.
 *
 * The unit the transcript is built from. A turn is not a flat list of tool
 * calls — the agent says what it is about to do, does it, then says the next
 * thing — so the commentary that introduces a run of work is the heading for
 * that run, and the steps nest beneath it. A turn that ran tools without
 * narrating them first produces a section with a `null` preamble, which
 * renders as the operations alone. Reasoning is one of those operations: it
 * explains work within a section, but it does not create the section.
 */
export type WorkSection = {
  id: string;
  /** The commentary that heads this run, if there was one. */
  preamble: ItemEntry | null;
  steps: ItemEntry[];
};

/** Items that introduce a run of work rather than being work themselves. */
function isPreamble(entry: ItemEntry): boolean {
  return (
    entry.item.type === "agentMessage" && entry.item.phase === "commentary"
  );
}

/**
 * Split a turn's work into preamble-headed sections.
 *
 * Only commentary opens a section. A reasoning item is an operation inside
 * the current section, just like a command or tool call; using its summary as
 * a section heading incorrectly lets model thinking fragment the trajectory.
 * Consecutive commentary still creates consecutive sections, because both
 * messages are user-visible narration the model actually produced.
 */
export function buildWorkSections(entries: ItemEntry[]): WorkSection[] {
  const sections: WorkSection[] = [];

  for (const entry of entries) {
    if (isPreamble(entry)) {
      sections.push({ id: entry.id, preamble: entry, steps: [] });
      continue;
    }

    const last = sections[sections.length - 1];
    if (!last) {
      // Work with nothing introducing it — a turn that went straight to a
      // tool call. The section exists to hold the steps; it has no heading.
      sections.push({
        id: `steps:${entry.id}`,
        preamble: null,
        steps: [entry],
      });
      continue;
    }
    last.steps.push(entry);
  }

  return sections;
}

function isCollapsibleWork(entry: ItemEntry): boolean {
  switch (entry.item.type) {
    case "agentMessage":
      return entry.item.phase === "commentary";
    case "reasoning":
    case "commandExecution":
    // A patch is a step, not a result.
    //
    // This used to stay in the main transcript on the grounds that a file
    // change is a user-visible outcome rather than progress. That reasoning
    // does not survive a real turn: an agent editing one file twenty times
    // produced twenty full-width rows outside the disclosure, so the turn's
    // trajectory collapsed to a tidy card and its loudest, most repetitive
    // part stayed behind. The changed files are still reachable — they are
    // steps in the section that made them, and the Changes pane is where a
    // turn's net effect is meant to be read.
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
    case "imageGeneration":
    case "contextCompaction":
    case "subAgentActivity":
    // These are execution-progress rows and belong under the same work group.
    case "imageView":
    case "sleep":
    case "hookPrompt":
    case "collabAgentToolCall":
      return true;
    // `plan` and the review-mode markers stay in the main transcript: a plan
    // is prose the user is meant to read, and entering review changes what
    // the whole turn means, so burying it inside a collapsed group hides the
    // frame around everything below it.
    default:
      // Deliberately *not* `true`. An item type we do not know about is the
      // §9.1 failure case, and the `unrendered:` placeholder only helps if it
      // is somewhere the user can see it — putting an unknown item inside a
      // group that is collapsed by default is indistinguishable from dropping
      // it. New protocol variants surface in the transcript until we decide
      // where they belong.
      return false;
  }
}
