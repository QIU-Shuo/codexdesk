import path from "node:path";
import { existsSync } from "node:fs";

export type UserDataPathInput = {
  explicitPath?: string;
  buildChannel: "stable" | "canary";
  appDataPath: string;
};

/** Keep canary state away from the normal app unless a test path is explicit. */
export function resolveUserDataPath(input: UserDataPathInput): string | null {
  const explicitPath = input.explicitPath?.trim();
  if (explicitPath) return explicitPath;

  // Keep existing installations on their current profile after the product
  // rename. Fresh installs use Electron's CodexDesk default (stable) or the
  // new explicit canary directory below.
  const legacyName =
    input.buildChannel === "canary" ? "occo-desktop-canary" : "occo-desktop";
  const legacyPath = path.join(input.appDataPath, legacyName);
  if (input.buildChannel === "canary") {
    const nextPath = path.join(input.appDataPath, "CodexDesk-canary");
    return existsSync(legacyPath) && !existsSync(nextPath)
      ? legacyPath
      : nextPath;
  }
  return existsSync(legacyPath) ? legacyPath : null;
}
