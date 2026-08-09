import type { InputOutboxView } from "../../../contracts/views/conversations";
import type { InputOutbox } from "./InputOutbox";

export function inputOutboxView(outbox: InputOutbox): InputOutboxView {
  return {
    entries: outbox.durableSnapshot().entries,
    dispatch: outbox.dispatchState(),
    capacity: outbox.policy.capacity,
  };
}
