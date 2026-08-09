import type {
  ForgeConfig,
  ForgePackagerOptions,
} from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import path from "node:path";

const canaryBuild = process.env.CODEXDESK_BUILD_CHANNEL === "canary";
const releaseBuild = process.env.CODEXDESK_RELEASE_BUILD === "true";
const publicReleaseBuild = process.env.CODEXDESK_PUBLIC_RELEASE === "true";
const signingIdentity = process.env.CODEXDESK_MAC_SIGN_IDENTITY?.trim();
const selfSignedIdentity =
  process.env.CODEXDESK_MAC_SIGN_SELF_SIGNED === "true" ||
  process.env.CODEXDESK_MAC_SIGN_LOCAL === "true";

if ((canaryBuild || releaseBuild) && !signingIdentity) {
  throw new Error(
    "Release and canary builds must be signed. Set CODEXDESK_MAC_SIGN_IDENTITY to a valid macOS code-signing identity.",
  );
}

if (publicReleaseBuild && !releaseBuild) {
  throw new Error(
    "Public release builds must also set CODEXDESK_RELEASE_BUILD=true.",
  );
}

if (releaseBuild && selfSignedIdentity) {
  throw new Error(
    "Release builds require an Apple Developer ID identity; self-signed signing is only supported for local canary testing.",
  );
}

type ReliableSignOptions = Exclude<
  ForgePackagerOptions["osxSign"],
  boolean | undefined
> & { continueOnError: false };

const signOptions: ReliableSignOptions = signingIdentity
  ? {
      identity: signingIdentity,
      // Electron Packager otherwise treats a signing failure as non-fatal,
      // which can leave a build looking complete with an ad-hoc signature.
      continueOnError: false,
      identityValidation: !selfSignedIdentity,
      // Generic self-signed identities have neither a trusted timestamp
      // service nor a Team ID. Disable hardened runtime only for that explicit
      // fallback; Developer ID builds keep production defaults.
      ...(selfSignedIdentity
        ? {
            optionsForFile: () => ({
              timestamp: "none" as const,
              hardenedRuntime: false,
            }),
          }
        : {}),
    }
  : {
      // Apple Silicon binaries carry a linker signature even in local builds.
      // Seal the full bundle ad hoc so its executable and resources are not
      // left in an internally inconsistent state. Public/canary builds never
      // reach this fallback because they require an explicit identity above.
      identity: "-",
      identityValidation: false,
      continueOnError: false,
      optionsForFile: () => ({
        timestamp: "none" as const,
        hardenedRuntime: false,
      }),
    };

// Every window loads the same renderer entry; the main process assigns each
// window its role and the renderer chooses the corresponding route.
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.qiushuo.codexdesk",
    icon: path.resolve(import.meta.dirname, "assets/codexdesk.icns"),
    extraResource: [
      "../LICENSE",
      "../NOTICE",
      "../PRIVACY.md",
      "../THIRD_PARTY_LICENSES",
      path.resolve(
        import.meta.dirname,
        "node_modules/electron/dist/LICENSES.chromium.html",
      ),
    ],
    osxSign: signOptions,
    ...(canaryBuild
      ? {
          name: "CodexDesk-canary",
          appBundleId: "com.qiushuo.codexdesk.canary",
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ["darwin"])],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/index.ts", config: "vite.main.config.mts" },
        { entry: "src/preload/index.ts", config: "vite.preload.config.mts" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
    }),
  ],
};

export default config;
