/**
 * Temporary current-UI projection.
 *
 * Delete this adapter when the independent UI-redesign milestone replaces the
 * current capability panel. Application and infrastructure code must never
 * import this renderer-owned module.
 */
import type {
  CapabilitiesState,
  CollectionState,
} from "../../contracts/views/capabilities";

function presentCollection<T>(state: CollectionState<T>): CollectionState<T> {
  switch (state.status) {
    case "idle":
    case "loading":
    case "ready":
      return { status: state.status, items: [...state.items] };
    case "error":
      return {
        status: "error",
        items: [...state.items],
        message: state.message,
      };
  }
}

export function presentCapabilities(
  state: CapabilitiesState,
): CapabilitiesState {
  return {
    plugins: presentCollection(state.plugins),
    mcpServers: presentCollection(state.mcpServers),
  };
}
