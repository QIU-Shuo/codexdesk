export type ExternalFileFamily =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "audio"
  | "video"
  | "pdf"
  | "unknown";

export type FilePresentationView =
  | { mode: "text"; language: string | null; size: number }
  | { mode: "image"; mediaType: string; size: number }
  | {
      mode: "external";
      family: ExternalFileFamily;
      mediaType: string | null;
      size: number;
    };

export type FileEntryView = {
  path: string;
  name: string;
  kind: "file" | "directory";
  presentation: FilePresentationView | null;
};

export type FileReadView =
  | {
      kind: "text";
      presentation: Extract<FilePresentationView, { mode: "text" }>;
      text: string;
      truncatedAt?: number;
    }
  | {
      kind: "image";
      presentation: Extract<FilePresentationView, { mode: "image" }>;
      dataUrl: string;
    }
  | {
      kind: "external";
      presentation: Extract<FilePresentationView, { mode: "external" }>;
    }
  | { kind: "tooLarge"; size: number; limit: number }
  | {
      kind: "error";
      cause:
        | "notFound"
        | "permission"
        | "isDirectory"
        | "outsideWorkspace"
        | "unknown";
      detail: string;
    };
