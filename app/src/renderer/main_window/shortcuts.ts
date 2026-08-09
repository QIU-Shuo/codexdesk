import { useEffect, useMemo, useRef } from "react";

/**
 * Keyboard shortcuts as data (plan §6, 4.8).
 *
 * Every shortcut is a row with a stable id, and handlers are looked up by id
 * rather than scattered as hard-coded key comparisons. This keeps a future
 * user-configurable binding source isolated from component behavior.
 */
export type ShortcutId =
  | "newThread"
  | "interrupt"
  | "toggleTerminal"
  | "toggleFiles"
  | "focusComposer"
  | "filterThreads"
  | "openFolder"
  | "searchFiles"
  | "nextThread"
  | "prevThread";

export type Binding = {
  id: ShortcutId;
  keys: string; // e.g. "Mod+K" — "Mod" is Cmd on macOS, Ctrl elsewhere
  label: string;
};

export const DEFAULT_BINDINGS: Binding[] = [
  { id: "newThread", keys: "Mod+N", label: "New thread" },
  { id: "interrupt", keys: "Escape", label: "Interrupt turn" },
  { id: "toggleTerminal", keys: "Mod+`", label: "Toggle terminal" },
  { id: "toggleFiles", keys: "Mod+B", label: "Toggle file tree" },
  { id: "focusComposer", keys: "Mod+L", label: "Focus composer" },
  { id: "filterThreads", keys: "Mod+K", label: "Search chats" },
  { id: "openFolder", keys: "Mod+O", label: "Open folder" },
  { id: "searchFiles", keys: "Mod+P", label: "Search files" },
  { id: "nextThread", keys: "Mod+Alt+ArrowDown", label: "Next thread" },
  { id: "prevThread", keys: "Mod+Alt+ArrowUp", label: "Previous thread" },
];

/** Canonical string for a keyboard event, comparable to `Binding.keys`. */
export function eventToKeys(e: KeyboardEvent): string {
  const parts: string[] = [];
  // Treat Cmd (macOS) and Ctrl (elsewhere) as the same modifier so one
  // binding table works on every platform.
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // A bare modifier press is not a shortcut.
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return "";
  parts.push(key);
  return parts.join("+");
}

export type Handlers = Partial<Record<ShortcutId, () => void>>;

/**
 * Bind the table to the window.
 *
 * Typing in a field must not trigger single-key shortcuts, but a modified
 * chord (Mod+N) still should — otherwise the shortcuts stop working the
 * moment the composer has focus, which is most of the time.
 */
export function useShortcuts(bindings: Binding[], handlers: Handlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const table = useMemo(() => {
    const map = new Map<string, ShortcutId>();
    for (const b of bindings) map.set(b.keys, b.id);
    return map;
  }, [bindings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys = eventToKeys(e);
      if (!keys) return;
      const id = table.get(keys);
      if (!id) return;

      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      const hasModifier = keys.includes("Mod") || keys.includes("Alt");
      // Escape is the exception: it must work while typing, since that is
      // exactly when you want to interrupt.
      if (typing && !hasModifier && keys !== "Escape") return;

      const fn = handlersRef.current[id];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [table]);
}
