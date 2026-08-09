/**
 * Serializable capability models shared across the Electron boundary.
 *
 * These types describe what CodexDesk renders. They intentionally do not expose
 * app-server response objects, so a protocol regeneration stays inside the
 * infrastructure adapter.
 */

export type CollectionState<T> =
  | { status: "idle"; items: T[] }
  | { status: "loading"; items: T[] }
  | { status: "ready"; items: T[] }
  | { status: "error"; items: T[]; message: string };

export type SkillScope = "user" | "repo" | "system" | "admin";

export type SkillView = {
  name: string;
  description: string;
  displayName: string | null;
  shortDescription: string | null;
  defaultPrompt: string | null;
  path: string;
  scope: SkillScope;
  enabled: boolean;
};

export type SkillErrorView = {
  path: string;
  message: string;
};

export type SkillCatalog = {
  skills: SkillView[];
  errors: SkillErrorView[];
};

export type PluginView = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  marketplace: string;
  enabled: boolean;
  authPolicy: "ON_INSTALL" | "ON_USE";
  availability: "AVAILABLE" | "DISABLED_BY_ADMIN";
  skillNames: string[];
  mcpServerNames: string[];
  defaultPrompts: string[];
};

export type McpServerView = {
  name: string;
  authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  toolNames: string[];
  resourceCount: number;
  status: "starting" | "ready" | "failed" | "cancelled" | null;
  error: string | null;
  failureReason: "reauthenticationRequired" | null;
};

export type McpStatusUpdate = {
  name: string;
  status: Exclude<McpServerView["status"], null>;
  error: string | null;
  failureReason: McpServerView["failureReason"];
};

export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";

export type WebSearchSettings = {
  mode: WebSearchMode | null;
  allowedModes: WebSearchMode[] | null;
};

export type CapabilitiesState = {
  plugins: CollectionState<PluginView>;
  mcpServers: CollectionState<McpServerView>;
};
