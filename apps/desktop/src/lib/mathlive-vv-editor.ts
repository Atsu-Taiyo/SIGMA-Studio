import {
  createVvArrowElement,
  VV_ARROW_CLASS,
  VV_COMMAND,
  VV_SLOT_STYLE,
  vvArrowTopEm,
} from "@/lib/vv-vector";

/**
 * Editing the built-in `\vv{…}` in a `<math-field>` (MathLive 0.111): the arrow
 * drawn over the same box as static output (`vv-vector.ts`), the caret kept on
 * the operand, and the field written back as `\vv{current operand}`.
 *
 * MathLive's public API does not expose the atom tree. As in
 * `mathlive-open-fence.ts` and `mathlive-script-navigation.ts`, this reads the
 * internal `_mathfield.model`; `mathlive-vv-editor-real.test.ts` checks it
 * against the real MathLive. It touches only `model.atoms` / `root` / `at()` /
 * `offsetOf()`, the atoms' `type` / `command` / `id` / `body` / `parent` /
 * `parentBranch` / `leftSibling` / `branch()` / `bodyToLatex()`, the macro
 * atom class's `_serialize` and static `serialize`, and the rendered
 * `[data-atom-id]` / `.ML__vlist` / `.ML__rule` / `.ML__pstrut`. Where these
 * are missing it does nothing (MathLive's own behaviour).
 *
 * Only fields set up with the built-in `\vv` (`installVvEditorSupport`) are
 * touched. A document's own `\vv` is MathLive's ordinary macro, even on a page
 * where the shared serializer is already wrapped.
 */

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
  root?: unknown;
  at?: (offset: number) => AtomLike | undefined;
  offsetOf?: (atom: AtomLike) => number;
}
interface FieldLike { position?: number; _mathfield?: { model?: ModelLike } }
type Serialize = (this: AtomLike, options: { expandMacro?: boolean }) => string;
const WRAPPED = "__sigmaVvLatex";
const COMMAND = `\\${VV_COMMAND}`;
const BOX_COMMAND = "\\overset";

const modelOf = (mathField: unknown): ModelLike | undefined => (mathField as FieldLike | null)?._mathfield?.model;

function modelAtoms(mathField: unknown): AtomLike[] | null {
  const atoms = modelOf(mathField)?.atoms;
  return Array.isArray(atoms) ? atoms as AtomLike[] : null;
}

// ---------------------------------------------------------------------------
// Which fields use the built-in \vv

/** Set up with the built-in `\vv`; cleared when the field gets a document's own `\vv`. */
const builtInFields = new WeakSet<object>();
/** The same fields, to find the one an atom belongs to (the serializer only sees the atom). */
const builtInFieldRefs = new Set<WeakRef<object>>();
const refOf = new WeakMap<object, WeakRef<object>>();

function setBuiltIn(mathField: object, builtIn: boolean) {
  if (!builtIn) {
    builtInFields.delete(mathField);
    return;
  }
  builtInFields.add(mathField);
  let ref = refOf.get(mathField);
  if (!ref) {
    ref = new WeakRef(mathField);
    refOf.set(mathField, ref);
  }
  builtInFieldRefs.add(ref);
}

/** Whether `atom` is in the current tree of a field set up with the built-in `\vv`. */
export function isBuiltInVvAtom(atom: AtomLike): boolean {
  let root = atom;
  while (root.parent) root = root.parent;
  for (const ref of builtInFieldRefs) {
    const field = ref.deref();
    if (!field || !builtInFields.has(field)) {
      builtInFieldRefs.delete(ref);
      continue;
    }
    if (modelOf(field)?.root === root) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Serialization

/**
 * `\vv{current operand}`. MathLive serializes a macro from the arguments it was
 * parsed with, so an edit inside the vector would otherwise be lost. Anything
 * typed beside the box inside the macro stays outside the vector. Only for an
 * atom of the built-in `\vv` (see `installVvSerialization`).
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

/**
 * Wrap MathLive's macro serialization once a macro atom exists. The wrapper is
 * shared by every field of the page (per prototype: a page may hold more than
 * one MathLive module instance), so it rewrites only built-in `\vv` atoms.
 */
export function installVvSerialization(mathField: unknown): boolean {
  const macro = modelAtoms(mathField)?.find((atom) => atom.type === "macro");
  const prototype = macro && Object.getPrototypeOf(macro) as { _serialize?: Serialize } | null;
  const original = prototype?._serialize;
  if (!prototype || typeof original !== "function") return false;
  if (!(original as unknown as Record<string, unknown>)[WRAPPED]) {
    const wrapped: Serialize = function serializeVv(this: AtomLike, options) {
      const vector = this.command === COMMAND && isBuiltInVvAtom(this) ? serializeEditorVector(this, options ?? {}) : null;
      return vector ?? original.call(this, options);
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    prototype._serialize = wrapped;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Caret

/** The `\vv` box whose invisible slot holds `atom`, at any depth (the slot is `\phantom{\rule…}`). */
function slotBoxOf(atom: AtomLike): AtomLike | null {
  for (let node = atom; node.parent; node = node.parent) {
    if (node.parentBranch === "above" && node.parent.command === BOX_COMMAND && node.parent.parent?.command === COMMAND) return node.parent;
  }
  return null;
}

/**
 * Where the caret may not rest inside a `\vv`: the macro's own edges and the
 * invisible slot above the operand, where anything typed would neither show nor
 * be saved. Returns the offset to move to instead, in the direction of travel,
 * so arrow keys and clicks behave as with an accent.
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
  const model = modelOf(mathField);
  const offset = mathField.position;
  if (!model || typeof offset !== "number") return;
  const target = vvCaretTarget(model, offset, offset >= last.offset);
  if (target !== null && target !== offset && target >= 0) mathField.position = target;
  last.offset = mathField.position ?? offset;
}

// ---------------------------------------------------------------------------
// Drawing

/** Draw the arrow of every `\vv` box in a rendered field with the built-in `\vv`, as in static output. */
export function drawVvEditorArrows(mathField: unknown, root: ParentNode): number {
  if (!builtInFields.has(mathField as object)) return 0;
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

// ---------------------------------------------------------------------------
// Setup

const listening = new WeakSet<object>();
const observedRoots = new WeakSet<ShadowRoot>();

/**
 * The field's `\vv` is the built-in one: draw on every MathLive render, keep
 * the caret on the operand, and serialize `\vv{…}` back. Repeated calls are
 * cheap; `releaseVvEditorSupport` undoes it when the field gets a document's
 * own `\vv`.
 */
export function installVvEditorSupport(mathField: HTMLElement): void {
  setBuiltIn(mathField, true);
  const root = mathField.shadowRoot;
  const refresh = () => {
    if (!builtInFields.has(mathField)) return;
    installVvSerialization(mathField);
    if (root) drawVvEditorArrows(mathField, root);
  };
  if (!listening.has(mathField)) {
    listening.add(mathField);
    const caret = { offset: 0 };
    // Fields that are not mounted custom elements (tests, SSR stubs) have no events.
    if (typeof mathField.addEventListener === "function") {
      for (const type of ["focusin", "input", "mount"]) mathField.addEventListener(type, refresh);
      mathField.addEventListener("selection-change", () => {
        if (!builtInFields.has(mathField)) return;
        refresh();
        guardVvCaret(mathField as FieldLike, caret);
      });
    }
    if (root && typeof MutationObserver !== "undefined" && !observedRoots.has(root)) {
      observedRoots.add(root);
      new MutationObserver(refresh).observe(root, { childList: true, subtree: true });
    }
  }
  refresh();
}

/** The field's `\vv` is a document's own: leave it to MathLive. */
export function releaseVvEditorSupport(mathField: HTMLElement): void {
  setBuiltIn(mathField, false);
}
