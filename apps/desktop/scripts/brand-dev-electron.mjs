#!/usr/bin/env node
// 開発実行 (`electron .`) 時のアプリ名とアイコンを Sigma Studio に揃える。
//
// macOS のメニューバー左上（アプリメニュー）のタイトルは、**実行中の .app バンドルの
// CFBundleName** から取られる。`app.setName()` も `Menu.buildFromTemplate` の
// 先頭項目の label も、この表示には効かない（macOSが無視する）。
// 開発実行では node_modules の Electron.app がそのまま起動するため、何もしないと
// メニューバーに "Electron" と出る。パッケージ版は electron-builder が productName を
// Info.plist に書き込むので、この問題は開発実行だけで起きる。
//
// あわせて Electron.app のバンドルアイコンも差し替える。`app.dock.setIcon()` は
// 起動後にしか効かないので、置き換えないと起動直後の一瞬だけ Electron のロゴが出る。
//
// node_modules を書き換えるが、Electron.app の ad-hoc 署名は実行ファイルのみを対象と
// しており（`codesign -dv` が `Info.plist=not bound` / `Sealed Resources=none`）、
// Info.plist と Resources の差し替えでは署名は壊れない。再署名は不要。
//
// 冪等。macOS 以外、または Electron.app が見つからない場合は何もしない。
// 失敗しても開発起動そのものは止めない（警告だけ出す）。
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DESKTOP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveProductName() {
  try {
    const config = require(path.join(DESKTOP_DIR, "electron-builder.config.cjs"));
    if (typeof config.productName === "string" && config.productName.trim()) {
      return config.productName.trim();
    }
  } catch {
    // 署名関連の環境変数チェックで throw することがある。名前はフォールバックで足りる。
  }
  return "Sigma Studio";
}

function resolveElectronAppBundle() {
  // electron パッケージの main は実行ファイルへのパス文字列を返す:
  //   .../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
  const executable = require("electron");
  if (typeof executable !== "string") {
    return null;
  }
  const bundle = path.resolve(executable, "..", "..", "..");
  return bundle.endsWith(".app") && existsSync(bundle) ? bundle : null;
}

function readPlistString(plistPath, key) {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", plistPath], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function writePlistString(plistPath, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plistPath], { stdio: "pipe" });
}

function main() {
  if (process.platform !== "darwin") {
    return;
  }

  const bundle = resolveElectronAppBundle();
  if (!bundle) {
    console.warn("[brand] Electron.app が見つからないため、開発用アプリ名の設定をスキップしました。");
    return;
  }

  const productName = resolveProductName();
  const plistPath = path.join(bundle, "Contents", "Info.plist");
  const changed = [];

  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    if (readPlistString(plistPath, key) !== productName) {
      writePlistString(plistPath, key, productName);
      changed.push(key);
    }
  }

  const sourceIcns = path.join(DESKTOP_DIR, "build", "icon.icns");
  const bundleIcns = path.join(bundle, "Contents", "Resources", "electron.icns");
  if (existsSync(sourceIcns) && existsSync(bundleIcns)) {
    const source = statSync(sourceIcns);
    const target = statSync(bundleIcns);
    if (source.size !== target.size || source.mtimeMs > target.mtimeMs) {
      copyFileSync(sourceIcns, bundleIcns);
      changed.push("electron.icns");
      // Finder / Dock はアイコンを積極的にキャッシュする。バンドルの mtime を進めて
      // キャッシュを無効化しないと、差し替えても古いアイコンが出続けることがある。
      execFileSync("touch", [bundle], { stdio: "pipe" });
    }
  }

  if (changed.length > 0) {
    console.log(`[brand] 開発用 Electron.app を "${productName}" に更新しました (${changed.join(", ")})。`);
  }
}

try {
  main();
} catch (error) {
  console.warn(`[brand] 開発用アプリ名の設定に失敗しました: ${error instanceof Error ? error.message : error}`);
}
