export interface PromptCapturePort {
  createConversation(): Promise<string | null>;
  sendPrompt(
    conversationId: string,
    text: string,
  ): Promise<{ error?: string }>;
}

export type PromptCaptureResult =
  | { kind: "submitted"; conversationId: string }
  | { kind: "invalid" }
  | { kind: "failed"; message: string };

/**
 * CodexDesk requirement: a focused transient composer can turn one durable draft
 * into a normal conversation without owning agent state or persistence.
 */
export async function submitCapturedPrompt(
  text: string,
  port: PromptCapturePort,
): Promise<PromptCaptureResult> {
  const prompt = text.trim();
  if (!prompt) return { kind: "invalid" };
  const conversationId = await port.createConversation();
  if (!conversationId) {
    return { kind: "failed", message: "Could not create a conversation." };
  }
  const sent = await port.sendPrompt(conversationId, prompt);
  if (sent.error) return { kind: "failed", message: sent.error };
  return { kind: "submitted", conversationId };
}
