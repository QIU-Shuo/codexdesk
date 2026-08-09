import path from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveUserDataPath } from "../src/main/profile";

describe("resolveUserDataPath", () => {
  it("uses an explicit test profile for either build channel", () => {
    expect(
      resolveUserDataPath({
        explicitPath: " /tmp/codexdesk-test-profile ",
        buildChannel: "canary",
        appDataPath: "/Users/me/Library/Application Support",
      }),
    ).toBe("/tmp/codexdesk-test-profile");
  });

  it("isolates canary state from the normal product profile", () => {
    expect(
      resolveUserDataPath({
        buildChannel: "canary",
        appDataPath: "/Users/me/Library/Application Support",
      }),
    ).toBe(
      path.join("/Users/me/Library/Application Support", "CodexDesk-canary"),
    );
  });

  it("leaves the stable product profile unchanged", () => {
    expect(
      resolveUserDataPath({
        buildChannel: "stable",
        appDataPath: "/Users/me/Library/Application Support",
      }),
    ).toBeNull();
  });

  it("keeps an existing pre-rename profile connected", () => {
    const appDataPath = mkdtempSync(path.join(tmpdir(), "codexdesk-profile-"));
    const legacyPath = path.join(appDataPath, "occo-desktop");
    mkdirSync(legacyPath);

    expect(
      resolveUserDataPath({
        buildChannel: "stable",
        appDataPath,
      }),
    ).toBe(legacyPath);
  });
});
