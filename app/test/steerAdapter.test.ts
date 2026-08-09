import { describe, expect, it } from "vitest";
import { activeTurnNotSteerableDetail } from "../src/main/appServer/client";

describe("turn injection adapter", () => {
  it("converts the public non-steerable error variant at the boundary", () => {
    const error = Object.assign(new Error("request rejected"), {
      data: {
        error: {
          activeTurnNotSteerable: { turnKind: "review" },
        },
      },
    });
    expect(activeTurnNotSteerableDetail(error)).toBe("review");
  });

  it("leaves unrelated transport failures unresolved for the caller", () => {
    expect(activeTurnNotSteerableDetail(new Error("connection closed"))).toBe(
      undefined,
    );
  });
});
