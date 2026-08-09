import { useEffect, useId, useMemo, useState } from "react";
import type {
  CapabilitiesState,
  ConfigState,
  FuzzyFileSearchResult,
} from "../../shared/ipc";

/** The three entry points share one visual grammar but not one catalog. */
export type ComposerPickerMode = "add" | "mention" | "command";

export type MentionPick =
  | { kind: "attachment" }
  | { kind: "file"; path: string }
  | { kind: "skill"; name: string; prompt: string | null }
  | { kind: "plugin"; name: string; prompt: string | null }
  | { kind: "command"; command: "review" | "compact" };

type Entry = {
  id: string;
  section?: { label: string; shown: number; total: number };
  remaining?: number;
  label: string;
  detail: string;
  icon: "attachment" | "file" | "skill" | "plugin" | "command";
  pick: MentionPick;
};

const MAX_ADD_FILES = 3;
const MAX_MENTION_FILES = 6;
const MAX_COMMANDS = 2;
const MAX_ADD_CAPABILITIES = 2;
const MAX_MENTION_CAPABILITIES = 4;

const COMMANDS: Array<{
  command: "review" | "compact";
  detail: string;
}> = [
  { command: "review", detail: "review the working tree" },
  { command: "compact", detail: "shrink the context" },
];

function PickerIcon({ kind }: { kind: Entry["icon"] }) {
  if (kind === "attachment") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5h16v14H4zM7 15l3-3 2 2 2-2 3 3M16.5 8.5h.01" />
      </svg>
    );
  }
  if (kind === "command" || kind === "skill") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 17 10 7M13 7h7M13 12h7M13 17h7" />
      </svg>
    );
  }
  if (kind === "plugin") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22v-5M9 8V2M15 8V2M18 8v3a6 6 0 0 1-12 0V8Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M10 12.5 8 15l2 2.5M14 12.5l2 2.5-2 2.5" />
    </svg>
  );
}

function sectionEntries(
  label: string,
  entries: Entry[],
  total: number,
  showRemaining = false,
): Entry[] {
  return entries.map((entry, index) => ({
    ...entry,
    section: index === 0 ? { label, shown: entries.length, total } : undefined,
    remaining:
      showRemaining && index === entries.length - 1
        ? Math.max(0, total - entries.length)
        : 0,
  }));
}

function fileContext(file: FuzzyFileSearchResult): string {
  const relative = file.path.startsWith(`${file.root}/`)
    ? file.path.slice(file.root.length + 1)
    : file.path;
  const parent = relative.split("/").filter(Boolean).slice(0, -1).at(-1);
  return parent ?? ".";
}

/**
 * Composer autocomplete from the repository mockups.
 *
 * - `@` is a true mention catalog: files, skills and plugins only.
 * - `/` is a command catalog: commands only.
 * - the + button is the union, plus the native attachment action.
 *
 * Keeping those modes explicit prevents a slash command or disk picker from
 * masquerading as a mention when the transcript is serialized later.
 */
export function MentionPicker({
  mode,
  query,
  workspaceRoot,
  allowAttachments,
  canCompact,
  config,
  capabilities,
  onPick,
  onDismiss,
}: {
  mode: ComposerPickerMode;
  query: string;
  workspaceRoot?: string | null;
  allowAttachments: boolean;
  canCompact: boolean;
  config: ConfigState;
  capabilities: CapabilitiesState;
  onPick: (pick: MentionPick) => void;
  onDismiss: () => void;
}) {
  const listboxId = useId();
  const [files, setFiles] = useState<FuzzyFileSearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [addQuery, setAddQuery] = useState("");
  const effectiveQuery = mode === "add" ? addQuery : query;

  useEffect(() => {
    if (mode === "command") {
      setFiles([]);
      return;
    }
    setFiles([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.codexDesk
        .searchFiles(effectiveQuery, workspaceRoot ?? undefined)
        .then((found) => {
          if (!cancelled) setFiles(found);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, effectiveQuery, workspaceRoot]);

  const entries = useMemo<Entry[]>(() => {
    const q = effectiveQuery.trim().toLowerCase();
    const matches = (text: string) => !q || text.toLowerCase().includes(q);

    const matchedCommands = COMMANDS.filter(
      ({ command }) => command !== "compact" || canCompact,
    )
      .filter(({ command, detail }) => matches(command) || matches(detail))
      .map<Entry>(({ command, detail }) => ({
        id: `command:${command}`,
        label: `/${command}`,
        detail,
        icon: "command",
        pick: { kind: "command", command },
      }));
    const commands = sectionEntries(
      "Commands",
      matchedCommands.slice(0, MAX_COMMANDS),
      matchedCommands.length,
    );

    if (mode === "command") return commands;

    const matchedSkills = config.skills.items
      .filter((skill) => skill.enabled)
      .filter(
        (skill) =>
          matches(skill.name) ||
          matches(skill.displayName ?? "") ||
          matches(skill.description ?? ""),
      )
      .map<Entry>((skill) => ({
        id: `skill:${skill.path}`,
        label: skill.displayName || skill.name,
        detail: skill.shortDescription || skill.description || "",
        icon: "skill",
        pick: {
          kind: "skill",
          name: skill.name,
          prompt: skill.defaultPrompt,
        },
      }));
    const skills = sectionEntries(
      "Skills",
      matchedSkills.slice(0, MAX_MENTION_CAPABILITIES),
      matchedSkills.length,
    );

    const matchedPlugins = capabilities.plugins.items
      .filter((plugin) => plugin.enabled && plugin.availability === "AVAILABLE")
      .filter(
        (plugin) =>
          matches(plugin.name) ||
          matches(plugin.displayName) ||
          matches(plugin.description ?? ""),
      )
      .map<Entry>((plugin) => ({
        id: `plugin:${plugin.id}`,
        label: plugin.displayName,
        detail: plugin.description ?? "",
        icon: "plugin",
        pick: {
          kind: "plugin",
          name: plugin.name,
          prompt: plugin.defaultPrompts[0] ?? null,
        },
      }));
    const plugins = sectionEntries(
      "Plugins",
      matchedPlugins.slice(
        0,
        mode === "add" ? MAX_ADD_CAPABILITIES : MAX_MENTION_CAPABILITIES,
      ),
      matchedPlugins.length,
    );

    const fileEntries = sectionEntries(
      "Files",
      files
        .slice(0, mode === "add" ? MAX_ADD_FILES : MAX_MENTION_FILES)
        .map<Entry>((file) => ({
          id: `file:${file.path}`,
          label: file.file_name,
          detail: fileContext(file),
          icon: "file",
          pick: { kind: "file", path: file.path },
        })),
      files.length,
      mode === "add",
    );

    const addResults = [...fileEntries, ...commands, ...plugins];
    const attachment =
      mode === "add" && allowAttachments && (!q || addResults.length === 0)
        ? [
            {
              id: "attachment",
              label: "Files or photos…",
              detail: "from disk",
              icon: "attachment" as const,
              pick: { kind: "attachment" } as const,
            },
          ]
        : [];

    return mode === "add"
      ? [...attachment, ...addResults]
      : [...fileEntries, ...skills, ...plugins];
  }, [
    mode,
    effectiveQuery,
    allowAttachments,
    canCompact,
    config.skills.items,
    capabilities.plugins.items,
    files,
  ]);

  useEffect(() => {
    setSelected(0);
  }, [mode, effectiveQuery]);

  useEffect(() => {
    setSelected((current) => (current >= entries.length ? 0 : current));
  }, [entries.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (entries.length === 0 || event.isComposing) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSelected((current) => (current + 1) % entries.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelected(
          (current) => (current - 1 + entries.length) % entries.length,
        );
      } else if (event.key === "Tab" || event.key === "Enter") {
        const entry = entries[selected];
        if (entry) {
          event.preventDefault();
          event.stopPropagation();
          onPick(entry.pick);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [entries, selected, onPick, onDismiss]);

  const trigger = mode === "command" ? "/" : mode === "mention" ? "@" : "+";

  return (
    <div
      className="mentions"
      data-mode={mode}
      data-query-empty={mode === "add" && !effectiveQuery.trim()}
      aria-label="Composer suggestions"
    >
      <div className="composer-picker-query">
        <span aria-hidden="true">{trigger}</span>
        {mode === "add" ? (
          <input
            autoFocus
            type="search"
            aria-label="Search files, commands, and plugins"
            placeholder="Search files, commands, plugins"
            value={addQuery}
            onChange={(event) => setAddQuery(event.target.value)}
          />
        ) : (
          <span className={query ? "" : "placeholder"}>
            {query ||
              (mode === "mention"
                ? "Mention files, skills, plugins"
                : "Choose a command")}
          </span>
        )}
      </div>
      <div
        id={listboxId}
        className="composer-picker-list"
        role="listbox"
        aria-label={
          mode === "add"
            ? "Add menu"
            : mode === "command"
              ? "Slash commands"
              : "Mentions"
        }
      >
        {entries.length === 0 ? (
          <div className="composer-picker-empty">No matches</div>
        ) : (
          entries.map((entry, index) => (
            <div
              key={entry.id}
              className={
                entry.pick.kind === "attachment"
                  ? "composer-picker-attachment"
                  : undefined
              }
            >
              {entry.section && (
                <div className="mention-section">
                  <span>{entry.section.label}</span>
                  {mode === "add" && (
                    <span>
                      {entry.section.shown} of {entry.section.total}
                    </span>
                  )}
                </div>
              )}
              <div
                id={`${listboxId}-${index}`}
                className={`mention${index === selected ? " selected" : ""}`}
                role="option"
                aria-selected={index === selected}
                onMouseMove={() => setSelected(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(entry.pick);
                }}
              >
                <span className="composer-picker-icon">
                  <PickerIcon kind={entry.icon} />
                </span>
                <span className="mention-name">{entry.label}</span>
                <span className="muted">{entry.detail}</span>
              </div>
              {mode === "add" && Boolean(entry.remaining) && (
                <div className="composer-picker-more">
                  type to reach the other {entry.remaining}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <div className="composer-picker-help">
        {mode === "add" ? (
          <>
            <span>Recents per section.</span>
            <span>
              <kbd>↑↓</kbd> to move, <kbd>↵</kbd> to insert.
            </span>
          </>
        ) : (
          <>
            <span>Esc dismisses</span>
            <span>
              <kbd>↑↓</kbd> move <kbd>↵</kbd> insert
            </span>
          </>
        )}
      </div>
    </div>
  );
}
