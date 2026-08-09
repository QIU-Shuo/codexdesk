import type { DeliveryProgressView } from "../../../contracts/views/delivery";
import type { DeliveryState } from "./DeliveryService";

export function deliveryProgressView(
  state: DeliveryState,
  busy: boolean,
): DeliveryProgressView {
  return {
    next: state.next,
    branch: state.branch,
    defaultBranch: state.defaultBranch,
    remote: state.remote,
    upstream: state.upstream,
    files: [...state.files],
    changes: state.changes.map((change) => ({ ...change })),
    additions: state.additions,
    deletions: state.deletions,
    committedSha: state.committedSha,
    pushed: state.pushed,
    prUrl: state.prUrl,
    issue: state.issue ? { ...state.issue } : null,
    busy,
  };
}
