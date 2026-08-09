import type { ReviewDocument } from "../../application/domains/review/ReviewAnchor";
import type { DiffSide, ParsedDiff } from "./diff";

function sections(file: ParsedDiff["files"][number], side: DiffSide) {
  const key = side === "left" ? "leftLine" : "rightLine";
  return file.hunks.map((hunk) => ({
    id: hunk.hunkId,
    lines: hunk.lines.flatMap((line) => {
      const number = line[key];
      return number === null ? [] : [{ number, text: line.text }];
    }),
  }));
}

export function reviewDocumentFromDiff(diff: ParsedDiff): ReviewDocument {
  return {
    files: diff.files.map((file) => ({
      path: file.path,
      previousPath: file.oldPath,
      before: sections(file, "left"),
      after: sections(file, "right"),
    })),
  };
}
