import {
  ESVECT_D_LEFT_SLICE_PATHS,
  ESVECT_D_RIGHT_SLICE_PATHS,
  ESVECT_D_VIEWBOX_HEIGHT,
} from "@/lib/esvect-d-outlines";

/**
 * `\vv{…}` of the esvect package (Eddie Saudrais, CTAN macros/latex/contrib/esvect,
 * v1.3), with its default arrow, option d. esvect.dtx builds a vector as
 *
 *   \vbox{\ialign{##\crcr
 *     \noalign{\kern-.7pt\nointerlineskip} <arrow row> \crcr
 *     \noalign{\kern-.3pt\nointerlineskip} $\hfil <operand> \hfil$ \crcr}}
 *   <arrow row> = \mkern2mu tail('043) \mkern-1.5mu \cleaders(rule '040)\hfill \mkern-1.5mu head('024)
 *
 * so the arrow is as wide as the operand (at least its natural 0.8334em, with
 * the operand centred), its row sits 0.3pt below the operand's top, and the
 * head's ink rises 0.368em above the operand. The operand keeps its own style
 * (it is not cramped).
 *
 * Neither MathLive nor KaTeX knows `\vv`. Both receive a box with those metrics:
 * an invisible rule over the operand (`\overset`) reserves the arrow's height
 * and minimum width. The arrow itself, built from the esvect glyph outlines in
 * `esvect-d-outlines.ts`, is then drawn across the top of that box:
 * - static output (`normalizeEsvectMarkup`, MathLive and the KaTeX fallback),
 * - the editor (`installEsvectEditorSupport`), which uses the same box, keeps
 *   the operand editable and writes the field back as `\vv{…}`.
 */
export const ESVECT_D_CLASS = "sigma-esvect-d";
/** The drawn arrow (a class: the math markup sanitizer drops data-* attributes). */
export const ESVECT_D_ARROW_CLASS = "sigma-esvect-d-arrow";
export const ESVECT_COMMAND = "vv";
/** The head's ink top above the operand: 0.398em over the arrow row, minus 0.3pt. */
export const ESVECT_D_HEAD_RISE_EM = 0.368;
/** The arrow row's natural width: 2mu + tail − 1.5mu − 1.5mu + head. */
export const ESVECT_D_MIN_WIDTH_EM = 0.8334;

/**
 * The vector box is an `\overset` whose invisible rule reserves the rest of the
 * arrow's 0.368em height and the 0.8334em minimum width, both ×0.7 for a vector
 * in a script and ×0.5 in a scriptscript. The rule sizes differ per engine:
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
/** [width, height] of the slot rule for display, text, script and scriptscript. */
const MATHLIVE_SLOTS = [[1.191, 0.24], [1.191, 0.24], [0.8334, 0.083], [0.595, 0.0486]] as const;
const KATEX_SLOTS = [[0.8334, 0.068], [0.8334, 0.068], [0.5834, 0.018], [0.4167, 0.012]] as const;
export const ESVECT_D_MATHLIVE_DEF = String.raw`\class{${ESVECT_D_CLASS}}{${styleChoice(MATHLIVE_SLOTS)}}`;
/**
 * The editor's box: one text-size variant, so the operand stays a single
 * editable branch (the macro atom marks the vector). Inside a script its slot
 * width is corrected on the rendered field; see `drawEsvectEditorArrows`.
 */
export const ESVECT_D_EDITOR_DEF = slotBox(MATHLIVE_SLOTS[1]);
/** KaTeX (measurement and fallback). */
export const ESVECT_D_KATEX_DEF = String.raw`\htmlClass{${ESVECT_D_CLASS}}{${styleChoice(KATEX_SLOTS)}}`;

const em = (value: number) => `${Number(value.toFixed(6))}em`;
const ARROW_HEIGHT = em(ESVECT_D_VIEWBOX_HEIGHT / 1000);
const arrowStyle = (topEm: number) => `display:block;position:absolute;left:0;top:${em(topEm)};width:100%;height:${ARROW_HEIGHT}`;

/**
 * The arrow's top within the vector's vlist cell, both MathLive heights in the
 * vector's own em: `operand top − 0.368em`. It is ~0 where the box is exact; in
 * the editor's single variant inside a script the box is taller, and this still
 * puts the arrow where esvect does, measured from the operand.
 */
export function esvectArrowTopEm(vlistHeightEm: number, operandHeightEm: number): number {
  const top = vlistHeightEm - operandHeightEm - ESVECT_D_HEAD_RISE_EM;
  return Number.isFinite(top) && top > 0 ? top : 0;
}

interface ArrowSlice { style: string; svg: Record<string, string>; paths: readonly string[] }

/**
 * Two halves, as MathLive's own stretchy accents: the tail end is fixed on the
 * left and the head on the right, and the rule between them stretches. Each half
 * is an inline-flex box, so its SVG cannot sit on a line-box strut.
 */
const ARROW_SLICES: readonly ArrowSlice[] = [
  [ESVECT_D_LEFT_SLICE_PATHS, "xMinYMin", "0"],
  [ESVECT_D_RIGHT_SLICE_PATHS, "xMaxYMin", "49.8%"],
].map(([paths, align, left]) => ({
  style: `position:absolute;left:${left};top:0;width:50.2%;height:${ARROW_HEIGHT};overflow:hidden;display:inline-flex`,
  svg: { width: "100%", height: ARROW_HEIGHT, viewBox: `0 0 400000 ${ESVECT_D_VIEWBOX_HEIGHT}`, preserveAspectRatio: `${align} slice` },
  paths: paths as readonly string[],
}));

/** The stretchy esvect-d arrow, placed across a positioned vlist cell `topEm` below its top. */
export function esvectArrowMarkup(topEm = 0): string {
  return `<span class="${ESVECT_D_ARROW_CLASS}" style="${arrowStyle(topEm)}">`
    + ARROW_SLICES.map((slice) => `<span style="${slice.style}"><svg ${Object.entries(slice.svg).map(([name, value]) => `${name}="${value}"`).join(" ")}>`
      + slice.paths.map((d) => `<path fill="currentcolor" d="${d}"></path>`).join("") + "</svg></span>").join("")
    + "</span>";
}

/** The same arrow as DOM nodes (the editor's shadow root; no HTML string sink). */
export function createEsvectArrowElement(document: Document, topEm = 0): HTMLElement {
  const arrow = document.createElement("span");
  arrow.className = ESVECT_D_ARROW_CLASS;
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
const isArrow = (node: MarkupNode | string) => typeof node !== "string" && hasClass(node, ESVECT_D_ARROW_CLASS);

const emHeight = (open: string) => Number(/(?:^|[;"\s])height:\s*(-?[\d.]+)em/.exec(open)?.[1]);

/** MathLive: the operand row (no slot rule) carries its height; KaTeX's box is exact as drawn. */
function arrowTopEm(vlist: MarkupNode): number {
  const operandRow = vlist.children.find((row): row is MarkupNode => typeof row !== "string" && !isArrow(row) && !find(row, isSlotRule));
  const operand = operandRow?.children.find((child): child is MarkupNode => typeof child !== "string" && !hasClass(child, "ML__pstrut"));
  return operand ? esvectArrowTopEm(emHeight(vlist.open), emHeight(operand.open)) : 0;
}

/**
 * The editor's single-variant slot row is at script size of the vector
 * (`font-size: 70%`) only for a text-size vector; inside a script MathLive
 * leaves it at 100% (140% two levels down), which would widen the box.
 */
export const ESVECT_D_SLOT_STYLE = "height:0.17em;display:inline-block;font-size: 70%";

function drawVector(vector: MarkupNode): boolean {
  const vlist = find(vector, isVlist);
  if (!vlist || vlist.children.some(isArrow) || !find(vlist, isSlotRule)) return false;
  vlist.children.unshift(esvectArrowMarkup(hasClass(vlist, "ML__vlist") ? arrowTopEm(vlist) : 0));
  return true;
}

/** Draw the esvect-d arrow of every `\vv` in renderer markup. */
export function normalizeEsvectMarkup(markup: string): string {
  if (!markup.includes(ESVECT_D_CLASS)) return markup;
  const nodes = parseSpans(markup);
  if (!nodes) return markup;
  let changed = false;
  const visit = (list: (MarkupNode | string)[]) => {
    for (const node of list) {
      if (typeof node === "string") continue;
      if (hasClass(node, ESVECT_D_CLASS)) changed = drawVector(node) || changed;
      visit(node.children);
    }
  };
  visit(nodes);
  return changed ? serializeSpans(nodes) : markup;
}

// ---------------------------------------------------------------------------
// Editor (`<math-field>`; MathLive 0.111 atoms, as in mathlive-open-fence.ts)

interface AtomLike {
  type?: string;
  command?: string;
  id?: string;
  body?: AtomLike[];
  expand?: boolean;
  parent?: AtomLike;
  parentBranch?: unknown;
  leftSibling?: AtomLike;
  branch?: (name: string) => AtomLike[] | undefined;
  bodyToLatex?: (options: unknown) => string;
  constructor: { serialize?: (atoms: AtomLike[], options: unknown) => string };
}
interface ModelLike {
  atoms?: unknown;
  at?: (offset: number) => AtomLike | undefined;
  offsetOf?: (atom: AtomLike) => number;
}
interface FieldLike { position?: number; _mathfield?: { model?: ModelLike } }
type Serialize = (this: AtomLike, options: { expandMacro?: boolean }) => string;
const WRAPPED = "__sigmaEsvectLatex";
const COMMAND = `\\${ESVECT_COMMAND}`;
const BOX_COMMAND = "\\overset";

/**
 * `\vv{current operand}`. MathLive serializes a macro from the arguments it was
 * parsed with, so an edit inside the vector would otherwise be lost. Anything
 * typed beside the box inside the macro stays outside the vector.
 */
export function serializeEditorVector(atom: AtomLike, options: { expandMacro?: boolean }): string | null {
  if (atom.command !== COMMAND || (options.expandMacro && atom.expand) || !Array.isArray(atom.body)) return null;
  const atoms = atom.body.filter((child) => child.type !== "first");
  const index = atoms.findIndex((child) => child.command === BOX_COMMAND);
  const box = atoms[index];
  if (!box?.bodyToLatex) return null;
  const serialize = (list: AtomLike[]) => list.length ? atom.constructor.serialize?.(list, options) ?? "" : "";
  return `${serialize(atoms.slice(0, index))}${COMMAND}{${box.bodyToLatex(options)}}${serialize(atoms.slice(index + 1))}`;
}

function modelAtoms(mathField: unknown): AtomLike[] | null {
  const atoms = (mathField as FieldLike | null)?._mathfield?.model?.atoms;
  return Array.isArray(atoms) ? atoms as AtomLike[] : null;
}

/**
 * Where the caret may not rest inside a `\vv`: the macro's own edges and the
 * invisible slot above the operand. Returns the offset to move to instead, in
 * the direction of travel, so arrow keys and clicks behave as with an accent.
 */
export function esvectCaretTarget(model: ModelLike, offset: number, forward: boolean): number | null {
  const leaf = model.at?.(offset);
  const parent = leaf?.parent;
  if (!leaf || !parent || !model.offsetOf) return null;
  const inSlot = parent.command === BOX_COMMAND && leaf.parentBranch === "above" && parent.parent?.command === COMMAND;
  const inMacro = parent.command === COMMAND && parent.type === "macro";
  if (!inSlot && !inMacro) return null;
  const macro = inSlot ? parent.parent! : parent;
  const box = macro.body?.find((child) => child.command === BOX_COMMAND);
  const operand = box?.branch?.("body");
  if (!box || !operand?.length) return null;
  const beforeBox = inMacro && model.offsetOf(leaf) < model.offsetOf(box) && leaf !== box;
  if (forward) return beforeBox ? model.offsetOf(operand[0]) : model.offsetOf(macro);
  if (beforeBox) return macro.leftSibling ? model.offsetOf(macro.leftSibling) : model.offsetOf(operand[0]) - 1;
  return model.offsetOf(operand.at(-1)!);
}

function guardEsvectCaret(mathField: FieldLike, last: { offset: number }) {
  const model = mathField._mathfield?.model;
  const offset = mathField.position;
  if (!model || typeof offset !== "number") return;
  const target = esvectCaretTarget(model, offset, offset >= last.offset);
  if (target !== null && target !== offset && target >= 0) mathField.position = target;
  last.offset = mathField.position ?? offset;
}

/** Wrap MathLive's macro serialization once a macro atom exists. */
export function installEsvectSerialization(mathField: unknown): boolean {
  // Per prototype: a page may hold more than one MathLive module instance.
  const macro = modelAtoms(mathField)?.find((atom) => atom.type === "macro");
  const prototype = macro && Object.getPrototypeOf(macro) as { _serialize?: Serialize } | null;
  const original = prototype?._serialize;
  if (!prototype || typeof original !== "function") return false;
  if (!(original as unknown as Record<string, unknown>)[WRAPPED]) {
    const wrapped: Serialize = function serializeEsvect(this: AtomLike, options) {
      return serializeEditorVector(this, options ?? {}) ?? original.call(this, options);
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    prototype._serialize = wrapped;
  }
  return true;
}

/** Draw the arrow of every `\vv` box in a rendered field, as in static output. */
export function drawEsvectEditorArrows(mathField: unknown, root: ParentNode): number {
  let drawn = 0;
  for (const atom of modelAtoms(mathField) ?? []) {
    if (atom.type !== "macro" || atom.command !== COMMAND) continue;
    const box = atom.body?.find((child) => child.command === BOX_COMMAND);
    if (!box?.id) continue;
    const element = root.querySelector?.(`[data-atom-id="${CSS.escape(box.id)}"]`);
    if (!element) continue;
    const owns = (node: Element) => node.closest("[data-atom-id]") === element; // not a nested vector
    const vlist = [...element.querySelectorAll<HTMLElement>(".ML__vlist")].find(owns);
    if (!vlist || [...vlist.children].some((child) => child.classList.contains(ESVECT_D_ARROW_CLASS))) continue;
    const slotRow = [...vlist.children].find((row) => row.querySelector(".ML__rule"));
    const slot = slotRow && [...slotRow.children].find((child) => !child.classList.contains("ML__pstrut"));
    if (slot instanceof HTMLElement && slot.getAttribute("style") !== ESVECT_D_SLOT_STYLE) slot.setAttribute("style", ESVECT_D_SLOT_STYLE);
    const operandRow = [...vlist.children].find((row) => !row.querySelector(".ML__rule"));
    const operand = operandRow && [...operandRow.children].find((child) => !child.classList.contains("ML__pstrut"));
    const top = operand instanceof HTMLElement ? esvectArrowTopEm(parseFloat(vlist.style.height), parseFloat(operand.style.height)) : 0;
    vlist.prepend(createEsvectArrowElement(vlist.ownerDocument, top));
    drawn += 1;
  }
  return drawn;
}

const observedRoots = new WeakSet<ShadowRoot>();

/** Editor support: draw on every MathLive render, and serialize `\vv{…}` back. */
export function installEsvectEditorSupport(mathField: HTMLElement): void {
  const root = mathField.shadowRoot;
  const refresh = () => {
    installEsvectSerialization(mathField);
    if (root) drawEsvectEditorArrows(mathField, root);
  };
  const caret = { offset: 0 };
  // Fields that are not mounted custom elements (tests, SSR stubs) have no events.
  if (typeof mathField.addEventListener === "function") {
    for (const type of ["focusin", "input", "mount"]) mathField.addEventListener(type, refresh);
    mathField.addEventListener("selection-change", () => {
      refresh();
      guardEsvectCaret(mathField as FieldLike, caret);
    });
  }
  if (root && typeof MutationObserver !== "undefined" && !observedRoots.has(root)) {
    observedRoots.add(root);
    new MutationObserver(refresh).observe(root, { childList: true, subtree: true });
  }
  refresh();
}
