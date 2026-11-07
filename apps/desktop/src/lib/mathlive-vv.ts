import { VV_COMMAND, VV_ARROW_CLASS, VV_SLOT_STYLE, vvArrowTopEm, createVvArrowElement } from "@/lib/vv-vector";

// ---------------------------------------------------------------------------
// Editor (`<math-field>`; MathLive 0.111 atoms, as in mathlive-open-fence.ts)

interface AtomLike {
  _serialize?: Serialize;
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
const WRAPPED = "__sigmaVvLatex";
const COMMAND = `\\${VV_COMMAND}`;
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

/** The `\vv` box whose invisible slot holds `atom`, at any depth (the slot is `\phantom{\rule…}`). */
function slotBoxOf(atom: AtomLike): AtomLike | null {
  for (let node = atom; node.parent; node = node.parent) {
    if (node.parentBranch === "above" && node.parent.command === BOX_COMMAND && node.parent.parent?.command === COMMAND) return node.parent;
  }
  return null;
}

/**
 * Where the caret may not rest inside a `\vv`: the macro's own edges and the
 * invisible slot above the operand, inside its `\phantom` included, where
 * anything typed would neither show nor be saved. Returns the offset to move to
 * instead, in the direction of travel, so arrow keys and clicks behave as with
 * an accent.
 */
export function vvCaretTarget(model: ModelLike, offset: number, forward: boolean): number | null {
  const leaf = model.at?.(offset);
  if (!leaf?.parent || !model.offsetOf) return null;
  const slotBox = slotBoxOf(leaf);
  const inMacro = leaf.parent.command === COMMAND && leaf.parent.type === "macro";
  if (!slotBox && !inMacro) return null;
  const macro = slotBox ? slotBox.parent! : leaf.parent;
  const box = macro.body?.find((child) => child.command === BOX_COMMAND);
  const operand = box?.branch?.("body");
  if (!box || !operand?.length) return null;
  const beforeBox = !slotBox && model.offsetOf(leaf) < model.offsetOf(box) && leaf !== box;
  if (forward) return beforeBox ? model.offsetOf(operand[0]) : model.offsetOf(macro);
  if (beforeBox) return macro.leftSibling ? model.offsetOf(macro.leftSibling) : model.offsetOf(operand[0]) - 1;
  return model.offsetOf(operand.at(-1)!);
}

function guardVvCaret(mathField: FieldLike, last: { offset: number }) {
  const model = mathField._mathfield?.model;
  const offset = mathField.position;
  if (!model || typeof offset !== "number") return;
  const target = vvCaretTarget(model, offset, offset >= last.offset);
  if (target !== null && target !== offset && target >= 0) mathField.position = target;
  last.offset = mathField.position ?? offset;
}

/** Only atoms parsed in a built-in-vector field receive the serialization adapter. */
export function installVvSerialization(mathField: unknown): boolean {
  let installed = false;
  for (const atom of modelAtoms(mathField) ?? []) {
    if (atom.type !== "macro" || atom.command !== COMMAND) continue;
    const original = atom._serialize;
    if (typeof original !== "function") continue;
    installed = true;
    if ((original as unknown as Record<string, unknown>)[WRAPPED]) continue;
    const wrapped: Serialize = function serializeVv(this: AtomLike, options) {
      return serializeEditorVector(this, options ?? {}) ?? original.call(this, options);
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    // Never change MacroAtom.prototype: other fields may define their own \vv.
    Object.defineProperty(atom, "_serialize", { value: wrapped, configurable: true, writable: true });
  }
  return installed;
}

/** Draw the arrow of every `\vv` box in a rendered field, as in static output. */
export function drawVvEditorArrows(mathField: unknown, root: ParentNode): number {
  let drawn = 0;
  for (const atom of modelAtoms(mathField) ?? []) {
    if (atom.type !== "macro" || atom.command !== COMMAND) continue;
    const box = atom.body?.find((child) => child.command === BOX_COMMAND);
    if (!box?.id) continue;
    const element = root.querySelector?.(`[data-atom-id="${CSS.escape(box.id)}"]`);
    if (!element) continue;
    const owns = (node: Element) => node.closest("[data-atom-id]") === element; // not a nested vector
    const vlist = [...element.querySelectorAll<HTMLElement>(".ML__vlist")].find(owns);
    if (!vlist || [...vlist.children].some((child) => child.classList.contains(VV_ARROW_CLASS))) continue;
    const slotRow = [...vlist.children].find((row) => row.querySelector(".ML__rule"));
    const slot = slotRow && [...slotRow.children].find((child) => !child.classList.contains("ML__pstrut"));
    if (slot instanceof HTMLElement && slot.getAttribute("style") !== VV_SLOT_STYLE) slot.setAttribute("style", VV_SLOT_STYLE);
    const operandRow = [...vlist.children].find((row) => !row.querySelector(".ML__rule"));
    const operand = operandRow && [...operandRow.children].find((child) => !child.classList.contains("ML__pstrut"));
    const top = operand instanceof HTMLElement ? vvArrowTopEm(parseFloat(vlist.style.height), parseFloat(operand.style.height)) : 0;
    vlist.prepend(createVvArrowElement(vlist.ownerDocument, top));
    drawn += 1;
  }
  return drawn;
}

const observedRoots = new WeakSet<ShadowRoot>();
const supportedFields = new WeakSet<HTMLElement>();
const installedFields = new WeakSet<HTMLElement>();

/** Editor support: draw on every MathLive render, and serialize `\vv{…}` back. */
export function installVvEditorSupport(mathField: HTMLElement, enabled = true): void {
  if (!enabled) { supportedFields.delete(mathField); return; }
  supportedFields.add(mathField);
  const root = mathField.shadowRoot;
  const refresh = () => {
    if (!supportedFields.has(mathField)) return;
    installVvSerialization(mathField);
    if (root) drawVvEditorArrows(mathField, root);
  };
  if (installedFields.has(mathField)) { refresh(); return; }
  installedFields.add(mathField);
  const caret = { offset: 0 };
  // Fields that are not mounted custom elements (tests, SSR stubs) have no events.
  if (typeof mathField.addEventListener === "function") {
    for (const type of ["focusin", "input", "mount"]) mathField.addEventListener(type, refresh);
    mathField.addEventListener("selection-change", () => {
      if (!supportedFields.has(mathField)) return;
      refresh();
      guardVvCaret(mathField as FieldLike, caret);
    });
  }
  if (root && typeof MutationObserver !== "undefined" && !observedRoots.has(root)) {
    observedRoots.add(root);
    new MutationObserver(refresh).observe(root, { childList: true, subtree: true });
  }
  refresh();
}
