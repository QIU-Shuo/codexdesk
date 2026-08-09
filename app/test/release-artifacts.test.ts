import { describe, expect, it } from "vitest";
import { releaseArtifactNames } from "../tools/releases/artifact-names.mjs";

describe("release artifact names", () => {
  it("uses macOS in public arm64 artifact names", () => {
    expect(
      releaseArtifactNames({
        productName: "CodexDesk",
        arch: "arm64",
        version: "0.1.0",
      }),
    ).toEqual({
      dmg: "CodexDesk-macOS-arm64-0.1.0.dmg",
      zip: "CodexDesk-macOS-arm64-0.1.0.zip",
    });
  });

  it("rejects incomplete artifact metadata", () => {
    expect(() =>
      releaseArtifactNames({
        productName: "CodexDesk",
        arch: "",
        version: "0.1.0",
      }),
    ).toThrow("arch is required");
  });
});
