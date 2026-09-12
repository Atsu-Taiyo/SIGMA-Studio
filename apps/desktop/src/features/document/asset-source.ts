/**
 * 図形アセットの `src` として文書に入れてよい値の唯一の決定。
 *
 * `props.src` は編集画面の `<img src>` と、SVG 書き出し (= 印刷 / PDF) の `<image href>` へ
 * そのまま入る。したがって `file:///Users/<被害者>/Desktop/private.png` を指した教材を開かせる
 * だけで、被害者のローカルファイルが画面に描かれ **PDF にも焼き込まれる**。作った worksheet を
 * PDF で返す運用なら、それがそのまま外へ出る。`https://…` なら教材を開いた瞬間に取得が走るので
 * 開封通知と IP 漏洩になる。
 *
 * **CSP では塞げない**。WI-6 の実機計測どおり、`file://` オリジンでの `'self'` は
 * 「アプリのバンドル」ではなく **ディスク上の任意のファイル**に一致するため、
 * `img-src 'self' data: blob:` を素通りする。
 *
 * AI 書き込み経路には `isAllowedAiOverlayAssetSource` が、公開 viewer には `validateImageDataUrl`
 * が既にあり、**教材を開く経路にだけ同等のガードが無い**という非対称だった。ここはその穴を、
 * WI-2 と同じ正規化境界の流儀で埋める。
 *
 * `features/document` の **import 0 件の葉モジュール** として置く (`css-safety.ts` と同じ形)。
 * `lib/ai/` 側の判定を借りると依存の向きが逆流する (`features/document` は最下層)。
 */

/**
 * アプリが受け付ける画像 MIME。ファイルピッカーの `accept` と貼り付け / ドロップのフィルタが
 * これを使う (`lib/overlay-image-files.ts` は本モジュールを再輸出する)。公開 viewer の
 * `ValidatedImageDataUrl["mimeType"]` とも同じ集合。
 */
export const SUPPORTED_OVERLAY_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

/**
 * クラウド同期した画像の参照。実体は保存時に解決され、文書には ID しか残らない。
 * 文法は AI 側の門番 (`isAllowedAiOverlayAssetSource`) と **同じ集合**にする — こちらだけ狭いと、
 * AI が書けて保存もできた参照を開き直しで落とす (= 画像が黙って消える) ことになる。
 * 実データにはスラッシュを含む形 (`sigma-doc-storage://workspaces/a/remote.png`) もある。
 */
const STORAGE_REFERENCE = /^sigma-doc-storage:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

const SUPPORTED_MIME_ALTERNATION = SUPPORTED_OVERLAY_IMAGE_MIME_TYPES
  .map((mimeType) => mimeType.replace("+", "\\+"))
  .join("|");

/**
 * `data:<許可 MIME>[;param[=value]]*;base64,<base64>`。
 *
 * パラメータを 1 つも許さない書き方にすると、`;name=logo.png;base64,…` のような他ツール由来の
 * data URL を落としてしまう。base64 本体に空白を許すのは、MIME の 76 桁折り返しが入った
 * data URL が実在するため (どちらも「落とすと画像が黙って消える」side が重い)。
 */
const BASE64_DATA_URL = new RegExp(
  `^data:(?:${SUPPORTED_MIME_ALTERNATION})(?:;[A-Za-z0-9-]+(?:=[^;,]*)?)*;base64,[A-Za-z0-9+/=\\s]+$`,
  "i",
);

/**
 * パーセントエンコードされた SVG (`data:image/svg+xml,…` / `data:image/svg+xml;utf8,…`)。
 * **SVG 限定**にする — ラスタ形式に生ペイロードの書き方は無く、広げると「MIME はラスタなのに
 * 中身は任意テキスト」という値を通してしまう。
 */
const RAW_SVG_DATA_URL = /^data:image\/svg\+xml(?:;[A-Za-z0-9-]+(?:=[^;,]*)?)*,[^]+$/i;

/** 生ペイロードに `..` を許さない。万一この値が相対 URL として解決されても上へ辿れない。 */
const TRAVERSAL = /\.\./;

/**
 * これを超える `src` は文字列を持ち回るだけで重い。挿入側 (`createOverlayImageAsset`) に上限が
 * 無いので、ここを実データより低くすると「貼れたのに保存で消える」形の損失になる。
 * base64 は元データの約 1.34 倍なので、48MB ≒ 36MB の画像まで通る。
 */
const MAX_SOURCE_LENGTH = 48 * 1024 * 1024;

/**
 * 受け入れる場合は **検証した文字列そのもの** を返す。真偽値だけを返して呼び出し側が元の値を
 * 保存/描画すると、「検証した文字列」と「使う文字列」がずれる。
 *
 * これは実害のあるずれ: JS の `String.prototype.trim()` は U+FEFF / U+00A0 / U+3000 など
 * **URL パーサが空白として扱わない**文字まで落とす。そのため
 * `"\uFEFFdata:image/png,../../../../Users/victim/Desktop/private.png"` は
 * data URL として検証を通る一方、ブラウザにはスキームの無い**相対 URL**として渡り、
 * `file://` のレンダラを基準に解決されてローカルファイルを読む。
 */
export function normalizeOverlayAssetSource(src: unknown): string | null {
  if (typeof src !== "string") {
    return null;
  }
  const candidate = src.trim();
  if (!candidate || candidate.length > MAX_SOURCE_LENGTH) {
    return null;
  }
  const allowed = STORAGE_REFERENCE.test(candidate)
    || BASE64_DATA_URL.test(candidate)
    || (RAW_SVG_DATA_URL.test(candidate) && !TRAVERSAL.test(candidate));
  return allowed ? candidate : null;
}

/** 真偽値だけが要る所 (フィルタ) 用。**保存・描画する値はこれで決めないこと**。 */
export function isAllowedOverlayAssetSource(src: unknown): src is string {
  return normalizeOverlayAssetSource(src) !== null;
}
