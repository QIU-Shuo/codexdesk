export type AuxiliaryWindowRole =
  | { kind: "conversation"; conversationId: string }
  | { kind: "promptCapture" };

/**
 * A renderer may change its fragment, but it must not replace the privileged
 * document with another local file, dev-server route, or remote page.
 */
export function isTrustedRendererNavigation(
  navigationUrl: string,
  rendererUrl: string,
): boolean {
  try {
    const navigation = new URL(navigationUrl);
    const renderer = new URL(rendererUrl);
    navigation.hash = "";
    renderer.hash = "";
    return navigation.href === renderer.href;
  } catch {
    return false;
  }
}

/** Only ordinary web links may leave the app through the system browser. */
export function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Prompt capture is transient; a conversation window is durable navigation. */
export function dismissOnBlur(role: AuxiliaryWindowRole): boolean {
  return role.kind === "promptCapture";
}

export function reusesExistingWindow(
  existing: AuxiliaryWindowRole,
  requested: AuxiliaryWindowRole,
): boolean {
  if (existing.kind !== requested.kind) return false;
  return (
    existing.kind === "promptCapture" ||
    (requested.kind === "conversation" &&
      existing.conversationId === requested.conversationId)
  );
}
