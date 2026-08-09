import type { ReviewNoteView } from "../../../contracts/views/review";
import type { ReviewNote } from "./ReviewNote";

export function reviewNoteView(note: ReviewNote): ReviewNoteView {
  return {
    id: note.id,
    originConversationId: note.originConversationId,
    anchor: {
      ...note.anchor,
      span: { ...note.anchor.span },
      context: {
        before: [...note.anchor.context.before],
        selected: [...note.anchor.context.selected],
        after: [...note.anchor.context.after],
      },
    },
    body: note.body,
    assets: note.assets.map((asset) => ({ ...asset })),
    resolution: note.resolution,
    currentLocation: note.currentLocation
      ? { ...note.currentLocation, span: { ...note.currentLocation.span } }
      : null,
    createdAt: note.createdAt,
  };
}
