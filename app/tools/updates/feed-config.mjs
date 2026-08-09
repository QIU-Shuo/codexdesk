const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseCredentialFreeUrl(value, { allowLoopbackHttp }) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Update feed URL must be an absolute URL.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Update feed URL must not contain credentials, query parameters, or fragments.",
    );
  }

  const secureRemote = parsed.protocol === "https:";
  const loopbackTest =
    allowLoopbackHttp &&
    parsed.protocol === "http:" &&
    loopbackHosts.has(parsed.hostname);
  if (!secureRemote && !loopbackTest) {
    throw new Error(
      allowLoopbackHttp
        ? "Update feed URL must use HTTPS, except for loopback canary testing."
        : "Public update feed URL must use HTTPS.",
    );
  }

  return parsed.href;
}

/** Resolve the feed metadata compiled into Electron's main-process bundle. */
export function resolveBuildUpdateFeed({
  canaryBuild,
  publicReleaseBuild,
  configuredUrl,
}) {
  if (canaryBuild && publicReleaseBuild) {
    throw new Error("A public release build cannot use the canary channel.");
  }

  const configured = configuredUrl?.trim() || "";
  if (canaryBuild) {
    return {
      channel: "canary",
      feedUrl: parseCredentialFreeUrl(
        configured || "http://127.0.0.1:4319/feed.json",
        { allowLoopbackHttp: true },
      ),
    };
  }

  if (!publicReleaseBuild) {
    return { channel: "stable", feedUrl: "" };
  }
  if (!configured) {
    throw new Error("Public release builds require CODEXDESK_UPDATE_FEED_URL.");
  }

  return {
    channel: "stable",
    feedUrl: parseCredentialFreeUrl(configured, { allowLoopbackHttp: false }),
  };
}

/** Validate the public base URL used by the static release-manifest generator. */
export function resolvePublicAssetBaseUrl(value) {
  const parsed = new URL(
    parseCredentialFreeUrl(value?.trim() || "", {
      allowLoopbackHttp: false,
    }),
  );
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.href;
}
