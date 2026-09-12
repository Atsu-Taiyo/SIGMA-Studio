import { describe, expect, it } from "vitest";

import { DESKTOP_CONTENT_SECURITY_POLICY, buildContentSecurityPolicyMeta } from "./content-security-policy";

/**
 * CSP は **最後の砦**であって、WI-1〜3 の注入面対策の代替ではない。
 *
 * 静的 export の実測 (`npm run electron:prepare` 後の `out/index.html` / `out/print.html`) で、
 * Next 16 は RSC ペイロードを `<script>self.__next_f.push(...)</script>` として **1 ページあたり
 * 5〜6 個のインラインスクリプト**で吐く。したがって `script-src` には `'unsafe-inline'` が必須で、
 * **注入されたインライン `<script>` や `<img onerror>` は CSP では止まらない**。
 * ここで固定するのは「止められる範囲 (外部への送出・外部 URL 画像・object/frame/worker) を
 * 確実に止め続けること」と「防御にならないディレクティブを誤って足さないこと」。
 */

function directives(): Map<string, string> {
  return new Map(
    DESKTOP_CONTENT_SECURITY_POLICY.split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(" ");
        return separator < 0
          ? [entry, ""] as const
          : [entry.slice(0, separator), entry.slice(separator + 1)] as const;
      }),
  );
}

describe("desktop renderer Content-Security-Policy", () => {
  it("pins the policy that ships to the renderer", () => {
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toBe([
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-src 'none'",
      "child-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "media-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "webrtc 'block'",
    ].join("; "));
  });

  it("documents that style-src is required and is not a defense", () => {
    // 当初は「`style-src` を書かない」方針だったが、実測で `default-src 'self'` に
    // フォールバックしてインライン style が全面ブロックされ、描画が壊れた。つまり
    // `'unsafe-inline'` は選択の余地なく必須で、**CSS インジェクションに対する CSP の防御力は
    // ゼロ**。ここで固定するのは「その事実が消えないこと」。
    expect(directives().get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(directives().get("script-src")).toBe("'self' 'unsafe-inline'");
  });

  it("never allows eval", () => {
    // `new Function` / `eval(` は本番コードに 0 件。HMR (`next dev`) だけが要求するので、
    // meta を出すのは `NEXT_PUBLIC_TARGET === "desktop"` のときだけにしてある。
    expect(DESKTOP_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });

  it("narrows the fetch destinations and the passive load sinks", () => {
    // **「外部送出を塞ぐ」ではない**: トップレベルのナビゲーションは CSP の管轄外で、
    // `shell.openExternal` ブリッジもレンダラから直接呼べる。ここで固定するのは
    // 「スクリプトが起こす取得の宛先」と「受動的な読み込み先」が狭まっていること。
    const parsed = directives();
    // 外部への送出と、文書由来の外部 URL 画像による開封通知 / IP 漏洩を止めるのが本 WI の実利。
    expect(parsed.get("connect-src")).toBe("'self'");
    expect(parsed.get("img-src")).toBe("'self' data: blob:");
    // `webrtc` は `connect-src` の管轄外の egress 経路。
    expect(parsed.get("webrtc")).toBe("'block'");
    // 注入経路として最も現実的な `<img onerror>` は、`script-src` が `'unsafe-inline'` でも
    // `script-src-attr` で止まる。
    expect(parsed.get("script-src-attr")).toBe("'none'");
    for (const directive of ["object-src", "frame-src", "child-src", "worker-src", "manifest-src", "media-src", "base-uri", "form-action"]) {
      expect(parsed.get(directive), directive).toBe("'none'");
    }
  });

  it("emits the meta only for the desktop target", () => {
    // `next dev` の HMR は `eval` と `ws:` を要求する。開発サーバを壊さないため、meta は
    // 静的 export (デスクトップ) のときだけ出す。
    expect(buildContentSecurityPolicyMeta("desktop")).toEqual({
      content: DESKTOP_CONTENT_SECURITY_POLICY,
      httpEquiv: "Content-Security-Policy",
    });
    expect(buildContentSecurityPolicyMeta(undefined)).toBeNull();
    expect(buildContentSecurityPolicyMeta("web")).toBeNull();
  });
});
