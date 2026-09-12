import { describe, expect, it } from "vitest";

import { parseDocumentTitleInlineNodes } from "./document-title-inline";

describe("parseDocumentTitleInlineNodes", () => {
  describe("数式として読む", () => {
    it("文中の $…$ を数式ノードに射影する", () => {
      expect(parseDocumentTitleInlineNodes("二次関数 $x^2$ の復習")).toEqual([
        { type: "text", text: "二次関数 " },
        { type: "mathInline", id: "t1", tex: "x^2", display: "inline" },
        { type: "text", text: " の復習" },
      ]);
    });

    it("タイトル全体が数式のときも射影する", () => {
      expect(parseDocumentTitleInlineNodes("$x^2$")).toEqual([
        { type: "mathInline", id: "t0", tex: "x^2", display: "inline" },
      ]);
    });

    it("複数区間をそれぞれ数式にする", () => {
      expect(parseDocumentTitleInlineNodes("$a$ と $b$")).toEqual([
        { type: "mathInline", id: "t0", tex: "a", display: "inline" },
        { type: "text", text: " と " },
        { type: "mathInline", id: "t2", tex: "b", display: "inline" },
      ]);
    });

    it("日本語を含んでもバックスラッシュがあれば数式として扱う", () => {
      expect(parseDocumentTitleInlineNodes("$\\text{面積}=x^2$")).toEqual([
        { type: "mathInline", id: "t0", tex: "\\text{面積}=x^2", display: "inline" },
      ]);
    });

    it("大文字の線分名は英字が続いても数式として扱う", () => {
      expect(parseDocumentTitleInlineNodes("$AB = CD$")).toEqual([
        { type: "mathInline", id: "t0", tex: "AB = CD", display: "inline" },
      ]);
    });

    it("空白を挟まない英小文字の並びは変数の積として数式にする", () => {
      expect(parseDocumentTitleInlineNodes("$y = ax^2+bx+c$")).toEqual([
        { type: "mathInline", id: "t0", tex: "y = ax^2+bx+c", display: "inline" },
      ]);
    });

    // 以前は `<` `>` `&` を含む候補を「HTML を組み立てられる」として素の文字列へ落としていた。
    // 無害化は `renderMathHtml` の出口が引き受けるので (adapters/math-html.security.test.ts)、
    // ごく普通の数学であるこれらの文字を弾く理由は無い。
    it("不等号を含む数式を数式として射影する", () => {
      expect(parseDocumentTitleInlineNodes("範囲は $a < b$")).toEqual([
        { type: "text", text: "範囲は " },
        { type: "mathInline", id: "t1", tex: "a < b", display: "inline" },
      ]);
    });

    it("アンパサンドを含む整列環境も数式として射影する", () => {
      expect(parseDocumentTitleInlineNodes("$\\begin{aligned}x&=1\\end{aligned}$")).toEqual([
        { type: "mathInline", id: "t0", tex: "\\begin{aligned}x&=1\\end{aligned}", display: "inline" },
      ]);
    });

    it("HTML を含む tex も数式として射影する (無害化は描画の出口が引き受ける)", () => {
      expect(parseDocumentTitleInlineNodes("$\\text{<img src=x onerror=alert(1)>}$")).toEqual([
        { type: "mathInline", id: "t0", tex: "\\text{<img src=x onerror=alert(1)>}", display: "inline" },
      ]);
    });
  });

  describe("数式にしない (null を返す)", () => {
    it("数式を含まない既存タイトルは素の文字列のままにする", () => {
      expect(parseDocumentTitleInlineNodes("一次関数のまとめ")).toBeNull();
    });

    it("対にならない $ は数式の開始にしない", () => {
      expect(parseDocumentTitleInlineNodes("価格は $100 です")).toBeNull();
    });

    it("日本語の散文がバックスラッシュ無しで挟まれた $ は数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("セール $100 と $200")).toBeNull();
    });

    it("英語の散文がバックスラッシュ無しで挟まれた $ も数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("Sale $100 and $200")).toBeNull();
    });

    it("本文先頭行由来のタイトルで素の $ が数式に食い込む場合は数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("Cost $5 for $x$ items")).toBeNull();
    });

    it("区切りの内側が空の $ は文字を落とさないよう数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("半角 $ $ と $x$")).toBeNull();
    });

    it("元の文字列を復元できない書き方 ($ の内側の空白) は数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("面積 $ x^2 $")).toBeNull();
    });

    it("ディスプレイ数式の $$ は素の文字列のまま表示する", () => {
      expect(parseDocumentTitleInlineNodes("面積 $$x^2$$")).toBeNull();
    });

    // 入口フィルタ撤去後の穴埋め。`100<` のように片側の項が無い区間は「値段の $ を区切りだと
    // 読み違えた」印なので、そのまま数式にすると画面から `$` が黙って消える。
    it("片側の項が無い区間 (セール $100<$200) は数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("セール $100<$200")).toBeNull();
      expect(parseDocumentTitleInlineNodes("Sale $100<$200")).toBeNull();
      expect(parseDocumentTitleInlineNodes("A $5+$3")).toBeNull();
    });

    it("空の数式は数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("空の $$")).toBeNull();
    });

    it("エスケープされた \\$ は区切りにしない", () => {
      expect(parseDocumentTitleInlineNodes("値段は \\$5 です")).toBeNull();
    });

    it("全角の ＄ は区切りにしない", () => {
      expect(parseDocumentTitleInlineNodes("全角 ＄x^2＄")).toBeNull();
    });

    it("空文字列は数式にしない", () => {
      expect(parseDocumentTitleInlineNodes("")).toBeNull();
    });
  });

  describe("端の挙動", () => {
    it("タイトル長の上限で $…$ が途中で切れても壊れない", () => {
      expect(parseDocumentTitleInlineNodes("二次関数 $x^")).toBeNull();
    });

    it("同じ入力には同一の配列参照を返す (memo が効く保証)", () => {
      const first = parseDocumentTitleInlineNodes("二次関数 $x^2$ の復習");
      const second = parseDocumentTitleInlineNodes("二次関数 $x^2$ の復習");
      expect(second).toBe(first);
    });

    it("数式化しても可視テキストは元の文字列から数式部分を除いたものに一致する", () => {
      const title = "二次関数 $x^2$ の復習";
      const nodes = parseDocumentTitleInlineNodes(title) ?? [];
      const restored = nodes
        .map((node) => (node.type === "text" ? node.text : `$${node.type === "mathInline" ? node.tex : ""}$`))
        .join("");
      expect(restored).toBe(title);
    });

    it("KaTeX や MathLive が解釈できない tex でも例外を投げず数式ノードにする", () => {
      expect(parseDocumentTitleInlineNodes("$\\notacommand{$")).toEqual([
        { type: "mathInline", id: "t0", tex: "\\notacommand{", display: "inline" },
      ]);
    });
  });
});
