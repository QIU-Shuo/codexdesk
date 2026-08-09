import { app } from "electron";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import {
  emptyPersistedState,
  type PersistedState,
  type PersistedThread,
} from "../infrastructure/persistence/stateSchema";
import { readPersistedState } from "../infrastructure/persistence/readState";

export type { PersistedState, PersistedThread };

/**
 * Durable client-side state (plan §6, 3.3).
 *
 * app-server persists the *thread*; this persists the work around it —
 * drafts, queued follow-ups, pin order, notification mode, last-opened
 * thread. Losing typed text on quit is the specific failure this prevents.
 *
 * **Deviation from the plan:** it specifies "a small main-process database
 * with schema migrations". This is a versioned JSON file instead. The
 * dataset is a few KB of per-thread scalars with no queries over it, and an
 * embedded SQLite binding would be a native module requiring a rebuild step
 * against Electron's ABI — cost we would pay on every install for no
 * current benefit. The `version` field and `migrate()` keep the upgrade
 * path open; revisit when there is something worth querying (full
 * transcript search is the likely trigger).
 *
 * Writes are atomic (temp file + rename) because a crash mid-write would
 * otherwise leave unparseable JSON and silently discard every draft.
 */
/**
 * A fresh empty state.
 *
 * Must be a factory, not a shared constant: `{ ...EMPTY }` is a *shallow*
 * copy, so every Store would share one `threads` object and one `recents`
 * array, and writes would leak between instances (and across a failed load).
 */
function emptyState(): PersistedState {
  return emptyPersistedState();
}

export class Store {
  private state: PersistedState = emptyState();
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  static defaultPath(): string {
    const directory = app.getPath("userData");
    const nextPath = path.join(directory, "codexdesk-state.json");
    const legacyPath = path.join(directory, "occo-state.json");
    return !existsSync(nextPath) && existsSync(legacyPath)
      ? legacyPath
      : nextPath;
  }

  load(): PersistedState {
    try {
      if (!existsSync(this.file)) return this.state;
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      this.state = migrate(raw);
    } catch {
      // A corrupt store must not prevent the app from starting. Losing
      // drafts is bad; refusing to launch is worse.
      this.state = emptyState();
    }
    return this.state;
  }

  get(): PersistedState {
    return this.state;
  }

  update(fn: (s: PersistedState) => void): void {
    fn(this.state);
    this.scheduleWrite();
  }

  /**
   * Coalesce rapid writes (every keystroke updates a draft), but keep the
   * window short — the whole point is surviving an unexpected quit.
   */
  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 400);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch {
      // Persistence is best-effort; never take the app down over it.
    }
  }
}

/** Bring an older on-disk shape up to `CURRENT_VERSION`. */
export function migrate(raw: unknown): PersistedState {
  return readPersistedState(raw);
}
