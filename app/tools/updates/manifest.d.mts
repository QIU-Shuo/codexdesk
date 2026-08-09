export type StaticUpdateManifestInput = {
  version: string;
  url: string;
  name: string;
  notes: string;
  publishedAt: string;
};

export type StaticUpdateManifest = {
  currentRelease: string;
  releases: Array<{
    version: string;
    updateTo: {
      version: string;
      url: string;
      name: string;
      notes: string;
      pub_date: string;
    };
  }>;
};

export function createStaticUpdateManifest(
  input: StaticUpdateManifestInput,
): StaticUpdateManifest;
