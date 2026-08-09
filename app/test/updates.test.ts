import { describe, expect, it, vi } from "vitest";
import {
  resolveUpdateConfig,
  shouldCreateWindowOnActivate,
  startAutoUpdates,
  type AutoUpdaterPort,
  type UpdateDialogOptions,
} from "../src/main/updates";
import { createStaticUpdateManifest } from "../tools/updates/manifest.mjs";
import {
  resolveBuildUpdateFeed,
  resolvePublicAssetBaseUrl,
} from "../tools/updates/feed-config.mjs";

class FakeUpdater implements AutoUpdaterPort {
  feed: { url: string; serverType: "json" } | null = null;
  checks = 0;
  installs = 0;
  error: (error: Error) => void = () => undefined;
  available: () => void = () => undefined;
  notAvailable: () => void = () => undefined;
  downloaded: (releaseName: string) => void = () => undefined;
  beforeQuit: () => void = () => undefined;

  setFeedURL(options: { url: string; serverType: "json" }): void {
    this.feed = options;
  }
  checkForUpdates(): void {
    this.checks += 1;
  }
  quitAndInstall(): void {
    this.installs += 1;
  }
  onError(listener: (error: Error) => void): void {
    this.error = listener;
  }
  onUpdateAvailable(listener: () => void): void {
    this.available = listener;
  }
  onUpdateNotAvailable(listener: () => void): void {
    this.notAvailable = listener;
  }
  onUpdateDownloaded(listener: (releaseName: string) => void): void {
    this.downloaded = listener;
  }
  onBeforeQuitForUpdate(listener: () => void): void {
    this.beforeQuit = listener;
  }
}

describe("macOS activation during update install", () => {
  it("does not recreate a window while Squirrel is quitting the app", () => {
    expect(
      shouldCreateWindowOnActivate({
        openWindowCount: 0,
        installingUpdate: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateWindowOnActivate({
        openWindowCount: 0,
        installingUpdate: false,
      }),
    ).toBe(true);
  });
});

describe("resolveUpdateConfig", () => {
  it("enables an HTTPS feed only for a packaged macOS app", () => {
    expect(
      resolveUpdateConfig({
        isPackaged: true,
        platform: "darwin",
        feedUrl: "https://updates.example.test/canary",
      }),
    ).toEqual({
      enabled: true,
      feedUrl: "https://updates.example.test/canary",
    });
  });

  it("allows loopback HTTP but rejects file feeds for private testing", () => {
    expect(
      resolveUpdateConfig({
        isPackaged: true,
        platform: "darwin",
        feedUrl: "file:///tmp/codexdesk-updates/feed.json",
      }).enabled,
    ).toBe(false);
    expect(
      resolveUpdateConfig({
        isPackaged: true,
        platform: "darwin",
        feedUrl: "http://127.0.0.1:4319/update",
      }).enabled,
    ).toBe(true);
  });

  it("rejects development, unsupported, and insecure remote feeds", () => {
    expect(
      resolveUpdateConfig({
        isPackaged: false,
        platform: "darwin",
        feedUrl: "https://updates.example.test",
      }).enabled,
    ).toBe(false);
    expect(
      resolveUpdateConfig({
        isPackaged: true,
        platform: "linux",
        feedUrl: "https://updates.example.test",
      }).enabled,
    ).toBe(false);
    expect(
      resolveUpdateConfig({
        isPackaged: true,
        platform: "darwin",
        feedUrl: "http://updates.example.test",
      }).enabled,
    ).toBe(false);
    expect(
      resolveUpdateConfig({
        isPackaged: true,
        platform: "darwin",
        feedUrl: "https://token@updates.example.test/feed.json",
      }).enabled,
    ).toBe(false);
    expect(
      resolveUpdateConfig({
        isPackaged: true,
        platform: "darwin",
        feedUrl: "https://updates.example.test/feed.json?token=secret",
      }).enabled,
    ).toBe(false);
  });
});

describe("release build update feed", () => {
  it("keeps development and private release candidates update-disabled", () => {
    expect(
      resolveBuildUpdateFeed({
        canaryBuild: false,
        publicReleaseBuild: false,
        configuredUrl: "https://updates.example.test/feed.json",
      }),
    ).toEqual({ channel: "stable", feedUrl: "" });
  });

  it("requires a credential-free HTTPS feed for public releases", () => {
    expect(
      resolveBuildUpdateFeed({
        canaryBuild: false,
        publicReleaseBuild: true,
        configuredUrl: "https://updates.example.test/feed.json",
      }),
    ).toEqual({
      channel: "stable",
      feedUrl: "https://updates.example.test/feed.json",
    });
    expect(() =>
      resolveBuildUpdateFeed({
        canaryBuild: false,
        publicReleaseBuild: true,
      }),
    ).toThrow(/require CODEXDESK_UPDATE_FEED_URL/);
    expect(() =>
      resolveBuildUpdateFeed({
        canaryBuild: false,
        publicReleaseBuild: true,
        configuredUrl: "https://updates.example.test/feed.json?token=secret",
      }),
    ).toThrow(/must not contain credentials/);
  });

  it("keeps loopback HTTP exclusive to the canary channel", () => {
    expect(
      resolveBuildUpdateFeed({
        canaryBuild: true,
        publicReleaseBuild: false,
      }),
    ).toEqual({
      channel: "canary",
      feedUrl: "http://127.0.0.1:4319/feed.json",
    });
    expect(() =>
      resolveBuildUpdateFeed({
        canaryBuild: false,
        publicReleaseBuild: true,
        configuredUrl: "http://127.0.0.1:4319/feed.json",
      }),
    ).toThrow(/must use HTTPS/);
  });

  it("normalizes a credential-free public asset base URL", () => {
    expect(
      resolvePublicAssetBaseUrl("https://downloads.example.test/v0.1.0"),
    ).toBe("https://downloads.example.test/v0.1.0/");
  });
});

describe("local static update manifest", () => {
  it("wraps the current release in the format required by serverType json", () => {
    expect(
      createStaticUpdateManifest({
        version: "0.1.1",
        url: "http://127.0.0.1:4319/CodexDesk-canary-0.1.1.zip",
        name: "CodexDesk canary 0.1.1",
        notes: "Local test",
        publishedAt: "2026-08-05T12:00:00.000Z",
      }),
    ).toEqual({
      currentRelease: "0.1.1",
      releases: [
        {
          version: "0.1.1",
          updateTo: {
            version: "0.1.1",
            url: "http://127.0.0.1:4319/CodexDesk-canary-0.1.1.zip",
            name: "CodexDesk canary 0.1.1",
            notes: "Local test",
            pub_date: "2026-08-05T12:00:00.000Z",
          },
        },
      ],
    });
  });
});

describe("startAutoUpdates", () => {
  it("checks, defaults to Later around active work, and installs on consent", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const dialogs: UpdateDialogOptions[] = [];
    const prepareForExit = vi.fn();
    const showDialog = vi
      .fn<(options: UpdateDialogOptions) => Promise<{ response: number }>>()
      .mockImplementation(async (options) => {
        dialogs.push(options);
        return { response: 0 };
      });

    const dispose = startAutoUpdates({
      config: { enabled: true, feedUrl: "http://127.0.0.1:4319/feed.json" },
      updater,
      showDialog,
      restartBlockers: () => ["1 active Codex turn", "1 open terminal"],
      prepareForExit,
      log: vi.fn(),
      startupDelayMs: 1,
      intervalMs: 60_000,
    });

    expect(updater.feed).toEqual({
      url: "http://127.0.0.1:4319/feed.json",
      serverType: "json",
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checks).toBe(1);

    updater.available();
    updater.downloaded("CodexDesk canary 0.1.1");
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledOnce());

    expect(dialogs[0]?.defaultId).toBe(1);
    expect(dialogs[0]?.detail).toContain("1 active Codex turn");
    expect(prepareForExit).toHaveBeenCalledOnce();
    expect(updater.installs).toBe(1);

    updater.beforeQuit();
    expect(prepareForExit).toHaveBeenCalledOnce();
    dispose();
    vi.useRealTimers();
  });

  it("leaves a downloaded update pending when the user chooses Later", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const prepareForExit = vi.fn();
    startAutoUpdates({
      config: { enabled: true, feedUrl: "http://127.0.0.1:4319/feed.json" },
      updater,
      showDialog: async () => ({ response: 1 }),
      restartBlockers: () => [],
      prepareForExit,
      log: vi.fn(),
      startupDelayMs: 60_000,
      intervalMs: 60_000,
    });

    updater.downloaded("0.1.1");
    await Promise.resolve();
    await Promise.resolve();
    expect(updater.installs).toBe(0);
    expect(prepareForExit).not.toHaveBeenCalled();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
