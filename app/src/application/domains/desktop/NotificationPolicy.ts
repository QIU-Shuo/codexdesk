export type NotificationMode = "off" | "unfocused" | "always";

/**
 * CodexDesk requirement: notify about background work without duplicating state
 * already visible in the focused conversation.
 */
export function shouldPresentNotification(input: {
  mode: NotificationMode;
  mainWindowFocused: boolean;
  targetConversationVisible: boolean;
}): boolean {
  if (input.mode === "off") return false;
  if (input.mode === "always") return true;
  return !(input.mainWindowFocused && input.targetConversationVisible);
}
