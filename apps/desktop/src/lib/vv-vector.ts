import {
  VV_ARROW_DESIGN,
  VV_ARROW_HEIGHT,
  VV_ARROW_LEFT_SLICE_PATHS,
  VV_ARROW_RIGHT_SLICE_PATHS,
  VV_ARROW_RISE,
  VV_ARROW_SLICE_WIDTH,
} from "@/lib/vv-arrow-outline";

/**
 * `\vv{…}`, the vector command of LaTeX's esvect package, drawn with Sigma
 * Studio's own arrow (`vv-arrow-outline.ts`). The arrow is as wide as the
 * operand, at least `VV_MIN_WIDTH_EM` with the operand centred, and its ink
 * top is `VV_ARROW_RISE_EM` above the operand's top. The operand keeps its own
 * style (it is not cramped).
 *
 * Neither MathLive nor KaTeX knows `\vv`. Both receive a box with those metrics:
 * an invisible rule over the operand (`\overset`) reserves the arrow's height
 * and minimum width. The arrow is then drawn across the top of that box:
 * - static output (`normalizeVvMarkup`, MathLive and the KaTeX fallback),
 * - the editor (`installVvEditorSupport`), which uses the same box, keeps
 *   the operand editable and writes the field back as `\vv{…}`.
 */
export const VV_CLASS = "sigma-vv";
/** The drawn arrow (a class: the math markup sanitizer drops data-* attributes). */
export const VV_ARROW_CLASS = "sigma-vv-arrow";
export const VV_COMMAND = "vv";
/** The arrow's ink top above the operand's top. */
export const VV_ARROW_RISE_EM = VV_ARROW_RISE / 1000;
/** The narrowest vector. */
export const VV_MIN_WIDTH_EM = VV_ARROW_DESIGN.minWidth / 1000;

/**
 * The vector box is an `\overset` whose invisible rule reserves the rest of the
 * arrow's height and its minimum width, both ×0.7 for a vector in a script and
 * ×0.5 in a scriptscript. The rule sizes differ per engine:
 * - MathLive puts a 0.2em gap under the upper row (0.15em in scriptscript) and
 *   draws that row at an absolute 0.7 of the text size in every style.
 * - KaTeX's limit spacing is 0.3em (0.24em in script, 0.172em in
 *   scriptscript), and its rule dimensions are absolute text ems.
 * An outer `\mathchoice` selects the complete variant for the vector's style;
 * each engine renders and measures only that branch (including the shared
 * KaTeX width walker), so the box is right before any measurement.
 */
const slotBox = ([width, height]: readonly [number, number]) => String.raw`\overset{\phantom{\rule{${width}em}{${height}em}}}{#1}`;
const styleChoice = (slots: readonly (readonly [number, number])[]) => String.raw`\mathchoice{${slots.map(slotBox).join("}{")}}`;
/** Display, text, script and scriptscript: the vector's size, and each engine's gap under the upper row. */
const STYLES = [
  { size: 1, mathLiveGap: 0.2, katexGap: 0.3 },
  { size: 1, mathLiveGap: 0.2, katexGap: 0.3 },
  { size: 0.7, mathLiveGap: 0.2, katexGap: 0.24 },
  { size: 0.5, mathLiveGap: 0.15, katexGap: 0.172 },
] as const;
const MATHLIVE_UPPER_ROW_SIZE = 0.7;
const dimension = (value: number) => Number(value.toFixed(4));
/** [width, height] of the slot rule for display, text, script and scriptscript. */
const MATHLIVE_SLOTS = STYLES.map(({ size, mathLiveGap }) => [
  dimension((size * VV_MIN_WIDTH_EM) / MATHLIVE_UPPER_ROW_SIZE),
  dimension((size * VV_ARROW_RISE_EM - mathLiveGap) / MATHLIVE_UPPER_ROW_SIZE),
] as const);
const KATEX_SLOTS = STYLES.map(({ size, katexGap }) => [
  dimension(size * VV_MIN_WIDTH_EM),
  dimension(size * VV_ARROW_RISE_EM - katexGap),
] as const);
export const VV_MATHLIVE_DEF = String.raw`\class{${VV_CLASS}}{${styleChoice(MATHLIVE_SLOTS)}}`;
/**
 * The editor's box: one text-size variant, so the operand stays a single
 * editable branch (the macro atom marks the vector). Inside a script its slot
 * width is corrected on the rendered field; see `drawVvEditorArrows`.
 */
export const VV_EDITOR_DEF = slotBox(MATHLIVE_SLOTS[1]);
/** KaTeX (measurement and fallback). */
export const VV_KATEX_DEF = String.raw`\htmlClass{${VV_CLASS}}{${styleChoice(KATEX_SLOTS)}}`;

const em = (value: number) => `${Number(value.toFixed(6))}em`;
const ARROW_HEIGHT = em(VV_ARROW_HEIGHT / 1000);
const arrowStyle = (topEm: number) => `display:block;position:absolute;left:0;top:${em(topEm)};width:100%;height:${ARROW_HEIGHT}`;

/**
 * The arrow's top within the vector's vlist cell, both MathLive heights in the
 * vector's own em: `operand top − VV_ARROW_RISE_EM`. It is ~0 where the box is
 * exact; in the editor's single variant inside a script the box is taller, and
 * this still puts the arrow at its place, measured from the operand.
 */
export function vvArrowTopEm(vlistHeightEm: number, operandHeightEm: number): number {
  const top = vlistHeightEm - operandHeightEm - VV_ARROW_RISE_EM;
  return Number.isFinite(top) && top > 0 ? top : 0;
}

interface ArrowSlice { style: string; svg: Record<string, string>; paths: readonly string[] }

/**
 * Two halves, as MathLive's own stretchy accents: the shaft's start is fixed on
 * the left and the head on the right, and the shaft between them stretches.
 * Each half is an inline-flex box, so its SVG cannot sit on a line-box strut.
 */
const ARROW_SLICES: readonly ArrowSlice[] = [
  [VV_ARROW_LEFT_SLICE_PATHS, "xMinYMin", "0"],
  [VV_ARROW_RIGHT_SLICE_PATHS, "xMaxYMin", "49.8%"],
].map(([paths, align, left]) => ({
  style: `position:absolute;left:${left};top:0;width:50.2%;height:${ARROW_HEIGHT};overflow:hidden;display:inline-flex`,
  svg: { width: "100%", height: ARROW_HEIGHT, viewBox: `0 0 ${VV_ARROW_SLICE_WIDTH} ${VV_ARROW_HEIGHT}`, preserveAspectRatio: `${align} slice` },
  paths: paths as readonly string[],
}));

/** The stretchy `\vv` arrow, placed across a positioned vlist cell `topEm` below its top. */
export function vvArrowMarkup(topEm = 0): string {
  return `<span class="${VV_ARROW_CLASS}" style="${arrowStyle(topEm)}">`
    + ARROW_SLICES.map((slice) => `<span style="${slice.style}"><svg ${Object.entries(slice.svg).map(([name, value]) => `${name}="${value}"`).join(" ")}>`
      + slice.paths.map((d) => `<path fill="currentcolor" d="${d}"></path>`).join("") + "</svg></span>").join("")
    + "</span>";
}

/** The same arrow as DOM nodes (the editor's shadow root; no HTML string sink). */
export function createVvArrowElement(document: Document, topEm = 0): HTMLElement {
  const arrow = document.createElement("span");
  arrow.className = VV_ARROW_CLASS;
  arrow.setAttribute("style", arrowStyle(topEm));
  for (const slice of ARROW_SLICES) {
    const holder = document.createElement("span");
    holder.setAttribute("style", slice.style);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries(slice.svg)) svg.setAttribute(name, value);
    for (const d of slice.paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "currentcolor");
      path.setAttribute("d", d);
      svg.append(path);
    }
    holder.append(svg);
    arrow.append(holder);
  }
  return arrow;
}

// ---------------------------------------------------------------------------
// Static markup (MathLive SSR and the KaTeX fallback)

interface MarkupNode {
  open: string;
  children: (MarkupNode | string)[];
}

function parseSpans(markup: string): (MarkupNode | string)[] | null {
  const root: MarkupNode = { open: "", children: [] };
  const stack = [root];
  for (const match of markup.matchAll(/<span\b[^>]*>|<\/span>|<svg\b[\s\S]*?<\/svg>|<[^>]*>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith("<span")) {
      const node: MarkupNode = { open: token, children: [] };
      stack.at(-1)!.children.push(node);
      stack.push(node);
    } else if (token === "</span>") {
      if (stack.length < 2) return null;
      stack.pop();
    } else stack.at(-1)!.children.push(token);
  }
  return stack.length === 1 ? root.children : null;
}

function serializeSpans(nodes: readonly (MarkupNode | string)[]): string {
  return nodes.map((node) => typeof node === "string" ? node : `${node.open}${serializeSpans(node.children)}</span>`).join("");
}

const classesOf = (node: MarkupNode) => /\bclass="([^"]*)"/.exec(node.open)?.[1].split(/\s+/) ?? [];
const hasClass = (node: MarkupNode, name: string) => classesOf(node).includes(name);

/** First descendant (pre-order) satisfying `test`. */
function find(node: MarkupNode, test: (n: MarkupNode) => boolean): MarkupNode | undefined {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (test(child)) return child;
    const found = find(child, test);
    if (found) return found;
  }
  return undefined;
}

/** The vector box's vlist cell (MathLive `ML__vlist`, KaTeX `vlist`): positioned, its top is the box top. */
const isVlist = (node: MarkupNode) => hasClass(node, "ML__vlist") || hasClass(node, "vlist");
/** The invisible slot rule (MathLive `opacity:0`, KaTeX `color:transparent`). */
const isSlotRule = (node: MarkupNode) => (hasClass(node, "ML__rule") || hasClass(node, "katex-rule"))
  && /opacity:0|color:transparent/.test(node.open);
const isArrow = (node: MarkupNode | string) => typeof node !== "string" && hasClass(node, VV_ARROW_CLASS);

const emHeight = (open: string) => Number(/(?:^|[;"\s])height:\s*(-?[\d.]+)em/.exec(open)?.[1]);

/** MathLive: the operand row (no slot rule) carries its height; KaTeX's box is exact as drawn. */
function arrowTopEm(vlist: MarkupNode): number {
  const operandRow = vlist.children.find((row): row is MarkupNode => typeof row !== "string" && !isArrow(row) && !find(row, isSlotRule));
  const operand = operandRow?.children.find((child): child is MarkupNode => typeof child !== "string" && !hasClass(child, "ML__pstrut"));
  return operand ? vvArrowTopEm(emHeight(vlist.open), emHeight(operand.open)) : 0;
}

/**
 * The editor's single-variant slot row is at script size of the vector
 * (`font-size: 70%`) only for a text-size vector; inside a script MathLive
 * leaves it at 100% (140% two levels down), which would widen the box. The
 * style is the one MathLive writes for the text-size row (its height rounded
 * up to 0.01em).
 */
export const VV_SLOT_STYLE = `height:${Math.ceil(MATHLIVE_SLOTS[1][1] * MATHLIVE_UPPER_ROW_SIZE * 100) / 100}em;display:inline-block;font-size: 70%`;

function drawVector(vector: MarkupNode): boolean {
  const vlist = find(vector, isVlist);
  if (!vlist || vlist.children.some(isArrow) || !find(vlist, isSlotRule)) return false;
  vlist.children.unshift(vvArrowMarkup(hasClass(vlist, "ML__vlist") ? arrowTopEm(vlist) : 0));
  return true;
}

/** Draw the arrow of every `\vv` in renderer markup. */
export function normalizeVvMarkup(markup: string): string {
  if (!markup.includes(VV_CLASS)) return markup;
  const nodes = parseSpans(markup);
  if (!nodes) return markup;
  let changed = false;
  const visit = (list: (MarkupNode | string)[]) => {
    for (const node of list) {
      if (typeof node === "string") continue;
      if (hasClass(node, VV_CLASS)) changed = drawVector(node) || changed;
      visit(node.children);
    }
  };
  visit(nodes);
  return changed ? serializeSpans(nodes) : markup;
}
