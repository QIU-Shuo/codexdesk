import { useCallback, useEffect, useState } from "react";
import { readProductStorage } from "./productStorage";

/**
 * Theme resolution.
 *
 * The Aperture palettes live in `index.css` under `:root` (dark) and
 * `:root[data-theme="light"]`. Nothing there reads `prefers-color-scheme` —
 * this module resolves the preference to a concrete attribute instead.
 *
 * That indirection buys two things. The stylesheet holds each palette exactly
 * once, where a media-query approach would need the light values duplicated
 * (once under `@media`, once under an explicit override) and the two copies
 * would drift. And "follow the system" becomes a real, inspectable state
 * rather than the absence of one, so a settings control can offer three
 * choices without the CSS needing to know that.
 */

/** What the user asked for. `system` is the default and follows the OS. */
export type ThemePreference = "system" | "dark" | "light";

/** What actually gets painted, after `system` is resolved. */
export type ResolvedTheme = "dark" | "light";

/**
 * Where the preference is persisted.
 *
 * `localStorage`, matching `usePersistedLayout` in `panels.tsx`: renderer view
 * state with no other consumer. Routing it through IPC would mean a store
 * schema change and a round-trip for one string.
 */
const THEME_KEY = "codexdesk.theme";

const QUERY = "(prefers-color-scheme: light)";

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light";
}

export function loadThemePreference(): ThemePreference {
  try {
    const raw = readProductStorage(THEME_KEY);
    return isPreference(raw) ? raw : "system";
  } catch {
    // Private-mode or a disabled store: dark is the app's default anyway.
    return "system";
  }
}

function storeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_KEY, preference);
  } catch {
    // A preference that fails to persist is not worth breaking the app over.
  }
}

/**
 * `matchMedia` is absent in jsdom, so every read goes through here. Tests
 * render against the dark default rather than throwing on construction.
 */
function prefersLight(): boolean {
  return globalThis.matchMedia?.(QUERY).matches ?? false;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return prefersLight() ? "light" : "dark";
  return preference;
}

/**
 * Write the resolved theme to `<html>`.
 *
 * Dark is the default palette, so it is the *absence* of the attribute rather
 * than `data-theme="dark"`. That keeps the selector in `index.css` to a single
 * override block instead of one per theme.
 */
function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

/**
 * Apply the stored preference once, before React mounts.
 *
 * Called from `main.tsx` rather than from a component effect: an effect runs
 * after the first paint, which on a light-themed machine means a frame of
 * near-black canvas before it flips. Returns a teardown for the system
 * listener, which only does anything when the preference is `system`.
 */
export function startThemeSync(): () => void {
  const preference = loadThemePreference();
  applyResolvedTheme(resolveTheme(preference));

  const media = globalThis.matchMedia?.(QUERY);
  if (!media) return () => {};

  const onSystemChange = () => {
    // Re-read rather than closing over the value: `useTheme` may have written
    // a new preference since boot, and this listener outlives that write.
    const current = loadThemePreference();
    if (current === "system") applyResolvedTheme(resolveTheme(current));
  };

  media.addEventListener("change", onSystemChange);
  return () => media.removeEventListener("change", onSystemChange);
}

/**
 * Read and change the theme from the UI.
 *
 * There is no theme control drawn in the mockups yet — the redesign moves
 * settings to five tabs (General, Skills, Plugins, MCP servers, Web search)
 * and this belongs in General. The hook exists so that surface has something
 * to bind to, and so the preference is testable without one.
 */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(loadThemePreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(preference),
  );

  const setPreference = useCallback((next: ThemePreference) => {
    storeThemePreference(next);
    setPreferenceState(next);
    const theme = resolveTheme(next);
    setResolved(theme);
    applyResolvedTheme(theme);
  }, []);

  // Keep `resolved` truthful while the preference is `system` and the OS
  // flips. `startThemeSync` already repaints the attribute; this mirrors it
  // into React state so a settings control can show which theme is in effect.
  useEffect(() => {
    if (preference !== "system") return;
    const media = globalThis.matchMedia?.(QUERY);
    if (!media) return;
    const onChange = () => setResolved(prefersLight() ? "light" : "dark");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  return { preference, resolved, setPreference };
}
