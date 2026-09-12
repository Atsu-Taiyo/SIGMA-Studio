import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function isSemver(version) {
  return typeof version === "string" && SEMVER.test(version);
}

export async function readJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

export async function writeJson(relativePath, value) {
  await writeFile(
    path.join(repositoryRoot, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

/**
 * Sigma Studio本体（ルート = apps/desktop）のversionを正本として、
 * npmへ公開するpackageとその依存・package-lockを揃える。
 */
export async function syncPublicPackageVersions({ checkOnly = false } = {}) {
  const rootPackage = await readJson("package.json");
  const desktopPackage = await readJson("apps/desktop/package.json");
  const publicVersion = rootPackage.version;

  if (!isSemver(publicVersion)) {
    throw new Error(`ルートpackage.jsonのversionがsemverではありません: ${String(publicVersion)}`);
  }
  if (desktopPackage.version !== publicVersion) {
    throw new Error([
      `Sigma Studio本体とルートのversionが一致していません: root=${publicVersion}, desktop=${desktopPackage.version}`,
      "個別に書き換えず `npm run version:set -- <patch|minor|major|x.y.z>` で上げてください。",
    ].join("\n"));
  }

  const viewerPackage = await readJson("packages/viewer/package.json");
  const editorPackage = await readJson("packages/editor/package.json");
  const examplePackage = await readJson("examples/editor-react18/package.json");
  const packageLock = await readJson("package-lock.json");

  const expected = [
    {
      label: "packages/viewer/package.json version",
      current: viewerPackage.version,
      apply: () => {
        viewerPackage.version = publicVersion;
      },
    },
    {
      label: "packages/editor/package.json version",
      current: editorPackage.version,
      apply: () => {
        editorPackage.version = publicVersion;
      },
    },
    {
      label: "EditorからViewerへのdependency",
      current: editorPackage.dependencies?.["@sigma-studio/viewer"],
      apply: () => {
        editorPackage.dependencies["@sigma-studio/viewer"] = publicVersion;
      },
    },
    {
      label: "React 18 exampleからEditorへのdependency",
      current: examplePackage.dependencies?.["@sigma-studio/editor"],
      apply: () => {
        examplePackage.dependencies["@sigma-studio/editor"] = publicVersion;
      },
    },
    {
      label: "package-lock ルートversion",
      current: packageLock.version,
      apply: () => {
        packageLock.version = publicVersion;
      },
    },
    {
      label: "package-lock ルートpackage version",
      current: packageLock.packages?.[""]?.version,
      apply: () => {
        packageLock.packages[""].version = publicVersion;
      },
    },
    {
      label: "package-lock Sigma Studio本体version",
      current: packageLock.packages?.["apps/desktop"]?.version,
      apply: () => {
        packageLock.packages["apps/desktop"].version = publicVersion;
      },
    },
    {
      label: "package-lock Viewer version",
      current: packageLock.packages?.["packages/viewer"]?.version,
      apply: () => {
        packageLock.packages["packages/viewer"].version = publicVersion;
      },
    },
    {
      label: "package-lock Editor version",
      current: packageLock.packages?.["packages/editor"]?.version,
      apply: () => {
        packageLock.packages["packages/editor"].version = publicVersion;
      },
    },
    {
      label: "package-lock EditorからViewerへのdependency",
      current: packageLock.packages?.["packages/editor"]?.dependencies?.["@sigma-studio/viewer"],
      apply: () => {
        packageLock.packages["packages/editor"].dependencies["@sigma-studio/viewer"] = publicVersion;
      },
    },
    {
      label: "package-lock exampleからEditorへのdependency",
      current: packageLock.packages?.["examples/editor-react18"]?.dependencies?.["@sigma-studio/editor"],
      apply: () => {
        packageLock.packages["examples/editor-react18"].dependencies["@sigma-studio/editor"] = publicVersion;
      },
    },
  ];

  const mismatches = expected.filter(({ current }) => current !== publicVersion);

  if (checkOnly) {
    if (mismatches.length > 0) {
      throw new Error([
        `公開packageのversionがSigma Studio ${publicVersion} と一致していません。`,
        ...mismatches.map(({ label, current }) => (
          `- ${label}: ${String(current)} -> ${publicVersion}`
        )),
        "`npm run version:sync` で揃えてからcommitしてください。",
      ].join("\n"));
    }
    return { publicVersion, changed: false, mismatches };
  }

  for (const item of mismatches) {
    item.apply();
  }

  if (mismatches.length > 0) {
    await Promise.all([
      writeJson("packages/viewer/package.json", viewerPackage),
      writeJson("packages/editor/package.json", editorPackage),
      writeJson("examples/editor-react18/package.json", examplePackage),
      writeJson("package-lock.json", packageLock),
    ]);
  }

  return { publicVersion, changed: mismatches.length > 0, mismatches };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const checkOnly = process.argv.includes("--check");
  try {
    const { publicVersion, changed } = await syncPublicPackageVersions({ checkOnly });
    if (checkOnly) {
      console.log(`公開packageのversionはSigma Studio ${publicVersion} と一致しています。`);
    } else {
      console.log(
        changed
          ? `公開packageと依存versionをSigma Studio ${publicVersion} へ同期しました。`
          : `公開packageはすでにSigma Studio ${publicVersion} と一致しています。`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
