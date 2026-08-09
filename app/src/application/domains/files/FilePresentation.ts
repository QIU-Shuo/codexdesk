import type {
  ExternalFileFamily,
  FilePresentationView,
} from "../../../contracts/views/files";

type ExternalMapping = {
  family: ExternalFileFamily;
  mediaType: string;
};

/**
 * Media types follow the IANA registry; byte signatures follow the WHATWG MIME
 * Sniffing Standard. Extension mappings are only hints after conservative
 * signature/binary checks, never proof that arbitrary bytes are renderable.
 *
 * Sources:
 * - https://www.iana.org/assignments/media-types/media-types.xhtml
 * - https://mimesniff.spec.whatwg.org/
 */
const EXTERNAL_BY_EXTENSION: Record<string, ExternalMapping> = {
  zip: { family: "archive", mediaType: "application/zip" },
  tar: { family: "archive", mediaType: "application/x-tar" },
  gz: { family: "archive", mediaType: "application/gzip" },
  tgz: { family: "archive", mediaType: "application/gzip" },
  bz2: { family: "archive", mediaType: "application/x-bzip2" },
  xz: { family: "archive", mediaType: "application/x-xz" },
  rar: { family: "archive", mediaType: "application/vnd.rar" },
  "7z": { family: "archive", mediaType: "application/x-7z-compressed" },
  mp3: { family: "audio", mediaType: "audio/mpeg" },
  wav: { family: "audio", mediaType: "audio/wav" },
  flac: { family: "audio", mediaType: "audio/flac" },
  aac: { family: "audio", mediaType: "audio/aac" },
  ogg: { family: "audio", mediaType: "audio/ogg" },
  m4a: { family: "audio", mediaType: "audio/mp4" },
  mp4: { family: "video", mediaType: "video/mp4" },
  mov: { family: "video", mediaType: "video/quicktime" },
  avi: { family: "video", mediaType: "video/x-msvideo" },
  mkv: { family: "video", mediaType: "video/x-matroska" },
  webm: { family: "video", mediaType: "video/webm" },
  doc: { family: "document", mediaType: "application/msword" },
  docx: {
    family: "document",
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  rtf: { family: "document", mediaType: "application/rtf" },
  pages: {
    family: "document",
    mediaType: "application/vnd.apple.pages",
  },
  odt: {
    family: "document",
    mediaType: "application/vnd.oasis.opendocument.text",
  },
  xls: { family: "spreadsheet", mediaType: "application/vnd.ms-excel" },
  xlsx: {
    family: "spreadsheet",
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  numbers: {
    family: "spreadsheet",
    mediaType: "application/vnd.apple.numbers",
  },
  ods: {
    family: "spreadsheet",
    mediaType: "application/vnd.oasis.opendocument.spreadsheet",
  },
  ppt: {
    family: "presentation",
    mediaType: "application/vnd.ms-powerpoint",
  },
  pptx: {
    family: "presentation",
    mediaType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  key: {
    family: "presentation",
    mediaType: "application/vnd.apple.keynote",
  },
  odp: {
    family: "presentation",
    mediaType: "application/vnd.oasis.opendocument.presentation",
  },
  pdf: { family: "pdf", mediaType: "application/pdf" },
};

const IMAGE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** Classify renderability without deciding syntax highlighting. */
export function classifyFilePresentation(
  file: string,
  size: number,
  prefix: Uint8Array,
): FilePresentationView {
  const ext = extensionOf(file);
  const sniffed = sniffMediaType(prefix);

  if (sniffed?.startsWith("image/")) {
    return { mode: "image", mediaType: sniffed, size };
  }
  if (sniffed === "application/pdf") {
    return { mode: "external", family: "pdf", mediaType: sniffed, size };
  }

  const external = EXTERNAL_BY_EXTENSION[ext];
  if (external) return { mode: "external", ...external, size };

  const imageHint = IMAGE_BY_EXTENSION[ext];
  if (imageHint && looksLikeSvg(prefix)) {
    return { mode: "image", mediaType: imageHint, size };
  }

  if (isLikelyBinary(prefix) || imageHint) {
    return {
      mode: "external",
      family: "unknown",
      mediaType: imageHint ?? sniffed,
      size,
    };
  }

  return { mode: "text", language: null, size };
}

export function extensionOf(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const cut = base.lastIndexOf(".");
  return cut <= 0 ? "" : base.slice(cut + 1).toLowerCase();
}

export function imageMediaTypeFor(file: string): string | null {
  return IMAGE_BY_EXTENSION[extensionOf(file)] ?? null;
}

/** Syntax language detection is deliberately separate from renderability. */
export function detectLanguage(file: string, text: string): string {
  const normalized = file.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const byName = BY_FILENAME_LANGUAGE[base];
  if (byName) return byName;

  const byExtension = BY_EXTENSION_LANGUAGE[extensionOf(file)];
  if (byExtension) return byExtension;

  const firstLine = text.slice(0, 200).split("\n", 1)[0] ?? "";
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
  if (shebang) {
    const first = basename(shebang[1]!);
    const interpreter =
      first === "env" && shebang[2] ? basename(shebang[2]) : first;
    const normalizedInterpreter = interpreter.replace(/[\d.]+$/, "");
    const language =
      BY_INTERPRETER[interpreter] ??
      BY_INTERPRETER[normalizedInterpreter] ??
      null;
    if (language) return language;
  }

  return "text";
}

export function isLikelyBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

function sniffMediaType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return "image/gif";
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  return /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(head);
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

const BY_EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  vim: "viml",
  dockerfile: "dockerfile",
  make: "make",
  diff: "diff",
  patch: "diff",
};

const BY_FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".bazelrc": "shellscript",
};

const BY_INTERPRETER: Record<string, string> = {
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  node: "javascript",
  python: "python",
  python3: "python",
  ruby: "ruby",
  perl: "perl",
};
