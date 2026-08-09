export type ReviewAnchorView = {
  path: string;
  side: "before" | "after";
  span: { start: number; end: number };
  contextDigest: string;
  context: {
    before: string[];
    selected: string[];
    after: string[];
  };
  baseRevision: string | null;
};

export type ReviewLocationView = {
  path: string;
  side: ReviewAnchorView["side"];
  span: { start: number; end: number };
  sectionId: string;
};

export type ReviewAssetView =
  | { kind: "path"; path: string }
  | { kind: "image"; path: string; mediaType: string };

export type ReviewNoteView = {
  id: string;
  originConversationId: string;
  anchor: ReviewAnchorView;
  body: string;
  assets: ReviewAssetView[];
  resolution: "located" | "moved" | "ambiguous" | "missing";
  currentLocation: ReviewLocationView | null;
  createdAt: number;
};
