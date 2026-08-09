export function releaseArtifactNames({ productName, arch, version }) {
  for (const [label, value] of Object.entries({ productName, arch, version })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${label} is required to name release artifacts`);
    }
  }

  const publicBaseName = `${productName}-macOS-${arch}-${version}`;
  return {
    dmg: `${publicBaseName}.dmg`,
    zip: `${publicBaseName}.zip`,
  };
}
