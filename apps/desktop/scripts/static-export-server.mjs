/**
 * 静的 export (`out/`) を配る HTTP サーバ。
 *
 * `serve-static-export.mjs` (CSP など静的 export でしか意味を持たない e2e) と
 * `perf-probe.mjs` (本番ビルドの性能計測) の両方がこれを使う。配り方が 2 か所に分かれると
 * 「片方だけ古いビルドを配っていた」に気付けないので、実体は 1 つに保つ。
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

/**
 * 計測用ビルド (`NEXT_PUBLIC_SIGMA_PERF=1`) の目印。`next build` の出力先は 1 つしかないので、
 * perf 計測を回した後の `out/` には計測コードが載ったままになる。それを黙って e2e / CSP
 * スモークにかけると「アプリの実際の姿ではないもの」をテストしてしまうので、印を見て止める。
 */
export const PERF_BUILD_MARKER_FILE = ".sigma-perf-build";

export function hasPerfBuildMarker(outDir) {
  const marker = path.join(outDir, PERF_BUILD_MARKER_FILE);
  if (!existsSync(marker)) {
    return false;
  }
  const indexHtml = path.join(outDir, "index.html");
  if (!existsSync(indexHtml)) {
    return true;
  }
  // 通常ビルド (`electron:prepare`) で作り直した out/ では index.html の方が新しい。
  // その場合の印は前回の計測ビルドの残骸なので無視する — 印を消し忘れただけで
  // e2e が永久に止まる、という別の footgun を作らないため。
  return statSync(marker).mtimeMs >= statSync(indexHtml).mtimeMs;
}

const CONTENT_TYPES = new Map(Object.entries({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}));

/**
 * ビルド成果物がそろっているかを検査する。問題があればメッセージを返す (null なら健全)。
 * 古いビルドに対して回すと CSP e2e が静かに緑になるので、meta が焼き込まれているかまで見る。
 *
 * `expectPerfBuild` は perf 計測の実行系だけが真にする。既定 (false) では、計測用ビルドが
 * 残っていること自体をエラーにする。
 */
export function checkStaticExport(outDir, rebuildHint, { expectPerfBuild = false } = {}) {
  if (!existsSync(path.join(outDir, "index.html"))) {
    return `${path.basename(outDir)}/ がありません。先に \`${rebuildHint}\` を実行してください。`;
  }
  if (!readFileSync(path.join(outDir, "index.html"), "utf8").includes("Content-Security-Policy")) {
    return `${path.basename(outDir)}/index.html に CSP の meta がありません。\`${rebuildHint}\` で再ビルドしてください。`;
  }
  const perfBuild = hasPerfBuildMarker(outDir);
  if (perfBuild && !expectPerfBuild) {
    return `${path.basename(outDir)}/ は性能計測用ビルド (NEXT_PUBLIC_SIGMA_PERF=1) です。`
      + ` 計測コードが載ったままなので、そのまま e2e / CSP スモークにかけてはいけません。`
      + ` \`${rebuildHint}\` で作り直してください。`;
  }
  if (!perfBuild && expectPerfBuild) {
    return `${path.basename(outDir)}/ は性能計測用ビルドではありません。\`${rebuildHint}\` で作り直してください。`;
  }
  return null;
}

function resolveFile(outDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = path.normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = path.join(outDir, relative);
  // `startsWith(outDir)` だけだと `out` の隣に `output/` があるときに素通りする。
  // 区切り文字まで含めて比較する。
  if (candidate !== outDir && !candidate.startsWith(`${outDir}${path.sep}`)) {
    return null;
  }
  for (const file of [candidate, `${candidate}.html`, path.join(candidate, "index.html")]) {
    if (existsSync(file) && statSync(file).isFile()) {
      return file;
    }
  }
  return null;
}

/**
 * `out/` を空きポートで配る。`assetPrefix: "./"` の静的 export なので、サブパスではなく
 * ルートで配る必要がある。
 */
export function startStaticExportServer(outDir) {
  const server = createServer((request, response) => {
    const file = resolveFile(outDir, request.url ?? "/");
    if (!file) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}
