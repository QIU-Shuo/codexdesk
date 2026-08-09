import type { WebSearchMode } from "../../../contracts/views/capabilities";

const WEB_SEARCH_MODES: readonly WebSearchMode[] = [
  "disabled",
  "cached",
  "indexed",
  "live",
];

export function isWebSearchMode(value: unknown): value is WebSearchMode {
  return (
    typeof value === "string" &&
    WEB_SEARCH_MODES.some((candidate) => candidate === value)
  );
}

export function permittedWebSearchModes(
  allowed: WebSearchMode[] | null,
): WebSearchMode[] {
  if (!allowed || allowed.length === 0) return [...WEB_SEARCH_MODES];
  return WEB_SEARCH_MODES.filter((mode) => allowed.includes(mode));
}

