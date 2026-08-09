/**
 * Read a CodexDesk renderer preference and migrate the pre-rename key once.
 *
 * Renderer preferences live in localStorage, so changing the product
 * namespace without this bridge would reset theme, pane geometry, sidebar
 * state, file wrapping, and prompt-capture drafts for existing installs.
 */
export function readProductStorage(key: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;

  // This is intentionally the only old product namespace in renderer code.
  const legacyKey = key.replace(/^codexdesk(?=[.:])/, "occo");
  if (legacyKey === key) return null;

  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return null;

  localStorage.setItem(key, legacy);
  localStorage.removeItem(legacyKey);
  return legacy;
}
