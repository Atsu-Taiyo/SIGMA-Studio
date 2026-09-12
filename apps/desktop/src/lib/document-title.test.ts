import { describe, expect, it } from "vitest";
import { createTranslator, SUPPORTED_LOCALES } from "@/lib/i18n";

import { parseDocumentTitleInlineNodes } from "@/features/rendering/core";
import { createBlankDocument } from "@/lib/blank-document";
import {
  DEFAULT_DOCUMENT_TITLE,
  documentTitleInputValue,
  getFirstContentLineTitle,
  isDocumentTitleExplicit,
  normalizeDocumentTitleInlineNodes,
  normalizeDocumentTitleText,
  resolveDocumentTitle,
  resolveDocumentTitleContent,
} from "@/lib/document-title";
import type { SigmaDocument } from "@/types/sigma-doc";

describe("document-title", () => {
  it("uses the first written line when the document title is unfilled", () => {
    const document = withContent("無題の教材", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "  一次関数のまとめ  " }] },
    ]);

    expect(resolveDocumentTitle(document)).toBe("一次関数のまとめ");
    expect(getFirstContentLineTitle(document)).toBe("一次関数のまとめ");
    expect(documentTitleInputValue(document.metadata.title)).toBe("");
  });

  it("keeps an explicitly typed title ahead of the first content line", () => {
    const document = withContent("  手入力タイトル  ", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文先頭" }] },
    ]);

    expect(resolveDocumentTitle(document)).toBe("手入力タイトル");
    expect(documentTitleInputValue(document.metadata.title)).toBe("  手入力タイトル  ");
  });

  it("finds the first non-empty line through nested flow blocks", () => {
    const document = withContent("", [
      { type: "paragraph", id: "p_blank", children: [{ type: "text", text: "" }] },
      {
        type: "layoutSection",
        id: "layout_1",
        layout: { columnCount: 2 },
        children: [
          { type: "heading", id: "h_1", level: 1, children: [{ type: "text", text: "二次関数" }] },
        ],
      },
    ]);

    expect(resolveDocumentTitle(document)).toBe("二次関数");
  });

  it("falls back to the default title when the body is still empty", () => {
    expect(resolveDocumentTitle(createBlankDocument(""))).toBe(DEFAULT_DOCUMENT_TITLE);
  });

  // ユーザー報告そのもの:「1 行目が `\sum` だとタイトルが `$\sum` で止まる」。
  // 上限の切り出しが `$…$` の対を割ると閉じ `$` が消え、表示側は数式として読めなくなる。
  it("上限を超える数式が先頭にあっても導出タイトルが数式として読める", () => {
    const tex = `\\sum_{i=1}^{n}\\frac{i(i+1)}{2}${"+x".repeat(70)}`;
    expect(tex.length).toBeGreaterThan(160);
    const document = withContent("", [
      { type: "paragraph", id: "p_1", children: [{ type: "mathInline", id: "m_1", tex, display: "inline" }] },
    ]);

    const title = resolveDocumentTitle(document);

    expect(title).toBe(`$${tex}$`);
    expect(parseDocumentTitleInlineNodes(title)).not.toBeNull();
  });
});

describe("resolveDocumentTitleContent", () => {
  it("先頭行のテキストと数式をノード列のまま返す", () => {
    const document = withContent("", [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "次の和を求めよ " },
          { type: "mathInline", id: "m_1", tex: "\\sum_{i=1}^{n} i", display: "inline" },
        ],
      },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.text).toBe("次の和を求めよ $\\sum_{i=1}^{n} i$");
    expect(resolved.nodes).toEqual([
      { type: "text", text: "次の和を求めよ " },
      { type: "mathInline", id: "t1", tex: "\\sum_{i=1}^{n} i", display: "inline" },
    ]);
  });

  it("先頭行が数式だけならノードは数式 1 個", () => {
    const document = withContent("", [
      { type: "paragraph", id: "p_1", children: [{ type: "mathInline", id: "m_1", tex: "x^2", display: "inline" }] },
    ]);

    expect(resolveDocumentTitleContent(document).nodes).toEqual([
      { type: "mathInline", id: "t0", tex: "x^2", display: "inline" },
    ]);
  });

  // 往復パースなら「価格 $100 の問題 $x$ を解け」の `$100 の問題 $` を数式と読み違える。
  // ノード列を直接渡すので、数式は本文が持っている 1 個だけになる。
  it("本文テキストに素の $ があっても数式の位置がずれない", () => {
    const document = withContent("", [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "価格 $100 の問題 " },
          { type: "mathInline", id: "m_1", tex: "x", display: "inline" },
          { type: "text", text: " を解け" },
        ],
      },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.text).toBe("価格 $100 の問題 $x$ を解け");
    expect(resolved.nodes?.filter((node) => node.type === "mathInline")).toHaveLength(1);
  });

  it("上限を超える数式を途中で割らない", () => {
    const tex = "x".repeat(200);
    const document = withContent("", [
      { type: "paragraph", id: "p_1", children: [{ type: "mathInline", id: "m_1", tex, display: "inline" }] },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.nodes).toEqual([{ type: "mathInline", id: "t0", tex, display: "inline" }]);
    expect(resolved.text).toBe(`$${tex}$`);
  });

  it("上限に達した後ろの数式は入れない", () => {
    const document = withContent("", [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "あ".repeat(200) },
          { type: "mathInline", id: "m_1", tex: "x^2", display: "inline" },
        ],
      },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.nodes).toBeNull();
    expect(resolved.text).toBe("あ".repeat(160));
  });

  it("上限の手前までなら数式もその後ろのテキストも入る", () => {
    const document = withContent("", [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "あ".repeat(150) },
          { type: "mathInline", id: "m_1", tex: "x^2", display: "inline" },
          { type: "text", text: "い".repeat(20) },
        ],
      },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.text).toBe(`${"あ".repeat(150)}$x^2$${"い".repeat(5)}`);
  });

  it("先頭行の text に改行があれば最初の行だけを採る", () => {
    const document = withContent("", [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "  \n一次関数 " },
          { type: "mathInline", id: "m_1", tex: "y=ax+b", display: "inline" },
          { type: "text", text: "\n二次関数" },
        ],
      },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.text).toBe("一次関数 $y=ax+b$");
    expect(resolved.nodes).toEqual([
      { type: "text", text: "一次関数 " },
      { type: "mathInline", id: "t1", tex: "y=ax+b", display: "inline" },
    ]);
  });

  it("数式を含まない派生タイトルは nodes を持たない", () => {
    const document = withContent("", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "一次関数のまとめ" }] },
    ]);

    expect(resolveDocumentTitleContent(document)).toEqual({ text: "一次関数のまとめ", nodes: null });
  });

  it("空文書は既定タイトルでノードを持たない", () => {
    expect(resolveDocumentTitleContent(createBlankDocument(""))).toEqual({
      text: DEFAULT_DOCUMENT_TITLE,
      nodes: null,
    });
  });

  it("tex の内部の空白は畳まない", () => {
    const document = withContent("", [
      { type: "paragraph", id: "p_1", children: [{ type: "mathInline", id: "m_1", tex: "a  b", display: "inline" }] },
    ]);

    expect(resolveDocumentTitleContent(document).nodes).toEqual([
      { type: "mathInline", id: "t0", tex: "a  b", display: "inline" },
    ]);
  });

  // タイトルは常に 1 行。台帳・タブの title 属性・入力欄 (DOM が改行を落とす) の全部が
  // それを前提にしているので、tex の中の改行だけは空白へ均す (TeX では改行はただの空白)。
  it("tex の中の改行は行を割らずに空白へ均す", () => {
    const document = withContent("", [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "mathInline", id: "m_1", tex: "a\nb", display: "inline" },
          { type: "text", text: " のとき" },
        ],
      },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.text).toBe("$a b$ のとき");
    expect(resolved.nodes).toEqual([
      { type: "mathInline", id: "t0", tex: "a b", display: "inline" },
      { type: "text", text: " のとき" },
    ]);
  });

  it("本文の装飾はタイトルへ持ち込まない", () => {
    const document = withContent("", [
      {
        type: "heading",
        id: "h_1",
        level: 1,
        children: [
          { type: "text", text: "重要", marks: ["bold", "boxed"], color: "#ff0000", fontSize: 32 },
          { type: "mathInline", id: "m_1", tex: "x", display: "inline", marks: ["boxed"], fontSize: 32 },
        ],
      },
    ]);

    expect(resolveDocumentTitleContent(document).nodes).toEqual([
      { type: "text", text: "重要" },
      { type: "mathInline", id: "t1", tex: "x", display: "inline" },
    ]);
  });

  it("明示タイトルは表示時パースの結果を返し、保存値は変えない", () => {
    const document = withContent("二次関数 $x^2$ の復習", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文先頭" }] },
    ]);

    const resolved = resolveDocumentTitleContent(document);

    expect(resolved.text).toBe("二次関数 $x^2$ の復習");
    expect(resolved.nodes).toEqual(parseDocumentTitleInlineNodes("二次関数 $x^2$ の復習"));
    expect(document.metadata.title).toBe("二次関数 $x^2$ の復習");
  });

  it("数式の無い明示タイトルは nodes を持たない", () => {
    const document = withContent("  手入力タイトル  ", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文先頭" }] },
    ]);

    expect(resolveDocumentTitleContent(document)).toEqual({ text: "手入力タイトル", nodes: null });
  });

  it("fallback は明示タイトルが無く本文も空のときだけ効く", () => {
    expect(resolveDocumentTitleContent(createBlankDocument(""), "  サンプル教材  ")).toEqual({
      text: "サンプル教材",
      nodes: null,
    });
  });
});

// 「2 つの真実を作らない」の門番。文字列の面 (台帳・ファイル名・検索・MCP・AI) は
// これまでどおり `resolveDocumentTitle` を呼び続ける。
describe("resolveDocumentTitle と resolveDocumentTitleContent().text は常に一致する", () => {
  const documents: Array<[string, SigmaDocument]> = [
    ["空文書", createBlankDocument("")],
    ["明示タイトル", withContent("  手入力タイトル  ", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文先頭" }] },
    ])],
    ["数式付きの明示タイトル", withContent("二次関数 $x^2$ の復習", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文先頭" }] },
    ])],
    ["派生 (テキストのみ)", withContent("", [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "  一次関数のまとめ  " }] },
    ])],
    ["派生 (数式付き)", withContent("", [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: "次の和 " },
          { type: "mathInline", id: "m_1", tex: "\\sum_{i=1}^{n} i", display: "inline" },
        ],
      },
    ])],
    ["派生 (上限超えの数式)", withContent("", [
      { type: "paragraph", id: "p_1", children: [{ type: "mathInline", id: "m_1", tex: "x".repeat(200), display: "inline" }] },
    ])],
    ["派生 (リストの入れ子)", withContent("", [
      {
        type: "list",
        id: "l_1",
        listType: "bullet",
        items: [
          { type: "listItem", id: "li_1", children: [{ type: "text", text: "" }], nested: [
            {
              type: "list",
              id: "l_2",
              listType: "bullet",
              items: [
                { type: "listItem", id: "li_2", children: [{ type: "mathInline", id: "m_1", tex: "x^2", display: "inline" }] },
              ],
            },
          ] },
        ],
      },
    ])],
  ];

  it.each(documents)("%s", (_label, document) => {
    expect(resolveDocumentTitle(document)).toBe(resolveDocumentTitleContent(document).text);
  });
});

describe("normalizeDocumentTitleText", () => {
  it("最初の非空行だけを採る", () => {
    expect(normalizeDocumentTitleText("\n  \na\nb")).toBe("a");
  });

  it("前後の空白を落とし連続空白を 1 個に畳む", () => {
    expect(normalizeDocumentTitleText("  x   y  ")).toBe("x y");
  });

  it("上限で切る", () => {
    expect(normalizeDocumentTitleText("a".repeat(200))).toBe("a".repeat(160));
  });

  it("中身が無ければ null", () => {
    expect(normalizeDocumentTitleText("   ")).toBeNull();
    expect(normalizeDocumentTitleText("")).toBeNull();
    expect(normalizeDocumentTitleText(null)).toBeNull();
    expect(normalizeDocumentTitleText(undefined)).toBeNull();
  });
});

describe("normalizeDocumentTitleInlineNodes", () => {
  it("グリフの無いノードだけの行は飛ばす", () => {
    expect(normalizeDocumentTitleInlineNodes([
      { type: "text", text: "  " },
      { type: "mathInline", id: "m_1", tex: "  ", display: "inline" },
      { type: "text", text: "\n本題" },
    ])).toEqual([{ type: "text", text: "本題" }]);
  });

  it("数式に挟まれた空白は残す", () => {
    expect(normalizeDocumentTitleInlineNodes([
      { type: "mathInline", id: "m_1", tex: "a", display: "inline" },
      { type: "text", text: "   " },
      { type: "mathInline", id: "m_2", tex: "b", display: "inline" },
    ])).toEqual([
      { type: "mathInline", id: "t0", tex: "a", display: "inline" },
      { type: "text", text: " " },
      { type: "mathInline", id: "t2", tex: "b", display: "inline" },
    ]);
  });

  it("何も無ければ null", () => {
    expect(normalizeDocumentTitleInlineNodes([])).toBeNull();
    expect(normalizeDocumentTitleInlineNodes([{ type: "text", text: "" }])).toBeNull();
  });
});

function withContent(title: string, content: SigmaDocument["content"]): SigmaDocument {
  return {
    ...createBlankDocument(title),
    metadata: { title },
    content,
  };
}

/**
 * D3 で新規文書の題名は**作成時点の UI 言語**で焼かれる。訳文を「既定題名かどうか」の
 * 判定に使う以上、比較は 1 言語では足りない。日本語だけと比べていると、英語 UI で
 * 作った文書が「明示的に題名を付けた」扱いになり、**本文 1 行目からの題名導出が
 * 止まる** (WI-9 のセキュリティレビュー指摘)。
 */
describe("isDocumentTitleExplicit across locales", () => {
  it("treats the untitled placeholder of every locale as not explicit", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const placeholder = createTranslator(locale, "workspace")("untitledMaterial") as unknown as string;
      expect(isDocumentTitleExplicit(placeholder), `${locale}: ${placeholder}`).toBe(false);
    }
  });

  it("still treats a real title as explicit", () => {
    expect(isDocumentTitleExplicit("二次関数の確認")).toBe(true);
    expect(isDocumentTitleExplicit("Quadratic functions")).toBe(true);
  });

  it("keeps deriving the title from the body for a document created in English", () => {
    // 英語 UI で作った空文書は "Untitled material" が焼かれる。ここが explicit だと
    // 判定されると、本文を書いても題名が既定のまま固まる。
    const english = createTranslator("en", "workspace")("untitledMaterial") as unknown as string;
    expect(english).not.toBe(DEFAULT_DOCUMENT_TITLE);
    expect(isDocumentTitleExplicit(english)).toBe(false);
  });
});
