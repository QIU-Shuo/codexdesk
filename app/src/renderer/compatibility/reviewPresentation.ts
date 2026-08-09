/**
 * Temporary current-UI projection.
 *
 * Delete this adapter when the independent UI-redesign milestone renders
 * review-note contracts directly.
 */
import type { ReviewNoteView } from "../../contracts/views/review";

export type CurrentReviewComment = {
  commentId: string;
  filePath: string;
  side: "left" | "right";
  startLine: number;
  endLine: number;
  hunkId: string;
  commentText: string;
  quotedLines: string[];
  stale: boolean;
  createdAtMs: number;
};

export function presentReviewNotes(
  notes: ReviewNoteView[],
): CurrentReviewComment[] {
  return notes.map((note) => {
    const location = note.currentLocation ?? note.anchor;
    return {
      commentId: note.id,
      filePath: location.path,
      side: note.anchor.side === "before" ? "left" : "right",
      startLine: location.span.start,
      endLine: location.span.end,
      hunkId: note.currentLocation?.sectionId ?? "",
      commentText: note.body,
      quotedLines: [...note.anchor.context.selected],
      stale: note.resolution === "ambiguous" || note.resolution === "missing",
      createdAtMs: note.createdAt,
    };
  });
}
