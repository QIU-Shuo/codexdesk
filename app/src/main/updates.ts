/**
 * Auto-update policy for packaged builds.
 *
 * Electron owns the platform updater, but this module owns the decisions that
 * are specific to CodexDesk: which feeds are trusted, when to check, and
 * whether a restart would interrupt active work. Keeping Electron behind
 * small ports makes those decisions unit-testable without launching the app.
 */

export type UpdateConfig =
  { enabled: false; reason: string } | { enabled: true; feedUrl: string };

export type UpdateConfigInput = {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  feedUrl: string;
};

/** Do not recreate a macOS window while Squirrel is trying to quit the app. */
export function shouldCreateWindowOnActivate(input: {
  openWindowCount: number;
  installingUpdate: boolean;
}): boolean {
  return input.openWindowCount === 0 && !input.installingUpdate;
}

/** Only signed, packaged macOS builds currently have a supported maker. */
export function resolveUpdateConfig(input: UpdateConfigInput): UpdateConfig {
  if (!input.isPackaged) {
    return { enabled: false, reason: "development build" };
  }
  if (input.platform !== "darwin") {
    return { enabled: false, reason: "unsupported platform" };
  }

  const feedUrl = input.feedUrl.trim();
  if (!feedUrl) return { enabled: false, reason: "no update feed configured" };

  let parsed: URL;
  try {
    parsed = new URL(feedUrl);
  } catch {
    return { enabled: false, reason: "invalid update feed URL" };
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return {
      enabled: false,
      reason: "update feed URL contains credentials or mutable parameters",
    };
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const secureRemote = parsed.protocol === "https:";
  const loopbackTest =
    parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname);
  if (!secureRemote && !loopbackTest) {
    return { enabled: false, reason: "insecure update feed URL" };
  }

  return { enabled: true, feedUrl: parsed.href };
}

export type AutoUpdaterPort = {
  setFeedURL(options: { url: string; serverType: "json" }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  onError(listener: (error: Error) => void): void;
  onUpdateAvailable(listener: () => void): void;
  onUpdateNotAvailable(listener: () => void): void;
  onUpdateDownloaded(listener: (releaseName: string) => void): void;
  onBeforeQuitForUpdate(listener: () => void): void;
};

export type UpdateDialogOptions = {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: number;
  cancelId: number;
};

export type AutoUpdateDeps = {
  config: UpdateConfig;
  updater: AutoUpdaterPort;
  showDialog(options: UpdateDialogOptions): Promise<{ response: number }>;
  restartBlockers(): string[];
  prepareForExit(): void;
  log(level: "info" | "error", message: string): void;
  startupDelayMs?: number;
  intervalMs?: number;
};

/**
 * Configure background checks and return a disposer for the periodic timer.
 * Downloading is automatic; installation always waits for an explicit choice.
 */
export function startAutoUpdates(deps: AutoUpdateDeps): () => void {
  if (!deps.config.enabled) return () => undefined;

  let phase: "idle" | "checking" | "downloading" | "downloaded" = "idle";
  let disposed = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let startup: ReturnType<typeof setTimeout> | null = null;
  let preparedForExit = false;

  const stopTimers = () => {
    if (startup) clearTimeout(startup);
    if (interval) clearInterval(interval);
    startup = null;
    interval = null;
  };

  const check = () => {
    if (disposed || phase !== "idle") return;
    phase = "checking";
    try {
      deps.updater.checkForUpdates();
    } catch (error) {
      phase = "idle";
      deps.log(
        "error",
        `Update check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const prepareForExit = () => {
    if (preparedForExit) return;
    preparedForExit = true;
    deps.prepareForExit();
  };

  deps.updater.onError((error) => {
    if (phase !== "downloaded") phase = "idle";
    deps.log("error", `Update failed: ${error.message}`);
  });
  deps.updater.onUpdateAvailable(() => {
    phase = "downloading";
    deps.log("info", "An update is available and is downloading.");
  });
  deps.updater.onUpdateNotAvailable(() => {
    phase = "idle";
  });
  deps.updater.onBeforeQuitForUpdate(prepareForExit);
  deps.updater.onUpdateDownloaded((releaseName) => {
    phase = "downloaded";
    stopTimers();

    const blockers = deps.restartBlockers();
    const blockerDetail = blockers.length
      ? `Restarting now will interrupt:\n\n${blockers.map((item) => `• ${item}`).join("\n")}\n\nChoose Later to finish that work first.`
      : "The update is ready. Restart CodexDesk to install it.";

    void deps
      .showDialog({
        title: "CodexDesk update",
        message: releaseName || "An update has been downloaded.",
        detail: blockerDetail,
        buttons: ["Install and Restart", "Later"],
        defaultId: blockers.length ? 1 : 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response !== 0) return;
        // Squirrel closes windows before Electron's normal before-quit event,
        // so flush drafts and stop child processes proactively as well as from
        // the before-quit-for-update listener above.
        prepareForExit();
        deps.updater.quitAndInstall();
      })
      .catch((error) => {
        deps.log(
          "error",
          `Could not show the update prompt: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  });

  try {
    deps.updater.setFeedURL({
      url: deps.config.feedUrl,
      serverType: "json",
    });
  } catch (error) {
    deps.log(
      "error",
      `Could not configure updates: ${error instanceof Error ? error.message : String(error)}`,
    );
    return () => undefined;
  }

  const startupDelayMs = deps.startupDelayMs ?? 5_000;
  const intervalMs = deps.intervalMs ?? 10 * 60_000;
  startup = setTimeout(check, startupDelayMs);
  interval = setInterval(check, intervalMs);
  // The updater should not be the only reason the main process stays alive.
  interval.unref?.();

  return () => {
    disposed = true;
    stopTimers();
  };
}
