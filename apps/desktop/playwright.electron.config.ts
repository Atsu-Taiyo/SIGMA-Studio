import { defineConfig } from "@playwright/test";

/**
 * Electron 実機スモーク専用の設定。**`playwright.config.ts` とは共有しない。**
 *
 * メニューの accelerator 所有権は **Electron を起動しないと 1 行も検証できない** —
 * Chromium 上の e2e はネイティブメニューが存在しないので、⌘Z を丸ごと奪われていても
 * 緑のままだった。それが今回のバグを長期化させた主因なので、検証手段を別に置く。
 *
 * `webServer` を持たないのが肝。ブラウザ側の設定は `next dev` を起こすが、Electron は
 * `out/index.html` を `file://` で読むので dev サーバは要らないし、起こすと port 3000 の
 * 取り合いになる。
 *
 * 実行前に `npm run electron:prepare` が要る (spec 側で存在確認して skip する)。
 * 既定の `npm test` / `npm run test:e2e` には**入れない** — 実ビルドを前提にするため。
 * CI に載せるなら Linux では `xvfb-run` が要る。
 */
export default defineConfig({
  testDir: "./tests/electron",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
