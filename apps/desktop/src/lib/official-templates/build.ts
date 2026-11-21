import {
  ensurePageLayout,
  normalizeFrameSvg,
  type BoxBlockNode,
  type BoxFrameSpec,
  type BoxedVariant,
  type ColumnRule,
  type CustomFrame,
  type InlineNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ListNode,
  type OrderedListMarkerStyle,
  type PageLayout,
  type ParagraphNode,
  type ProblemAreaBlock,
  type ProblemNode,
  type RichBlock,
  type SigmaBlock,
  type SigmaDocument,
  type TextAlign,
} from "@/features/document";
import { wrapMathWithFont } from "@/lib/math-font-style";
import {
  BOOK_GOTHIC_FONT_FAMILY,
  BOOK_LATIN_SERIF_FONT_FAMILY,
  BOOK_MINCHO_FONT_FAMILY,
  BOOK_NUMERAL_FONT_FAMILY,
} from "@/lib/reference-book-box-styles";

/**
 * 公式テンプレートを組む小さな部品。テンプレートは SigmaDoc の JSON そのもので、ここは
 * 手書きの JSON を読みやすく書くためだけの関数を持つ。描画は通常の文書と同じ経路を通る。
 */

/** 書体は紙面に近い OS の書体を先に、同梱の書体を最後に置いた並び (`reference-book-box-styles`)。 */
export const MINCHO = BOOK_MINCHO_FONT_FAMILY;
export const GOTHIC = BOOK_GOTHIC_FONT_FAMILY;
export const NUMERAL = BOOK_NUMERAL_FONT_FAMILY;
export const LATIN_SERIF = BOOK_LATIN_SERIF_FONT_FAMILY;

export interface RunStyle {
  bold?: boolean;
  color?: string;
  background?: string;
  font?: string;
  /** pt */
  size?: number;
  boxed?: BoxedVariant;
  underline?: boolean;
}

/**
 * id は文書の中で一意なら良い。テンプレートは文書として複製されるか、素材の差し込み経路
 * (id を振り直す) を通るので、テンプレートごとの接頭辞つきの連番で決め打ちにする
 * (サムネイルのキャッシュと保存差分が実行ごとに揺れないように)。
 */
export interface OfficialTemplatePart {
  key: string;
  name: string;
  description: string;
  tags: string[];
  blocks: SigmaBlock[];
}

export interface OfficialTemplateBuild {
  document: SigmaDocument;
  /** テンプレートの中から、単体で挿せる部品 (公式素材になる)。 */
  parts: OfficialTemplatePart[];
}

export class TemplateBuilder {
  private next = 0;
  readonly parts: OfficialTemplatePart[] = [];
  /**
   * `mathFont`: 数式の書体。参考書・共通テストは Times 系なので、数式を `\htmlStyle{font-family:…}` で包む
   * (数式の書体メニューと同じ書き方。利用者がそのまま変えられる)。省略すると TeX の既定 (Computer Modern)。
   */
  constructor(private readonly prefix: string, private readonly base: RunStyle = {}, private readonly mathFont?: string) {}

  /** 組んだブロックを、そのまま公式素材としても登録する。 */
  part<T extends SigmaBlock>(key: string, meta: Omit<OfficialTemplatePart, "key" | "blocks">, block: T): T {
    this.parts.push({ key: `${this.prefix}_${key}`, ...meta, blocks: [block] });
    return block;
  }

  id(kind: string): string {
    this.next += 1;
    return `${this.prefix}_${kind}_${this.next}`;
  }

  /** 文字の run。既定の書体・大きさはテンプレートの本文に合わせる。 */
  text(text: string, style: RunStyle = {}): InlineNode {
    const merged = { ...this.base, ...style };
    const marks = [
      ...(merged.bold ? ["bold" as const] : []),
      ...(merged.underline ? ["underline" as const] : []),
      ...(merged.boxed ? ["boxed" as const] : []),
    ];
    return {
      type: "text",
      text,
      ...(marks.length > 0 ? { marks } : {}),
      ...(merged.boxed ? { boxedVariant: merged.boxed } : {}),
      ...(merged.color ? { color: merged.color } : {}),
      ...(merged.background ? { backgroundColor: merged.background } : {}),
      ...(merged.font ? { fontFamily: merged.font } : {}),
      ...(merged.size ? { fontSize: merged.size } : {}),
    };
  }

  math(tex: string, style: Pick<RunStyle, "color" | "size" | "bold"> = {}): InlineNode {
    const size = style.size ?? this.base.size;
    const color = style.color ?? this.base.color;
    const body = style.bold ? `\\boldsymbol{${tex}}` : tex;
    return {
      type: "mathInline",
      id: this.id("m"),
      tex: this.mathFont ? wrapMathWithFont(body, this.mathFont) : body,
      display: "inline",
      ...(color ? { color } : {}),
      ...(size ? { fontSize: size } : {}),
    };
  }

  /**
   * 文字列の中の `$...$` を数式に分けて run にする。テンプレートの本文はほとんどこれで書ける。
   */
  rich(source: string, style: RunStyle = {}): InlineNode[] {
    const nodes: InlineNode[] = [];
    source.split(/(\$[^$]+\$)/u).forEach((part) => {
      if (!part) return;
      if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
        nodes.push(this.math(part.slice(1, -1), style));
      } else {
        nodes.push(this.text(part, style));
      }
    });
    return nodes;
  }

  p(children: InlineNode[] | string, options: { align?: TextAlign; lineHeight?: string; spaceAfterPx?: number; breakBefore?: boolean } = {}): ParagraphNode {
    return {
      type: "paragraph",
      id: this.id("p"),
      children: typeof children === "string" ? this.rich(children) : children,
      ...(options.align ? { align: options.align } : {}),
      ...(options.lineHeight ? { lineHeight: options.lineHeight } : {}),
      ...(options.spaceAfterPx ? { spaceAfterPx: options.spaceAfterPx } : {}),
      ...(options.breakBefore ? { pagination: { break: true } } : {}),
    };
  }

  list(
    items: Array<InlineNode[] | string>,
    options: { markerStyle?: OrderedListMarkerStyle; start?: number; indentEm?: number; spaceAfterPx?: number; itemSpaceAfterPx?: number } = {},
  ): ListNode {
    return {
      type: "list",
      id: this.id("list"),
      listType: "ordered",
      ...(options.markerStyle ? { markerStyle: options.markerStyle } : {}),
      ...(options.start ? { start: options.start } : {}),
      ...(options.indentEm !== undefined ? { indentEm: options.indentEm } : {}),
      ...(options.spaceAfterPx ? { spaceAfterPx: options.spaceAfterPx } : {}),
      items: items.map((item) => ({
        type: "listItem" as const,
        id: this.id("li"),
        children: typeof item === "string" ? this.rich(item) : item,
        ...(options.itemSpaceAfterPx ? { spaceAfterPx: options.itemSpaceAfterPx } : {}),
      })),
    };
  }

  box(
    frame: BoxFrameSpec,
    blocks: SigmaBlock[],
    options: { styleId?: string; title?: InlineNode[]; subtitle?: InlineNode[]; spaceAfterPx?: number } = {},
  ): BoxBlockNode {
    return {
      type: "boxBlock",
      id: this.id("box"),
      styleId: options.styleId ?? (frame.custom ? "custom" : "fancybox"),
      ...(options.title ? { title: options.title } : {}),
      ...(options.subtitle ? { subtitle: options.subtitle } : {}),
      frame,
      blocks,
      ...(options.spaceAfterPx ? { spaceAfterPx: options.spaceAfterPx } : {}),
    };
  }

  /**
   * 解答の右の補足欄。区切りの縦線は段組みの罫ではなく、この欄の左罫で引く (補足の高さに合わせて
   * どの描画経路でも同じ位置に出る)。
   */
  sideNotes(blocks: SigmaBlock[], color: string): BoxBlockNode {
    return this.box({
      titleVisible: false,
      borderWidthPx: 0,
      borderColor: "transparent",
      borderStyle: "none",
      backgroundColor: "#ffffff",
      cornerStyle: "sharp",
      paddingPx: { top: 0, right: 0, bottom: 0, left: 8 },
      decorations: [{ type: "leftBar", widthPx: 0.8, color }],
    }, blocks, { styleId: "leftbar" });
  }

  /** 列の幅の比と区切り線を決めた段組み。`columns` の要素ごとに 1 段。 */
  columns(
    columns: LayoutSectionChildBlock[][],
    options: { widths?: number[]; gapMm?: number; rule?: ColumnRule; spaceAfterPx?: number } = {},
  ): LayoutSectionNode {
    const children = columns.flat();
    return {
      type: "layoutSection",
      id: this.id("cols"),
      layout: {
        columnCount: columns.length,
        ...(options.gapMm !== undefined ? { columnGapMm: options.gapMm } : {}),
        ...(options.rule ? { columnRule: options.rule } : {}),
        columnStartIds: columns.map((column) => column[0]!.id),
        ...(options.widths ? { columnWidths: options.widths } : {}),
      },
      children,
      ...(options.spaceAfterPx ? { spaceAfterPx: options.spaceAfterPx } : {}),
    };
  }

  /**
   * 問題ブロック。参考書・試験の見出しは問題文の側 (箱や段落) が描くので、自動の番号と
   * 導入文の行は既定で畳む。指針・解答は問題の「コメント」「解答」に入れ、生徒用の出力で
   * 隠せるようにする。
   */
  problem(parts: {
    lead?: ProblemAreaBlock[];
    prompt: ProblemAreaBlock[];
    hints?: ProblemAreaBlock[];
    solution?: ProblemAreaBlock[];
    breakBefore?: boolean;
    tags?: string[];
  }): ProblemNode {
    const hasLead = (parts.lead?.length ?? 0) > 0;
    return {
      type: "problem",
      id: this.id("problem"),
      tags: parts.tags ?? [],
      lead: parts.lead ?? [],
      prompt: parts.prompt,
      solution: parts.solution ?? [],
      hints: parts.hints ?? [],
      numbering: { enabled: false },
      ...(hasLead ? {} : { areaLayout: { lead: { hidden: true } } }),
      ...(parts.breakBefore ? { pagination: { break: true } } : {}),
    };
  }
}

/** 自作枠 (9分割の SVG) を、設定画面と同じ正規化を通して箱・問題の枠にする。 */
export function customFrame(svg: string, options: { slice: number; borderPx: number; paddingPx: number }): CustomFrame {
  const normalized = normalizeFrameSvg(svg);
  if (!normalized.ok) {
    throw new Error(`Official template frame is not a valid frame drawing: ${normalized.reason}`);
  }
  return {
    svg: normalized.svg,
    width: normalized.width,
    height: normalized.height,
    slice: options.slice,
    borderPx: options.borderPx,
    paddingPx: options.paddingPx,
  };
}

export interface TemplateDocumentInput {
  docId: string;
  title: string;
  pageLayout: Partial<PageLayout> & Pick<PageLayout, "pageSize" | "marginsMm">;
  content: SigmaBlock[];
}

export function templateDocument(input: TemplateDocumentInput): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: input.docId,
    metadata: { title: input.title, styleUnits: { fontSize: "pt" } },
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      ...input.pageLayout,
    } as PageLayout,
    content: input.content,
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    updatedAt: OFFICIAL_TEMPLATE_UPDATED_AT,
  });
}

/** 公式テンプレートの版。中身を変えたら進める (サムネイルのキャッシュのキーになる)。 */
export const OFFICIAL_TEMPLATE_UPDATED_AT = "2026-10-27T00:00:00.000Z";

export function runningRegion(blocks: RichBlock[], options: { heightMm?: number; offsetMm?: number; showOnFirstPage?: boolean } = {}) {
  return {
    enabled: true,
    heightMm: options.heightMm ?? 8,
    offsetMm: options.offsetMm ?? 6,
    showOnFirstPage: options.showOnFirstPage ?? true,
    blocks,
  };
}
