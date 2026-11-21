import { inlineNodesToPlainText, type InlineNode, type SigmaBlock, type SigmaDocument } from "@/features/document";

/**
 * How the author builds a document, apart from how its sentences read: where problems go and how they are
 * numbered, what is put in a box, how headings are used, whether problems carry comments, the room left for
 * answers, and the order blocks come in. Every value is one of a fixed set, never text from a document.
 */
export interface LayoutUnit {
  id: string;
  /** Text blocks of this unit. It counts as the author's when one of them is the author's own writing. */
  fragments: string[];
  /** A vote about the document as a whole: it counts when most of the document is the author's own. */
  whole?: true;
  votes: Map<string, string>;
}
export interface LayoutProjection { units: LayoutUnit[]; outline: string }

/** The built-in box styles (`BUILTIN_BOX_STYLES`), and a frame the author drew. */
export const BOX_STYLE_IDS: readonly string[] = ["fancybox", "titlebox", "bandbox", "itembox", "splitbox", "theorembox", "tabbox", "tcolorbox", "tcolorbox-note",
  "doublebox", "shadebox", "leftbar", "dashedbox", "ruledbox", "screenbox", "ovalbox", "cornerbox",
  "chart-red-rei", "chart-red-reidai", "chart-red-juyo", "chart-blue-kihon",
  "focus-gold-reidai", "focus-gold-focus", "kyotsu-choices", "custom"];
export const PROBLEM_FRAME_IDS: readonly string[] = ["fancybox", "doublebox", "cornerbox", "custom"];
export const BOX_CATEGORIES = ["definition", "theorem", "point", "example", "summary", "answer", "problem"] as const;
export const LAYOUT_KINDS = ["heading", "text", "list", "quote", "code", "divider", "problem", "columns", "box"] as const;
const HEADING_SYMBOLS = "■□◆◇●○◎▼▶★☆";
export const MAX_SEQUENCE_KINDS = 6;
/** Blocks that may come before a repeated unit: a title, a subtitle, a box of formulas. */
export const MAX_SEQUENCE_LEAD = 3;
export const MAX_OUTLINE_LENGTH = 300;
/** Space under a problem that is room to write in, not just a gap between blocks. */
const ANSWER_SPACE_AFTER_PX = 40;
const SUBTITLE_MAX_LENGTH = 40;

const KIND: Record<SigmaBlock["type"], (typeof LAYOUT_KINDS)[number]> = {
  section: "heading", heading: "heading", paragraph: "text", list: "list", quote: "quote", codeBlock: "code",
  divider: "divider", problem: "problem", layoutSection: "columns", boxBlock: "box",
};
// Checked in this order: 例題 before 例, and a box titled 練習問題 is a problem box.
const BOX_TITLES: readonly (readonly [RegExp, (typeof BOX_CATEGORIES)[number]])[] = [
  [/定義|definition/iu, "definition"], [/定理|公式|性質|法則|命題|theorem|formula/iu, "theorem"],
  [/例題|練習|演習|問題|exercise|problem/iu, "problem"], [/ポイント|要点|コツ|ヒント|注意|補足|参考|point|hint|note|tip/iu, "point"],
  [/まとめ|整理|summary/iu, "summary"], [/解答|解説|略解|answer|solution/iu, "answer"], [/例|example/iu, "example"],
];
const COMMENT_TITLE = /ポイント|要点|コツ|ヒント|注意|補足|参考|point|hint|note|tip/iu;
const PROBLEM_LABELS: readonly (readonly [RegExp, string])[] = [
  [/^第\s?[0-9０-９]+\s?問/u, "daimon"], [/^問題?\s?[0-9０-９]+/u, "mon"], [/^【[0-9０-９]+】/u, "bracket"], [/^\[[0-9]+\]/u, "square"],
  [/^例題\s?[0-9０-９]*/u, "reidai"], [/^(?:練習|演習)(?:問題)?\s?[0-9０-９]*/u, "renshu"], [/^[0-9０-９]+[.．]/u, "dot"],
];
const HEADING_NUMBERS: readonly (readonly [RegExp, string])[] = [
  [/^第\s?[0-9０-９一二三四五六七八九十]+\s?章/u, "chapter"], [/^第\s?[0-9０-９一二三四五六七八九十]+\s?節/u, "section"], [/^§/u, "sign"],
  [/^[0-9]+[.-][0-9]+/u, "nested"], [/^[0-9０-９]+[.．]/u, "dot"], [/^[（(][0-9０-９]+[)）]/u, "paren"], [/^【.+】$/u, "bracket"],
];
const SUBQUESTION = /^(?:\(\d+\)|（[0-9０-９]+）|[①-⑳]|\[\d+\])/u;

type Inline = readonly InlineNode[];
const plain = (children: Inline | undefined) => inlineNodesToPlainText([...(children ?? [])]).trim();

/** Ids of the text blocks under these blocks, as `projectDocument` names them. */
function textIds(blocks: readonly SigmaBlock[], into: string[] = []): string[] {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": case "heading": case "section": into.push(block.id); break;
      case "boxBlock": into.push(`${block.id}:title`); textIds(block.blocks, into); break;
      case "quote": textIds(block.blocks, into); break;
      case "layoutSection": textIds(block.children, into); break;
      case "problem": for (const area of [block.lead, block.prompt, block.hints, block.solution]) textIds(area, into); break;
      case "list":
        for (const item of block.items) { into.push(item.id); textIds(item.continuations ?? [], into); textIds(item.nested ?? [], into); }
        break;
    }
  }
  return into;
}

/** The first line of text under these blocks, wherever it is put (in a box, a quote, columns, a list). */
function firstText(blocks: readonly SigmaBlock[]): string {
  for (const block of blocks) {
    const text = block.type === "paragraph" || block.type === "heading" ? plain(block.children) : block.type === "section" ? block.title.trim()
      : block.type === "list" ? block.items.map(item => plain(item.children) || firstText(item.continuations ?? []) || firstText(item.nested ?? [])).find(Boolean) ?? ""
      : block.type === "boxBlock" ? plain(block.title) || firstText(block.blocks) : block.type === "quote" ? firstText(block.blocks)
      : block.type === "layoutSection" ? firstText(block.children) : block.type === "codeBlock" ? plain(block.children) : "";
    if (text) return text;
  }
  return "";
}

const blank = (block: SigmaBlock) => block.type === "paragraph" && !plain(block.children);
const isCommentBox = (block: SigmaBlock | undefined) => block?.type === "boxBlock" && COMMENT_TITLE.test(plain(block.title));
const match = (table: readonly (readonly [RegExp, string])[], text: string) => table.find(([pattern]) => pattern.test(text))?.[1];

/**
 * The order of block kinds, with runs of one kind counted once. A sequence that repeats a unit is written
 * as that unit in brackets, after the few blocks that lead in. Undefined when there is no such order to name.
 */
export function sequenceOf(kinds: readonly string[]): string | undefined {
  const runs = kinds.filter((kind, index) => kind !== kinds[index - 1]);
  if (runs.length < 2) return undefined;
  for (let lead = 0; lead <= MAX_SEQUENCE_LEAD; lead++) {
    const rest = runs.slice(lead);
    for (let size = 2; size <= 4; size++) {
      if (rest.length >= size * 2 && rest.length % size === 0 && rest.every((kind, index) => kind === rest[index % size])) {
        return [...runs.slice(0, lead), `(${rest.slice(0, size).join(">")})`].join(">");
      }
    }
  }
  return runs.length <= MAX_SEQUENCE_KINDS ? runs.join(">") : undefined;
}

export function projectLayout(document: SigmaDocument): LayoutProjection {
  const units: LayoutUnit[] = [];
  const outline: string[] = [];
  const unit = (id: string, fragments: string[], votes: [string, string | undefined][]) => {
    const kept = votes.filter((vote): vote is [string, string] => Boolean(vote[1]));
    if (kept.length) units.push({ id, fragments, votes: new Map(kept) });
  };
  let depth = 0;
  function walk(blocks: readonly SigmaBlock[], top: boolean) {
    blocks.forEach((block, index) => {
      switch (block.type) {
        case "problem": {
          const filled = (area: readonly SigmaBlock[]) => Boolean(firstText(area));
          const lists = block.prompt.flatMap(b => b.type === "list" && b.listType === "ordered" ? [b.markerStyle ?? "decimal"] : []);
          const typed = block.prompt.some(b => b.type === "paragraph" && SUBQUESTION.test(plain(b.children)));
          const heights = Object.values(block.areaLayout ?? {}).some(area => (area?.minHeightMm ?? 0) > 0);
          const frame = block.frame?.enabled ? (block.frame.styleId === "custom" && !block.frame.custom ? "fancybox" : block.frame.styleId ?? "fancybox") : "none";
          unit(block.id, textIds([block]), [
            ["layout.problemNumber", block.numbering?.enabled === false ? "none" : block.numbering?.format === "fullwidth" ? "fullwidth" : "decimal"],
            ["layout.problemLabel", match(PROBLEM_LABELS, firstText(block.lead) || firstText(block.prompt)) ?? "none"],
            ["layout.problemFrame", PROBLEM_FRAME_IDS.includes(frame) ? frame : "none"],
            ["layout.problemLead", filled(block.lead) ? "filled" : block.areaLayout?.lead?.hidden ? "hidden" : "empty"],
            ["layout.comment", filled(block.hints) ? "area" : !top ? undefined : isCommentBox(blocks[index + 1]) ? "boxAfter" : isCommentBox(blocks[index - 1]) ? "boxBefore" : "none"],
            ["layout.answerSpace", heights ? "area" : (block.spaceAfterPx ?? 0) >= ANSWER_SPACE_AFTER_PX ? "after" : "none"],
            ["layout.subquestionList", lists.length ? lists[0] : typed ? "text" : undefined],
          ]);
          if (top) outline.push(`problem[${(["lead", "prompt", "hints", "solution"] as const).filter(area => filled(block[area])).join(",")}]`);
          // A box or a heading inside a problem is laid out by the same habits as one beside it.
          for (const area of [block.lead, block.prompt, block.hints, block.solution]) walk(area, false);
          break;
        }
        case "boxBlock": {
          const title = block.frame?.titleVisible === false ? "" : plain(block.title);
          const style = BOX_STYLE_IDS.includes(block.styleId) ? block.styleId : undefined;
          const category = match(BOX_TITLES, title);
          unit(block.id, textIds([block]), [
            ["layout.boxStyle", style], ["layout.boxTitle", title ? "titled" : "untitled"],
            [`layout.box.${category}`, category ? style : undefined],
            ["layout.boxSubtitle", block.subtitle === undefined ? undefined : plain(block.subtitle) ? "filled" : "empty"],
          ]);
          if (top) outline.push(`box(${[style ?? "other", ...(category ? [category] : title ? ["titled"] : [])].join(",")})`);
          walk(block.blocks, false);
          break;
        }
        case "heading": case "section": {
          const text = block.type === "heading" ? plain(block.children) : block.title.trim();
          if (!text) break;
          const level = block.type === "heading" ? block.level : 1;
          depth = Math.max(depth, level);
          unit(block.id, [block.id], [
            ["layout.headingNumber", match(HEADING_NUMBERS, text) ?? (HEADING_SYMBOLS.includes([...text][0]) ? "symbol" : "none")],
            ["layout.headingAlign", block.align === "center" || block.align === "right" ? block.align : "left"],
          ]);
          if (top) outline.push(`heading${level}`);
          break;
        }
        case "layoutSection": if (top) outline.push(`columns${block.layout.columnCount}`); walk(block.children, false); break;
        case "quote": if (top) outline.push("quote"); walk(block.blocks, false); break;
        case "list":
          if (top) outline.push(block.listType === "ordered" ? `list(${block.markerStyle ?? "decimal"})` : "list");
          // A heading under a list item is a heading like any other.
          for (const item of block.items) { walk(item.continuations ?? [], false); walk(item.nested ?? [], false); }
          break;
        case "paragraph": if (top && !blank(block)) outline.push("text"); break;
        default: if (top) outline.push(KIND[block.type]);
      }
    });
  }
  walk(document.content, true);

  const content = document.content.filter(block => !blank(block));
  const all = textIds(document.content);
  const first = content[0];
  const second = content[1];
  const titled = first?.type === "section" || (first?.type === "heading" && first.level === 1);
  const flow = document.pageLayout?.flow;
  const page = document.pageLayout;
  const whole: [string, string | undefined][] = [
    ["layout.sequence", sequenceOf(content.map(block => KIND[block.type]))],
    ["layout.headingDepth", depth ? String(depth) : undefined],
    ["layout.docTitle", !first ? undefined : titled ? "heading" : first.type === "boxBlock" ? "box" : "other"],
    ["layout.subtitle", !titled ? undefined : second?.type === "heading" && second.level > 1 ? "heading"
      : second?.type === "paragraph" && plain(second.children).length <= SUBTITLE_MAX_LENGTH ? "text" : "none"],
    ["layout.columns", flow && Number.isSafeInteger(flow.columnCount) && flow.columnCount >= 1 && flow.columnCount <= 4 ? String(flow.columnCount) : undefined],
    ["layout.pageSize", page && ["A4", "A3", "B5", "B4"].includes(page.preset) && (page.orientation === "portrait" || page.orientation === "landscape")
      ? `${page.preset}-${page.orientation}` : undefined],
  ];
  const votes = whole.filter((vote): vote is [string, string] => Boolean(vote[1]));
  if (votes.length && all.length) units.push({ id: "$layout", fragments: all, whole: true, votes: new Map(votes) });
  // Kinds of blocks only, in order, with a count for a run: nothing an author typed is in it.
  const counted: string[] = [];
  for (const entry of outline) {
    const last = counted.at(-1);
    const [, name, times] = last?.match(/^(.*?)(?: x(\d+))?$/) ?? [];
    if (last && name === entry) counted[counted.length - 1] = `${entry} x${Number(times ?? 1) + 1}`;
    else counted.push(entry);
  }
  let text = counted.join(" / ");
  if (text.length > MAX_OUTLINE_LENGTH) text = `${text.slice(0, Math.max(0, text.lastIndexOf(" / ", MAX_OUTLINE_LENGTH - 6)))} / ...`;
  return { units, outline: text };
}
