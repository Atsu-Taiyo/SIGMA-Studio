import type {
  InlineNode,
  ListItemNode,
  ProblemAreaBlock,
  SigmaBlock,
} from "@/features/document";

export type BlockStyleTarget = SigmaBlock | ProblemAreaBlock | ListItemNode;

export function convertBlockStyle(
  node: BlockStyleTarget,
  style: string,
): BlockStyleTarget {
  // 段落スタイルの「本文」でもコードは解除できる。ツールバーのコードボタンと同じ結果で、
  // 押せるのに何も起きないコントロールを残さないため。
  if (style === "paragraph" && node.type === "codeBlock") {
    return {
      type: "paragraph",
      id: node.id,
      children: node.children,
      pagination: node.pagination,
      spaceAfterPx: node.spaceAfterPx,
    };
  }

  if (style === "paragraph" && node.type === "section") {
    return {
      type: "paragraph",
      id: node.id,
      children: [{ type: "text", text: node.title }],
      align: node.align,
      lineHeight: node.lineHeight,
      pagination: node.pagination,
      spaceAfterPx: node.spaceAfterPx,
    };
  }

  if (style === "paragraph" && node.type === "heading") {
    return {
      type: "paragraph",
      id: node.id,
      children: node.children,
      align: node.align,
      lineHeight: node.lineHeight,
      pagination: node.pagination,
      spaceAfterPx: node.spaceAfterPx,
    };
  }

  if (
    (style === "h1" || style === "h2" || style === "h3")
    && node.type === "section"
  ) {
    if (style === "h1") {
      return node;
    }

    const level = Number(style.slice(1)) as 2 | 3;
    return {
      type: "heading",
      id: node.id,
      level,
      children: [{ type: "text", text: node.title }],
      align: node.align,
      lineHeight: node.lineHeight,
      pagination: node.pagination,
      spaceAfterPx: node.spaceAfterPx,
    };
  }

  if (
    (style === "h1" || style === "h2" || style === "h3")
    && (node.type === "paragraph" || node.type === "heading")
  ) {
    const level = Number(style.slice(1)) as 1 | 2 | 3;
    return {
      type: "heading",
      id: node.id,
      level,
      children: withoutInlineFontSize(node.children),
      align: node.align,
      lineHeight: node.lineHeight,
      pagination: node.pagination,
      spaceAfterPx: node.spaceAfterPx,
    };
  }

  return node;
}

/**
 * 見出しへ変換するときに run の文字サイズ指定を落とす。
 *
 * `fontSize` は `<span style="font-size:Npt">` として出るので、見出しレベルの CSS には
 * 必ず勝つ。落とさないと「見出し1 も 2 も 3 も同じ大きさ」になり、ツールバーからは
 * 解除する手立てもない (文字サイズの選択肢に「自動」を足したのはそのため)。
 * 色・フォント・太字などの直接指定はそのまま残す — 大きさだけが見出しレベルの領分。
 */
function withoutInlineFontSize(children: InlineNode[]): InlineNode[] {
  if (!children.some((child) => child.fontSize !== undefined)) {
    // 指定が無ければ配列ごとそのまま返す (呼び出し側は identity で「変わっていない」を見る)。
    return children;
  }
  return children.map((child) => {
    if (child.fontSize === undefined) {
      return child;
    }
    const next = { ...child };
    delete next.fontSize;
    return next;
  });
}
