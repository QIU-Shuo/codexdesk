export type BuildUpdateFeedInput = {
  canaryBuild: boolean;
  publicReleaseBuild: boolean;
  configuredUrl?: string;
};

export type BuildUpdateFeed = {
  channel: "stable" | "canary";
  feedUrl: string;
};

export function resolveBuildUpdateFeed(
  input: BuildUpdateFeedInput,
): BuildUpdateFeed;

export function resolvePublicAssetBaseUrl(value?: string): string;
