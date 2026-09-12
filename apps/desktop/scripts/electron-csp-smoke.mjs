/**
 * `file://` オリジンでの CSP 実測。
 *
 * レンダラは `win.loadFile()` で `file://` を読む。Chromium は file: ドキュメントを不透明
 * オリジンとして扱うため **`'self'` が期待どおりに解決するかは静的 HTTP では測れない** —
 * `npm run test:e2e:export` は `http://127.0.0.1` を配るので、この 1 点だけが空白になる。
 * ここを埋めるための最小スモーク。
 *
 *   npm run electron:prepare
 *   npm run csp:smoke
 *
 * 期待: violations が空 (意図的な外部画像プローブを除く)、`appMounted` が true、
 * スタイルシートとインライン style が実際に効いていること、外部 URL 画像が落ちること。
 */
import { app, BrowserWindow } from "electron";
import path from "node:path";

import { hasPerfBuildMarker } from "./static-export-server.mjs";

const outDir = path.resolve(process.cwd(), process.argv[2] ?? "out");
// 計測用ビルド (NEXT_PUBLIC_SIGMA_PERF=1) は配布物と別物。黙って CSP を測らない。
if (hasPerfBuildMarker(outDir)) {
  console.error(
    `${outDir} は性能計測用ビルドです。\`npm run electron:prepare\` で作り直してから csp:smoke を回してください。`,
  );
  process.exit(2);
}
const violations = [];
const probeViolations = [];
let probing = false;
const consoleLines = [];

const PROBE_ORIGIN = "https://example.invalid";


app.on("ready", async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900 });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    consoleLines.push(`${level}: ${message}`);
    if (/content security policy/i.test(message)) {
      // プローブを撃ち始めたあとの violation は「期待される拒否」なので合否から除く。
      (probing ? probeViolations : violations).push(`${message.split("\n")[0]} (${sourceId}:${line})`);
    }
  });
  await win.loadFile(path.join(outDir, "index.html"));
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const probe = await win.webContents.executeJavaScript(`(() => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return {
      policy: meta ? meta.getAttribute("content") : null,
      origin: location.origin,
      stylesheets: document.styleSheets.length,
      inlineStyled: document.querySelectorAll('[style]').length,
      appMounted: Boolean(document.querySelector('.a4-page-sheet') || document.querySelector('[data-paged-surface-revision]')),
    };
  })()`);

  // ここから先は「ブロックされることを期待して撃つ」プローブ。
  probing = true;

  // 外部 URL 画像が本当に落ちるか (img-src の実利) を file:// で確認する。
  const remoteImageBlocked = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(false);
    img.onerror = () => resolve(true);
    img.src = "${PROBE_ORIGIN}/beacon.png";
    setTimeout(() => resolve(true), 2500);
  })`);

  // `<img onerror>` (注入経路として最も現実的な形) が `script-src-attr 'none'` で止まるか。
  const inlineHandlerBlocked = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    window.__inlineHandlerRan__ = false;
    const host = document.createElement("div");
    host.innerHTML = '<img src="data:," onerror="window.__inlineHandlerRan__ = true">';
    document.body.appendChild(host);
    setTimeout(() => resolve(window.__inlineHandlerRan__ !== true), 800);
  })`);

  const ok = violations.length === 0
    && Boolean(probe.policy)
    && probe.appMounted
    && probe.stylesheets > 0
    && probe.inlineStyled > 0
    && remoteImageBlocked
    && inlineHandlerBlocked;

  console.log(JSON.stringify({
    ok,
    probe,
    remoteImageBlocked,
    inlineHandlerBlocked,
    violations,
    probeViolations,
    consoleTail: consoleLines.slice(-8),
  }, null, 2));
  app.exit(ok ? 0 : 1);
});
