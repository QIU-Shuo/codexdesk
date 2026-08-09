import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseVersion,
  resolveExecutableSearchPath,
} from "../src/main/preflight";

describe("resolveExecutableSearchPath", () => {
  it("adds conventional macOS CLI directories without duplicates", () => {
    expect(
      resolveExecutableSearchPath({
        currentPath: "/usr/bin:/opt/homebrew/bin:/bin",
        platform: "darwin",
        homeDir: "/Users/tester",
      }).split(":"),
    ).toEqual([
      "/usr/bin",
      "/opt/homebrew/bin",
      "/bin",
      "/usr/local/bin",
      "/opt/local/bin",
      "/Users/tester/.local/bin",
    ]);
  });

  it("leaves non-macOS search paths unchanged", () => {
    expect(
      resolveExecutableSearchPath({
        currentPath: "/usr/bin:/bin",
        platform: "linux",
        homeDir: "/home/tester",
      }),
    ).toBe("/usr/bin:/bin");
  });
});

describe("parseVersion", () => {
  it("reads the version out of `codex --version`", () => {
    expect(parseVersion("codex-cli 0.144.4\n")).toBe("0.144.4");
    expect(parseVersion("codex-cli 0.143.0-alpha.2")).toBe("0.143.0-alpha.2");
    expect(parseVersion("nothing here")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by numeric component, not lexically", () => {
    expect(compareVersions("0.144.4", "0.144.4")).toBe(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("0.144.10", "0.144.4")).toBe(1);
  });

  it("sorts a pre-release before its release", () => {
    expect(compareVersions("0.143.0-alpha", "0.143.0")).toBe(-1);
    expect(compareVersions("0.143.0", "0.143.0-alpha")).toBe(1);
  });

  it("treats missing components as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});
