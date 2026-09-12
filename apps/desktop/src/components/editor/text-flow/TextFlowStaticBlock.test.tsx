import { readStylesheet as readFileSync } from "../../../../tests/helpers/read-stylesheet";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HeadingNumberingProvider } from "@/components/editor/text-flow/HeadingNumberingContext";
import { TextFlowStaticBlock } from "@/components/editor/text-flow/TextFlowStaticBlock";
import type { CodeBlockNode, HeadingNode, ListNode } from "@/features/document";

/**
 * `TextFlowStaticBlock` is the only static body renderer: print, PDF, the embedded viewer, and
 * thumbnails all go through it. The marker itself comes from `document-surface.css`, which the
 * viewer package `@import`s, so one attribute here plus one rule there covers every output.
 */
function orderedList(markerStyle?: ListNode["markerStyle"]): ListNode {
  return {
    type: "list",
    id: "list_1",
    listType: "ordered",
    ...(markerStyle ? { markerStyle } : {}),
    items: [{ type: "listItem", id: "li_1", children: [{ type: "text", text: "本文" }] }],
  };
}
function documentSurfaceCss(): string {
  return readFileSync(new URL("../../../app/document-surface.css", import.meta.url), "utf8");
}

/** 編集面だけのスタイル (ビューアや印刷が読まない側)。 */
function editorCss(): string {
  return readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
}

describe("TextFlowStaticBlock heading numbers", () => {
  it("keeps the derived number in the heading's accessible text", () => {
    const block: HeadingNode = {
      type: "heading",
      id: "heading_1",
      level: 2,
      children: [{ type: "text", text: "Methods" }],
    };
    const markup = renderToStaticMarkup(
      <HeadingNumberingProvider numbers={new Map([[block.id, "1.2"]])}>
        <TextFlowStaticBlock block={block} />
      </HeadingNumberingProvider>,
    );

    expect(markup).toContain('<span class="heading-number-prefix">1.2 </span>Methods');
    expect(markup).not.toContain('aria-hidden="true"');
  });
});

describe("TextFlowStaticBlock ordered list markers", () => {
  it("marks a paren list so print, PDF, and the viewer draw (1)", () => {
    expect(renderToStaticMarkup(<TextFlowStaticBlock block={orderedList("paren")} />))
      .toContain('data-list-marker="paren"');
  });

  it("leaves the plain decimal list without a marker attribute", () => {
    expect(renderToStaticMarkup(<TextFlowStaticBlock block={orderedList()} />))
      .not.toContain("data-list-marker");
  });

  it("styles the paren marker in the shared document surface stylesheet only", () => {
    const css = documentSurfaceCss();

    expect(css).toContain('ol[data-list-marker="paren"]');
    expect(css).toMatch(/@counter-style\s+sigma-doc-paren-decimal/);
  });

  it("renders alignment on the list-item body without moving the marker container", () => {
    const block = orderedList("paren");
    block.items[0].align = "center";
    const markup = renderToStaticMarkup(<TextFlowStaticBlock block={block} />);

    expect(markup).toContain('style="display:block;text-align:center"');
    expect(markup).not.toMatch(/<li[^>]*text-align:center/);
  });

  it("renders continuation paragraphs with independent alignment under one marker", () => {
    const block = orderedList("paren");
    block.items[0].continuations = [
      { type: "paragraph", id: "li_1_center", children: [{ type: "text", text: "中央" }], align: "center" },
      { type: "paragraph", id: "li_1_left", children: [{ type: "text", text: "左" }], align: "left" },
    ];
    const markup = renderToStaticMarkup(<TextFlowStaticBlock block={block} />);

    expect(markup).toContain('data-sigma-doc-id="li_1_center"');
    expect(markup).toContain('style="text-align:center"');
    expect(markup).toContain('data-sigma-doc-id="li_1_left"');
    expect(markup.match(/<li/g)).toHaveLength(1);
  });
});

/**
 * The marker takes the typography of the item's first run. The value is a derived one — nothing is
 * added to SigmaDoc — so it has to be emitted by every projection; this component covers print,
 * PDF, the viewer, and thumbnails at once.
 */
function styledList(
  items: Array<{ id: string; children: ListNode["items"][number]["children"]; nested?: ListNode[] }>,
): ListNode {
  return {
    type: "list",
    id: "list_1",
    listType: "ordered",
    markerStyle: "paren",
    items: items.map((item) => ({
      type: "listItem",
      id: item.id,
      children: item.children,
      ...(item.nested ? { nested: item.nested } : {}),
    })),
  };
}

describe("TextFlowStaticBlock list marker typography", () => {
  it("puts the first run's font on the li so ::marker can read it", () => {
    const markup = renderToStaticMarkup(<TextFlowStaticBlock block={styledList([
      { id: "li_1", children: [{ type: "text", text: "いち", fontFamily: '"Yu Mincho", serif', fontSize: 18 }] },
    ])} />);

    expect(markup).toContain("data-list-marker-typography");
    expect(markup).toContain("--sigma-doc-list-marker-font-family:&quot;Yu Mincho&quot;, serif");
    expect(markup).toContain("--sigma-doc-list-marker-font-size:18pt");
  });

  it("leaves an unstyled item alone so existing documents keep their computed values", () => {
    const markup = renderToStaticMarkup(<TextFlowStaticBlock block={styledList([
      { id: "li_1", children: [{ type: "text", text: "いち" }] },
    ])} />);

    expect(markup).not.toContain("data-list-marker-typography");
    expect(markup).not.toContain("--sigma-doc-list-marker");
  });

  it("takes only the size from a leading formula, never the family", () => {
    const markup = renderToStaticMarkup(<TextFlowStaticBlock block={styledList([{
      id: "li_1",
      children: [
        { type: "mathInline", id: "m_1", tex: "x^2", display: "inline", fontFamily: '"Yu Mincho", serif', fontSize: 18 },
      ],
    }])} />);

    expect(markup).toContain("--sigma-doc-list-marker-font-size:18pt");
    expect(markup).not.toContain("--sigma-doc-list-marker-font-family");
  });

  it("does not leak a styled parent's font into an unstyled nested item", () => {
    const markup = renderToStaticMarkup(<TextFlowStaticBlock block={styledList([{
      id: "li_1",
      children: [{ type: "text", text: "いち", fontFamily: '"Yu Mincho", serif' }],
      nested: [styledList([{ id: "li_1_1", children: [{ type: "text", text: "こ" }] }])],
    }])} />);

    // The child li must not carry the property; the CSS reset below is what stops the parent's
    // value from inheriting into it.
    expect(markup.match(/data-list-marker-typography/g)).toHaveLength(1);
  });
});

/**
 * The markup above is only half the behaviour: the attribute does nothing unless the shared
 * stylesheet reads it. These assert the rules the projection depends on, so a rename or a deleted
 * reset fails here instead of silently going back to "the marker ignores the font".
 */
describe("list marker typography stylesheet contract", () => {
  it("reads both custom properties from ::marker on the attribute-carrying li", () => {
    const css = documentSurfaceCss();
    const rule = /li\[data-list-marker-typography\]::marker\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(rule).toMatch(/font-family:\s*var\(--sigma-doc-list-marker-font-family,\s*inherit\)/);
    expect(rule).toMatch(/font-size:\s*var\(--sigma-doc-list-marker-font-size,\s*inherit\)/);
  });

  it("resets both custom properties on every list so they cannot inherit into a nested one", () => {
    const css = documentSurfaceCss();
    const rule = /:is\(ol,\s*ul\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(rule).toMatch(/--sigma-doc-list-marker-font-family:\s*initial/);
    expect(rule).toMatch(/--sigma-doc-list-marker-font-size:\s*initial/);
  });
});

describe("TextFlowStaticBlock code theme", () => {
  const darkCode: CodeBlockNode = {
    type: "codeBlock",
    id: "code_dark",
    language: "typescript",
    theme: "dark",
    children: [{ type: "text", text: "const answer = 42;", marks: ["bold"] }],
  };

  it("carries the code-only dark setting into print, PDF, viewer, and thumbnails", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock block={darkCode} classNames={{ code: "print-code" }} />,
    );

    expect(markup).toContain('class="print-code"');
    expect(markup).toContain('data-code-theme="dark"');
    expect(markup).toContain("font-weight:bold");
  });

  it("defines both backgrounds on the stable theme attribute rather than focus state", () => {
    const css = documentSurfaceCss();

    expect(css).toMatch(/\.print-code\s*\{[\s\S]*?background:\s*#f7f8fa/);
    expect(css).toMatch(/\.print-code\[data-code-theme="dark"\]\s*\{[\s\S]*?background:\s*#171717/);
    expect(css).not.toMatch(/\.print-code:(?:focus|focus-within)[^{]*\{[^}]*background:/);
  });
});

describe("TextFlowStaticBlock code fences", () => {
  it("does not print a wrapping markdown fence at the start of a JS code block", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock
        block={{
          type: "codeBlock",
          id: "code_js",
          language: "javascript",
          children: [{ type: "text", text: "const a = 1;" }],
        }}
        classNames={{ code: "print-code" }}
      />,
    );
    expect(plainCodeText(markup)).toBe("const a = 1;");
    expect(plainCodeText(markup).startsWith("```")).toBe(false);
  });

  it("drops an outer fence from stored code and keeps inner backticks", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock
        block={{
          type: "codeBlock",
          id: "code_fenced",
          language: "javascript",
          children: [{ type: "text", text: "```js\nconst fence = \"```\";\n```" }],
        }}
        classNames={{ code: "print-code" }}
      />,
    );
    expect(plainCodeText(markup)).toBe("const fence = \"```\";");
    expect(plainCodeText(markup).startsWith("```")).toBe(false);
  });

  it("drops a leading opening fence without a closing fence", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock
        block={{
          type: "codeBlock",
          id: "code_open",
          language: "javascript",
          children: [{ type: "text", text: "```asdasda\nasdasdasdsaadasdasdas" }],
        }}
        classNames={{ code: "print-code" }}
      />,
    );
    expect(plainCodeText(markup)).toBe("asdasda\nasdasdasdsaadasdasdas");
    expect(plainCodeText(markup).startsWith("```")).toBe(false);
  });
});

function plainCodeText(markup: string): string {
  return markup
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("TextFlowStaticBlock block space after", () => {
  it("puts the shared custom property on a paragraph", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock block={{ type: "paragraph", id: "p_1", children: [], spaceAfterPx: 24 }} />,
    );

    expect(markup).toContain("--sigma-doc-space-after:24px");
  });

  it("puts it on a list, where the editor writes it on the same ul/ol", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock block={{ ...orderedList(), spaceAfterPx: 24 }} />,
    );

    expect(markup).toContain("--sigma-doc-space-after:24px");
  });

  it("puts it on a divider", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock block={{ type: "divider", id: "d_1", spaceAfterPx: 24 }} />,
    );

    expect(markup).toContain("--sigma-doc-space-after:24px");
  });

  it("leaves an untouched block without the property", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock block={{ type: "paragraph", id: "p_2", children: [] }} />,
    );

    expect(markup).not.toContain("--sigma-doc-space-after");
  });

  it("does not draw it inside a framed block, where padding would stretch the frame", () => {
    const markup = renderToStaticMarkup(
      <TextFlowStaticBlock
        block={{ type: "quote", id: "q_1", blocks: [{ type: "paragraph", id: "q_p", children: [] }], spaceAfterPx: 24 }}
      />,
    );

    expect(markup).not.toContain("--sigma-doc-space-after");
  });

  it("adds the space as padding, so getBoundingClientRect (= pagination) sees it", () => {
    const css = documentSurfaceCss();
    // 出典は永続値 1 本きり。ドラッグ中もここは動かない (追従は平行移動が受け持つ)。
    const resolved = "var(--sigma-doc-space-after, 0px)";

    expect(css).toContain(`padding-bottom: ${resolved}`);
    // border-box の最小高にも、現在の行高と下余白の両方を含める。
    expect(css).toContain(`min-height: calc(1lh + ${resolved})`);
    // ドラッグ中の値を padding へ被せる 2 段目は廃止済み。復活させると pointermove ごとに
    // 寸法が変わり、ResizeObserver → 全体計測 → 再ページ割りの連鎖が戻る。
    expect(css).not.toContain("--sigma-doc-space-after-draft");
  });

  it("stops the variable from being inherited into a list's own items", () => {
    const css = documentSurfaceCss();
    const reset = css.match(/\.print-list > li \{[^}]*\}/)?.[0] ?? "";

    expect(reset).toContain("--sigma-doc-space-after: 0px");
    expect(reset).toContain("--sigma-doc-list-item-space-after: 0px");
  });

  it("draws list-item spacing once after owned content and before nested lists", () => {
    const css = documentSurfaceCss();
    const edgeRule = css.match(/\.print-list > li > :not\(ul, ol\):not\(:has\(~ :not\(ul, ol\)\)\) \{[^}]*\}/)?.[0] ?? "";

    expect(edgeRule).toContain("padding-bottom: var(--sigma-doc-list-item-space-after, 0px)");
    expect(css).not.toMatch(/\.print-list > li[^,{]*,[^{]*\{[^}]*padding-bottom: var\(--sigma-doc-space-after/);
  });

  it("moves the blocks below a dragged handle without changing any size", () => {
    // ドラッグ中の一時表示は編集面だけの話なので、共有の document surface には置かない
    // (ビューアや印刷にはこのクラスが出る経路が無い)。
    expect(documentSurfaceCss()).not.toContain("sigma-space-after-follower");

    const follower = editorCss().match(/\.sigma-space-after-follower \{[^}]*\}/)?.[0] ?? "";
    // 平行移動だけ。padding/margin/height を触った瞬間に紙面の寸法が変わり、ドラッグ中の
    // 再計測 → 再ページ割りの連鎖が戻る。
    expect(follower).toContain("transform: translateY(var(--sigma-doc-space-after-preview, 0px))");
    expect(follower).not.toMatch(/padding|margin|height/);
  });
});
