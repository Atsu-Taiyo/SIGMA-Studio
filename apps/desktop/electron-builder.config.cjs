// electron-builder configuration.
//
// Migrated out of package.json "build" so signing/notarization can be toggled
// from the environment. The desktop app is distributed via GitHub Releases:
//   - macOS  : signed + notarized DMG  (when an Apple Developer cert is provided)
//   - Windows: unsigned NSIS installer (SmartScreen warning; see docs/distribution.md)
//
// All invocations MUST pass `--config electron-builder.config.cjs`; this file is
// intentionally not the auto-discovered `electron-builder.cjs` name so it never
// clashes with a stray package.json "build" block.

// eslint-disable-next-line @typescript-eslint/no-require-imports -- electron-builder loads this configuration as CommonJS.
const { windowsStoreMessages } = require("./scripts/windows-store-messages.cjs");

// macOS code-signing is enabled only when a certificate is supplied via CSC_LINK
// (a base64-encoded .p12 or a file path). Local package checks may still build
// unsigned, but public release jobs set SIGMA_STUDIO_REQUIRE_MAC_SIGNING=true so a
// signed + notarized DMG is required before anything is published.
const signMac = Boolean((process.env.CSC_LINK || "").trim());
const hasMacCertPassword = Boolean((process.env.CSC_KEY_PASSWORD || "").trim());
const requireMacSigning = process.env.SIGMA_STUDIO_REQUIRE_MAC_SIGNING === "true";
const buildWindowsStorePackage = process.env.SIGMA_STUDIO_WINDOWS_STORE === "true";

const windowsStoreIdentityName = (process.env.WINDOWS_STORE_IDENTITY_NAME || "").trim();
const windowsStorePublisher = (process.env.WINDOWS_STORE_PUBLISHER || "").trim();
const windowsStorePublisherDisplayName = (
  process.env.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME || ""
).trim();

// Notarization needs the Apple ID credentials in addition to a signing cert.
const canNotarize =
  signMac &&
  Boolean((process.env.APPLE_ID || "").trim()) &&
  Boolean((process.env.APPLE_APP_SPECIFIC_PASSWORD || "").trim()) &&
  Boolean((process.env.APPLE_TEAM_ID || "").trim());

if (requireMacSigning && (!signMac || !hasMacCertPassword)) {
  throw new Error(
    "SIGMA_STUDIO_REQUIRE_MAC_SIGNING=true requires CSC_LINK and CSC_KEY_PASSWORD for a Developer ID Application certificate.",
  );
}

if (requireMacSigning && !canNotarize) {
  throw new Error(
    "SIGMA_STUDIO_REQUIRE_MAC_SIGNING=true requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID for notarization.",
  );
}

if (
  buildWindowsStorePackage &&
  (!windowsStoreIdentityName || !windowsStorePublisher || !windowsStorePublisherDisplayName)
) {
  const missingVariables = [
    ["WINDOWS_STORE_IDENTITY_NAME", windowsStoreIdentityName],
    ["WINDOWS_STORE_PUBLISHER", windowsStorePublisher],
    ["WINDOWS_STORE_PUBLISHER_DISPLAY_NAME", windowsStorePublisherDisplayName],
  ].filter(([, value]) => !value).map(([name]) => name);
  throw new Error(windowsStoreMessages().missingIdentity(missingVariables));
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.atsutaiyo.sigmastudio",
  productName: "Sigma Studio",
  electronVersion: "34.5.8",
  npmRebuild: false,
  afterPack: "./scripts/check-native-lock-package.cjs",
  directories: {
    buildResources: "build",
    output: "release",
  },
  artifactName: "Sigma-Studio-${version}-${arch}.${ext}",
  // A single suffix is portable across OS file-type registries. Never claim .json.
  fileAssociations: [{
    ext: "sigma",
    name: "Sigma Studio Document",
    description: "Sigma Studio teaching material",
    mimeType: "application/x-sigma-studio",
    role: "Editor",
    rank: "Owner",
  }],
  files: [
    "dist-electron/**/*",
    "!dist-electron/**/*.map",
    "out/**/*",
    "package.json",
    "!node_modules/**/*.map",
    "!node_modules/**/*.tsbuildinfo",
  ],
  extraResources: [{ from: "../../THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" }],
  extraMetadata: {
    main: "dist-electron/main.cjs",
  },
  // Installers and update metadata share the project release repository.
  publish: {
    provider: "github",
    owner: "Atsu-Taiyo",
    repo: "SIGMA-Studio",
    releaseType: "draft",
  },
  mac: {
    // Ship separate Intel (x64) and Apple Silicon (arm64) DMGs for manual install,
    // plus ZIP artifacts required by electron-updater on macOS.
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.education",
    icon: "build/icon.icns",
    // Auto-discover the Developer ID cert when signing; disable signing entirely otherwise.
    identity: signMac ? undefined : null,
    hardenedRuntime: signMac,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: canNotarize ? { teamId: process.env.APPLE_TEAM_ID.trim() } : false,
  },
  dmg: {
    contents: [
      { x: 130, y: 220, type: "file" },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  win: {
    target: buildWindowsStorePackage ? "appx" : "nsis",
    icon: "build/icon.ico",
  },
  linux: {
    // argv receives local paths, including a separate argument for each selected file.
    executableArgs: ["%F"],
  },
  appx: {
    applicationId: "SigmaStudio",
    identityName: windowsStoreIdentityName || undefined,
    publisher: windowsStorePublisher || undefined,
    publisherDisplayName: windowsStorePublisherDisplayName || undefined,
    displayName: "Sigma Studio",
    languages: ["ja-JP", "en-US"],
    backgroundColor: "#ffffff",
    artifactName: "Sigma-Studio-Store-${version}-${arch}.${ext}",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    differentialPackage: true,
  },
};
