/** Build the static Squirrel.Mac manifest selected by `serverType: "json"`. */
export function createStaticUpdateManifest({
  version,
  url,
  name,
  notes,
  publishedAt,
}) {
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: {
          version,
          url,
          name,
          notes,
          pub_date: publishedAt,
        },
      },
    ],
  };
}
