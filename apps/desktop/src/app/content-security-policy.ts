/**
 * レンダラの Content-Security-Policy。
 *
 * **配送は `<meta http-equiv>`**。レンダラは `win.loadFile()` で `file://` を読むので、
 * `session.webRequest.onHeadersReceived` でヘッダを足す方法は file: レスポンスに対して
 * Electron のバージョン依存かつ不透明オリジンの扱いが読めない。meta なら `layout.tsx` 1 箇所で
 * 静的 export の全ページに焼き込まれ、レンダラを読む 3 つの BrowserWindow (メイン /
 * AI レンダーブリッジ / PDF 書き出し) をまとめて覆える。
 * meta では `frame-ancestors` / `sandbox` / `report-uri` が無視されるが、いずれも今回使わない。
 * meta は `<head>` の末尾に出るため、自前バンドルの `<link>` / `<script src>` はポリシー適用前に
 * 解決される (どれも相対パスなので実害は無い)。
 *
 * **`file://` での `'self'` は「アプリのバンドル」ではなく「ディスク上の任意のファイル」を指す。**
 * Electron 実機で実測した (`scripts/electron-csp-smoke.mjs`): `out/` の外に置いた画像も
 * スクリプトも violation 0 件で読み込まれ、スクリプトは実行までされた。Chromium は file: 文書の
 * `'self'` を「scheme=file・host 空・path 空」として組み立てるため、あらゆる file: URL に一致する。
 * 取り込みフォント (`use-custom-fonts.ts` が userData 配下の `file://` を `@font-face` に流す) が
 * `font-src 'self'` のまま動き続けるのはこのため。
 *
 * したがって **この CSP が実際に止めるのは「スクリプトが起こすリモートへの取得」**であり、
 * ローカルファイルの読み込みは止まらない。送出についても万能ではない — トップレベルの
 * ナビゲーションは CSP の管轄外で、`preload` の `shell.openExternal` ブリッジはレンダラから
 * 直接呼べる。「egress が閉じた」ではなく「狭まった」が正しい。
 *
 * **注入面対策の代替ではない。** 静的 export の実測で、Next は RSC ペイロードを
 * `<script>self.__next_f.push(...)</script>` として 1 ページあたり 5〜6 個のインラインスクリプトで
 * 吐く。`output: "export"` + `file://` では nonce も使えず、ハッシュはビルドごとに変わるため列挙も
 * できない。よって `script-src` には `'unsafe-inline'` が必須で、**注入されたインライン
 * `<script>` は止まらない** (インラインの **イベントハンドラ属性** だけは `script-src-attr` で
 * 止める)。実際の防御は入口と出口の無害化 (overlay の CSS スカラー検証、数式サニタイザ) が担う。
 */
const DIRECTIVES: readonly (readonly [string, string])[] = [
  // file: では `'self'` = 任意のローカルファイル (上記参照)。実効はリモート取得の遮断。
  ["default-src", "'self'"],
  // 実測: `out/index.html` に 5 個、`out/print.html` に 6 個のインラインスクリプト。
  // `'unsafe-eval'` は入れない (`new Function` / `eval(` は本番コードに 0 件)。
  ["script-src", "'self' 'unsafe-inline'"],
  // インラインの **イベントハンドラ属性** (`<img onerror=...>`) はここで止まる。`'unsafe-inline'`
  // を script-src に置いても `script-src-attr` は継承しないので、注入経路として最も現実的な
  // この形だけは CSP で塞げる。出荷 HTML (`out/index.html` / `out/print.html`) のインライン
  // ハンドラ属性は実測 0 件なので、入れてもアプリ側のコストはゼロ。
  ["script-src-attr", "'none'"],
  // **防御ではない。** `default-src 'self'` を書くと style もそこにフォールバックし、実測で
  // インライン style が全面的にブロックされて描画が壊れた (MathLive / KaTeX の `style` 属性、
  // `PrintPreview` の `<style>` 要素、全図形の inline style)。つまり `'unsafe-inline'` は
  // 「書かない」選択ができず、**必ず必要**になる。
  // その結果、CSS インジェクション (画面被覆・UI 偽装) に対して CSP は**何の防御にもならない**。
  // 値の検証側 (`features/document/css-safety.ts`、`math-markup.ts`) が唯一の防御。
  ["style-src", "'self' 'unsafe-inline'"],
  // 図形画像は data URL、`EditorShell` の貼り付けは `URL.createObjectURL`。
  // 外部 URL を落とすことで、教材を開いただけの開封通知と IP 漏洩を止める。
  ["img-src", "'self' data: blob:"],
  // 実測: KaTeX / MathLive / M PLUS のフォントは相対パス (`../media/...`) で吐かれる。
  ["font-src", "'self'"],
  // `fetch` / `XHR` / `WebSocket` / `EventSource` / `sendBeacon` を同一オリジンに限る (本番コードの
  // 呼び出しは 0 件で、Next のクライアント遷移が同一オリジンの RSC ペイロードを取りに行くだけ)。
  // **これで「外部送出が塞がる」わけではない**: トップレベルのナビゲーションは CSP の管轄外
  // (`navigate-to` は CSP3 から削除された) で、`preload` の `shell.openExternal` ブリッジも
  // レンダラから直接呼べる。塞げるのは「スクリプトが起こす取得の宛先」だけ。
  ["connect-src", "'self'"],
  // `<object` / `<embed` / `<iframe` / `<form` / `new Worker` / `serviceWorker` /
  // `<video` / `<audio` はいずれも 0 件。
  ["object-src", "'none'"],
  ["frame-src", "'none'"],
  ["child-src", "'none'"],
  ["worker-src", "'none'"],
  ["manifest-src", "'none'"],
  ["media-src", "'none'"],
  ["base-uri", "'none'"],
  // `<form>` は `WorkspaceCreateDialog` に 1 件あるが、送信は `preventDefault()` で必ず止められて
  // いて実際のナビゲーションは起きない。将来ハンドラが先に throw しても外へ飛ばさないための蓋。
  ["form-action", "'none'"],
  // `connect-src` の管轄外で、データを外へ出せる唯一の残り経路。`RTCPeerConnection` の呼び出しは
  // 本番コードに 0 件なので無償で塞げる。
  ["webrtc", "'block'"],
];

export const DESKTOP_CONTENT_SECURITY_POLICY = DIRECTIVES
  .map(([directive, value]) => `${directive} ${value}`)
  .join("; ");

/**
 * `next dev` の HMR は `eval` と `ws:` を要求するので、meta を出すのはデスクトップ向けの
 * 静的 export のときだけにする。
 */
export function buildContentSecurityPolicyMeta(
  target: string | undefined,
): { content: string; httpEquiv: string } | null {
  return target === "desktop"
    ? { content: DESKTOP_CONTENT_SECURITY_POLICY, httpEquiv: "Content-Security-Policy" }
    : null;
}
