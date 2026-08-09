export interface ReleaseArtifactNameOptions {
  productName: string;
  arch: string;
  version: string;
}

export interface ReleaseArtifactNames {
  dmg: string;
  zip: string;
}

export function releaseArtifactNames(
  options: ReleaseArtifactNameOptions,
): ReleaseArtifactNames;
