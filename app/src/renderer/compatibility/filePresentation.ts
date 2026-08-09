/**
 * Temporary current-UI projection. Delete when the file-tree/viewer redesign
 * renders FileEntryView and FileReadView directly.
 */
import type {
  ExternalFileFamily,
  FileEntryView,
  FileReadView,
} from "../../contracts/views/files";

export type CurrentFileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export type CurrentFileContents =
  | {
      kind: "text";
      text: string;
      language: string;
      bytes: number;
      truncated?: { limit: number };
    }
  | { kind: "image"; dataUrl: string; mediaType: string; bytes: number }
  | { kind: "external"; family: ExternalFileFamily; bytes: number }
  | { kind: "tooLarge"; bytes: number; limit: number }
  | {
      kind: "error";
      reason: Extract<FileReadView, { kind: "error" }>["cause"];
      message: string;
    };

/** Remove when the file viewer consumes FileReadView directly. */
export function presentFileRead(file: FileReadView): CurrentFileContents {
  switch (file.kind) {
    case "text":
      return {
        kind: "text",
        text: file.text,
        language: file.presentation.language ?? "text",
        bytes: file.presentation.size,
        ...(file.truncatedAt ? { truncated: { limit: file.truncatedAt } } : {}),
      };
    case "image":
      return {
        kind: "image",
        dataUrl: file.dataUrl,
        mediaType: file.presentation.mediaType,
        bytes: file.presentation.size,
      };
    case "external":
      return {
        kind: "external",
        family: file.presentation.family,
        bytes: file.presentation.size,
      };
    case "tooLarge":
      return { kind: "tooLarge", bytes: file.size, limit: file.limit };
    case "error":
      return { kind: "error", reason: file.cause, message: file.detail };
  }
}

export function presentFileEntries(
  entries: FileEntryView[],
): CurrentFileEntry[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    isDirectory: entry.kind === "directory",
  }));
}

/** Renderer-only path suffix extraction for file-list icons. */
export function extensionForIcon(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const cut = base.lastIndexOf(".");
  return cut <= 0 ? "" : base.slice(cut + 1).toLowerCase();
}
