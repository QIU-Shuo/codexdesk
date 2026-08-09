import type { ReviewAnchor, ReviewLocation } from "./ReviewAnchor";

export type ReviewAsset =
  | { kind: "path"; path: string }
  | { kind: "image"; path: string; mediaType: string };

export type ReviewResolution = "located" | "moved" | "ambiguous" | "missing";

export type ReviewNote = {
  id: string;
  originConversationId: string;
  anchor: ReviewAnchor;
  body: string;
  assets: ReviewAsset[];
  resolution: ReviewResolution;
  currentLocation: ReviewLocation | null;
  createdAt: number;
};

export type ReviewNoteDraft = {
  path: string;
  side: ReviewAnchor["side"];
  span: { start: number; end: number };
  body: string;
};
