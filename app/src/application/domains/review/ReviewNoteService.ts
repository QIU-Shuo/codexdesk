import {
  digestReviewContext,
  type ReviewAnchor,
  type ReviewContext,
  type ReviewDocument,
  type ReviewDocumentFile,
  type ReviewDocumentSection,
  type ReviewLocation,
} from "./ReviewAnchor";
import type { ReviewNote, ReviewNoteDraft } from "./ReviewNote";

type Candidate = ReviewLocation & { contextScore: number };

function sectionsFor(
  file: ReviewDocumentFile,
  side: ReviewAnchor["side"],
): ReviewDocumentSection[] {
  return side === "before" ? file.before : file.after;
}

function findFile(
  document: ReviewDocument,
  path: string,
): ReviewDocumentFile | undefined {
  return document.files.find(
    (file) => file.path === path || file.previousPath === path,
  );
}

function matchingSuffix(expected: string[], actual: string[]): number {
  let score = 0;
  while (
    score < expected.length &&
    score < actual.length &&
    expected[expected.length - 1 - score] === actual[actual.length - 1 - score]
  ) {
    score += 1;
  }
  return score;
}

function matchingPrefix(expected: string[], actual: string[]): number {
  let score = 0;
  while (
    score < expected.length &&
    score < actual.length &&
    expected[score] === actual[score]
  ) {
    score += 1;
  }
  return score;
}

function contextAt(
  section: ReviewDocumentSection,
  index: number,
  count: number,
): ReviewContext {
  return {
    before: section.lines
      .slice(Math.max(0, index - 2), index)
      .map((line) => line.text),
    selected: section.lines
      .slice(index, index + count)
      .map((line) => line.text),
    after: section.lines
      .slice(index + count, index + count + 2)
      .map((line) => line.text),
  };
}

function candidatesFor(
  note: ReviewNote,
  document: ReviewDocument,
): Candidate[] {
  const file = findFile(document, note.anchor.path);
  const selected = note.anchor.context.selected;
  if (!file || selected.length === 0) return [];

  const candidates: Candidate[] = [];
  for (const section of sectionsFor(file, note.anchor.side)) {
    for (
      let index = 0;
      index + selected.length <= section.lines.length;
      index += 1
    ) {
      const context = contextAt(section, index, selected.length);
      if (
        !context.selected.every((line, offset) => line === selected[offset])
      ) {
        continue;
      }
      const first = section.lines[index];
      const last = section.lines[index + selected.length - 1];
      if (!first || !last) continue;
      const sameOriginalLocation =
        file.path === note.anchor.path &&
        first.number === note.anchor.span.start &&
        last.number === note.anchor.span.end;
      candidates.push({
        path: file.path,
        side: note.anchor.side,
        span: { start: first.number, end: last.number },
        sectionId: section.id,
        contextScore:
          matchingSuffix(note.anchor.context.before, context.before) +
          matchingPrefix(note.anchor.context.after, context.after) +
          (sameOriginalLocation ? 1000 : 0),
      });
    }
  }
  return candidates;
}

export class ReviewNoteService {
  constructor(
    private readonly createId: () => string,
    private readonly now: () => number,
  ) {}

  create(
    document: ReviewDocument,
    originConversationId: string,
    draft: ReviewNoteDraft,
    baseRevision: string | null,
  ): ReviewNote | null {
    const file = findFile(document, draft.path);
    if (!file) return null;
    const start = Math.min(draft.span.start, draft.span.end);
    const end = Math.max(draft.span.start, draft.span.end);
    for (const section of sectionsFor(file, draft.side)) {
      const index = section.lines.findIndex((line) => line.number === start);
      if (index < 0) continue;
      const count = end - start + 1;
      const context = contextAt(section, index, count);
      const last = section.lines[index + count - 1];
      if (context.selected.length !== count || last?.number !== end) continue;
      const currentLocation: ReviewLocation = {
        path: file.path,
        side: draft.side,
        span: { start, end },
        sectionId: section.id,
      };
      return {
        id: this.createId(),
        originConversationId,
        anchor: {
          path: draft.path,
          side: draft.side,
          span: { start, end },
          contextDigest: digestReviewContext(context),
          context,
          baseRevision,
        },
        body: draft.body,
        assets: [],
        resolution: "located",
        currentLocation,
        createdAt: this.now(),
      };
    }
    return null;
  }

  relocate(notes: ReviewNote[], document: ReviewDocument): ReviewNote[] {
    return notes.map((note) => {
      const candidates = candidatesFor(note, document);
      if (candidates.length === 0) {
        return { ...note, resolution: "missing", currentLocation: null };
      }
      const bestScore = Math.max(
        ...candidates.map((item) => item.contextScore),
      );
      const best = candidates.filter((item) => item.contextScore === bestScore);
      if (best.length !== 1) {
        return { ...note, resolution: "ambiguous", currentLocation: null };
      }
      const { contextScore: _score, ...location } = best[0]!;
      const resolution =
        location.path === note.anchor.path &&
        location.span.start === note.anchor.span.start &&
        location.span.end === note.anchor.span.end
          ? "located"
          : "moved";
      return { ...note, resolution, currentLocation: location };
    });
  }

  compose(notes: ReviewNote[], preamble: string): string {
    if (notes.length === 0) return preamble.trim();
    const byFile = new Map<string, ReviewNote[]>();
    for (const note of notes) {
      const path = note.currentLocation?.path ?? note.anchor.path;
      const list = byFile.get(path) ?? [];
      list.push(note);
      byFile.set(path, list);
    }

    const parts: string[] = [];
    if (preamble.trim()) parts.push(preamble.trim());
    parts.push(
      notes.length === 1
        ? "I left one review note:"
        : `I left ${notes.length} review notes:`,
    );
    for (const [path, fileNotes] of byFile) {
      parts.push(`\n**${path}**`);
      for (const note of fileNotes.sort(
        (a, b) =>
          (a.currentLocation?.span.start ?? a.anchor.span.start) -
          (b.currentLocation?.span.start ?? b.anchor.span.start),
      )) {
        const location = note.currentLocation ?? note.anchor;
        const range =
          location.span.start === location.span.end
            ? `line ${location.span.start}`
            : `lines ${location.span.start}-${location.span.end}`;
        const side = note.anchor.side === "before" ? " (before)" : "";
        const status =
          note.resolution === "ambiguous"
            ? " — location is ambiguous after the diff changed"
            : note.resolution === "missing"
              ? " — referenced content is no longer in the diff"
              : note.resolution === "moved"
                ? " — content moved after this note was written"
                : "";
        parts.push(`\n${range}${side}${status}:`);
        if (note.anchor.context.selected.length > 0) {
          parts.push("```");
          parts.push(note.anchor.context.selected.join("\n"));
          parts.push("```");
        }
        parts.push(note.body.trim());
      }
    }
    return parts.join("\n");
  }
}
