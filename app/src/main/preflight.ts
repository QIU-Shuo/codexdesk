import type { PreflightState } from "../shared/ipc";
import {
  MANAGED_CODEX_RELEASE,
  type ManagedCodexRuntime,
} from "./managedCodex";

/**
 * Exact managed runtime validated against our committed generated types.
 * Bump this in the same change that regenerates `src/protocol/generated` and
 * updates the pinned artifact metadata — the three are one workflow.
 */
export const PINNED_CODEX_VERSION = MANAGED_CODEX_RELEASE.version;

/** The version the committed bindings were generated from. */
export const GENERATED_FROM_VERSION = MANAGED_CODEX_RELEASE.version;

export async function preflight(
  runtime: ManagedCodexRuntime,
): Promise<PreflightState> {
  const state = await runtime.inspect();
  return state.kind === "ready"
    ? { ...state, runtimePath: runtime.displayPath }
    : state;
}
