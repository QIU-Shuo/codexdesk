export type ReviewSide = "before" | "after";

export type ReviewContext = {
  before: string[];
  selected: string[];
  after: string[];
};

export type ReviewAnchor = {
  path: string;
  side: ReviewSide;
  span: { start: number; end: number };
  contextDigest: string;
  context: ReviewContext;
  baseRevision: string | null;
};

export type ReviewLocation = {
  path: string;
  side: ReviewSide;
  span: { start: number; end: number };
  sectionId: string;
};

export type ReviewDocumentLine = {
  number: number;
  text: string;
};

export type ReviewDocumentSection = {
  id: string;
  lines: ReviewDocumentLine[];
};

export type ReviewDocumentFile = {
  path: string;
  previousPath: string | null;
  before: ReviewDocumentSection[];
  after: ReviewDocumentSection[];
};

export type ReviewDocument = {
  files: ReviewDocumentFile[];
};

/** Stable content fingerprint; identity only, not a security boundary. */
export function digestReviewContext(context: ReviewContext): string {
  const source = JSON.stringify(context);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
