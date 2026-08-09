/**
 * A readable label for a `node_repl` tool call.
 *
 * A `node_repl` call may run a small program containing several operations, so
 * its technical tool name is not a useful transcript label. The arguments may
 * carry a model-authored `title`; prefer that declared metadata over parsing
 * source code to infer intent.
 */

/** True when this item is a `node_repl` program rather than a real MCP tool. */
export function isReplCall(server: string): boolean {
  return server === "node_repl";
}

/**
 * The agent's own one-line description of a `node_repl` call, if it wrote one.
 *
 * Returns null rather than a placeholder so the caller can fall back to the
 * generic `server · tool` label — an empty row would be worse than an honest
 * technical one.
 */
export function replTitle(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const title = (args as Record<string, unknown>).title;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  // Model-authored, so it is untrusted length as well as untrusted content.
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

/** The program source, for the details disclosure. */
export function replSource(args: unknown): string | null {
  if (typeof args === "string") return args;
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["code", "input", "source", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
