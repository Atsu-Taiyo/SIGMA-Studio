import {
  isSemver,
  readJson,
  syncPublicPackageVersions,
  writeJson,
} from "./sync-public-package-versions.mjs";

const USAGE = [
  "使い方: npm run version:set -- <patch|minor|major|x.y.z>",
  "",
  "Sigma Studio本体(ルート + apps/desktop)のversionを上げ、",
  "npmへ公開する @sigma-studio/viewer / @sigma-studio/editor と",
  "その依存・example・package-lockを同じversionへ揃えます。",
].join("\n");

function nextVersion(current, requested) {
  if (isSemver(requested)) {
    return requested;
  }
  const [major, minor, patch] = current.split(/[-+]/u)[0].split(".").map(Number);
  switch (requested) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`versionの指定が不正です: ${String(requested)}\n\n${USAGE}`);
  }
}

async function main() {
  const requested = process.argv[2];
  if (!requested || requested === "--help" || requested === "-h") {
    console.log(USAGE);
    process.exit(requested ? 0 : 1);
  }

  const rootPackage = await readJson("package.json");
  const desktopPackage = await readJson("apps/desktop/package.json");
  const currentVersion = rootPackage.version;

  if (!isSemver(currentVersion)) {
    throw new Error(`ルートpackage.jsonのversionがsemverではありません: ${String(currentVersion)}`);
  }

  const version = nextVersion(currentVersion, requested);
  if (version === currentVersion) {
    throw new Error(`すでに ${version} です。別のversionを指定してください。`);
  }

  rootPackage.version = version;
  desktopPackage.version = version;
  await Promise.all([
    writeJson("package.json", rootPackage),
    writeJson("apps/desktop/package.json", desktopPackage),
  ]);

  await syncPublicPackageVersions();
  // 書き換え結果が公開時のCIチェックを通ることをその場で確かめる。
  await syncPublicPackageVersions({ checkOnly: true });

  console.log([
    `Sigma Studio ${currentVersion} -> ${version} へ更新しました。`,
    "  package.json / apps/desktop/package.json",
    "  packages/viewer/package.json / packages/editor/package.json",
    "  examples/editor-react18/package.json / package-lock.json",
    "",
    "次の手順:",
    `  git commit -am "Bump version to ${version}"`,
    "  git push origin main",
    `  git tag v${version} && git push origin v${version}`,
    "",
    "タグ push でデスクトップ配布用のReleaseワークフローが走ります。npm公開は別途実行してください。",
  ].join("\n"));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
