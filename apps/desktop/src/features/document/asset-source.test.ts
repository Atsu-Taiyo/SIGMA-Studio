import { describe, expect, it } from "vitest";

import {
  isAllowedOverlayAssetSource,
  normalizeOverlayAssetSource,
  SUPPORTED_OVERLAY_IMAGE_MIME_TYPES,
} from "./asset-source";

/**
 * 図形アセットの `src` は `<img src>` と、SVG 書き出し (= 印刷 / PDF) の `<image href>` に
 * そのまま入る。`file:///…` を指した教材を開かせるだけで、被害者のローカルファイルが画面に出て
 * **PDF にも焼き込まれる** — 作った worksheet を返す運用ならそれがそのまま外へ出る。
 *
 * CSP では塞げない: WI-6 の実機計測どおり、`file://` オリジンでの `'self'` は
 * **ディスク上の任意のファイル**に一致する (`img-src 'self' data: blob:` を通ってしまう)。
 */

describe("isAllowedOverlayAssetSource", () => {
  it("refuses to read anything off the victim's disk", () => {
    for (const src of [
      "file:///Users/victim/Desktop/private.png",
      "file://localhost/etc/passwd",
      "/Users/victim/Desktop/private.png",
      "\\\\attacker\\share\\probe.png",
    ]) {
      expect(isAllowedOverlayAssetSource(src), src).toBe(false);
    }
  });

  it("refuses anything that phones home", () => {
    // 教材を開いた瞬間に取得が走るので、開封通知と IP 漏洩になる。
    for (const src of [
      "https://attacker.example/beacon.png",
      "http://attacker.example/beacon.png",
      "//attacker.example/beacon.png",
      "blob:https://attacker.example/1234",
    ]) {
      expect(isAllowedOverlayAssetSource(src), src).toBe(false);
    }
  });

  it("refuses schemes that execute or smuggle", () => {
    for (const src of [
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/png",
      "data:;base64,AAAA",
      "",
      "   ",
    ]) {
      expect(isAllowedOverlayAssetSource(src), JSON.stringify(src)).toBe(false);
    }
  });

  it("accepts every form the app itself produces", () => {
    // 貼り付け / ドロップは `FileReader.readAsDataURL` なので必ず base64 の data URL。
    // 受け付ける MIME は `SUPPORTED_OVERLAY_IMAGE_MIME_TYPES` (= ファイルピッカーの accept) と同じ。
    for (const mimeType of SUPPORTED_OVERLAY_IMAGE_MIME_TYPES) {
      expect(isAllowedOverlayAssetSource(`data:${mimeType};base64,iVBORw0KGgo=`), mimeType).toBe(true);
    }
    // Storage asset 参照 (クラウド同期した画像)。
    expect(isAllowedOverlayAssetSource("sigma-doc-storage://asset_01H9ABCDEF")).toBe(true);
    // 他ツール由来の教材にある、パーセントエンコードされた SVG data URL。
    expect(isAllowedOverlayAssetSource("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E")).toBe(true);
    // 大文字の MIME や余分な空白でも落とさない (実データにありうる揺れ)。**返る値は検証済みの
    // 文字列** — 元の値を保存/描画すると下の「空白の食い違い」を突かれる。
    expect(normalizeOverlayAssetSource("  data:image/PNG;base64,iVBORw0KGgo=  "))
      .toBe("data:image/PNG;base64,iVBORw0KGgo=");
    // リポジトリ自身の fixture が使う形。落とすと画像が黙って消える。
    expect(isAllowedOverlayAssetSource("data:image/svg+xml;utf8,%3Csvg%2F%3E")).toBe(true);
    expect(isAllowedOverlayAssetSource("sigma-doc-storage://workspaces/a/remote.png")).toBe(true);
    expect(isAllowedOverlayAssetSource("sigma-doc-storage://logo.v2.png")).toBe(true);
    // 他ツール由来: パラメータ付き / 76 桁折り返しの base64。
    expect(isAllowedOverlayAssetSource("data:image/png;name=logo.png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isAllowedOverlayAssetSource("data:image/png;base64,iVBORw0KGgo=\niVBORw0KGgo=")).toBe(true);
  });

  it("keeps the raw-payload form to SVG only", () => {
    // ラスタ形式に生ペイロードの書き方は無い。広げると「MIME はラスタなのに中身は任意テキスト」
    // という値を通してしまう。
    expect(isAllowedOverlayAssetSource('data:image/png,x" onload=y')).toBe(false);
    expect(isAllowedOverlayAssetSource("data:image/jpeg,anything")).toBe(false);
  });

  it("refuses an image MIME the app never accepts", () => {
    // ここを広げると、対応していない形式が保存されて描画側で黙って壊れる。
    for (const src of ["data:image/gif;base64,R0lGOD==", "data:image/bmp;base64,Qk0="]) {
      expect(isAllowedOverlayAssetSource(src), src).toBe(false);
    }
  });

  it("refuses a source long enough to be a denial of service on its own", () => {
    expect(isAllowedOverlayAssetSource(`data:image/png;base64,${"A".repeat(60_000_000)}`)).toBe(false);
  });

  it("does not let a Unicode space turn a data URL into a relative file path", () => {
    // `String.prototype.trim()` は U+FEFF / U+00A0 / U+3000 など **URL パーサが空白として
    // 扱わない**文字まで落とす。真偽値だけ返して元の値を保存すると、「検証は data URL・
    // ブラウザには相対 URL」というずれになり、`file://` のレンダラを基準に解決されて
    // ローカルファイルを読み、PDF に焼き込まれる。
    for (const space of ["\uFEFF", "\u00A0", "\u3000", "\u2028", "\u205F"]) {
      const poisoned = `${space}data:image/png,../../../../Users/victim/Desktop/private.png`;
      const normalized = normalizeOverlayAssetSource(poisoned);

      expect(normalized, JSON.stringify(space)).not.toBe(poisoned);
      // ラスタ MIME に生ペイロードは無いので、そもそも受理しない。
      expect(normalized, JSON.stringify(space)).toBeNull();
    }
    // SVG の生ペイロードは受理するが、`..` を含むものは落とす。
    expect(normalizeOverlayAssetSource("\uFEFFdata:image/svg+xml,../../secret.png")).toBeNull();
    expect(normalizeOverlayAssetSource("data:image/svg+xml,%3Csvg%2F%3E")).toBe("data:image/svg+xml,%3Csvg%2F%3E");
  });
});
