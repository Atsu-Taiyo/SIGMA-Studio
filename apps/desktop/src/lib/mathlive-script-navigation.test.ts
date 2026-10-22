import { describe, expect, it, vi } from "vitest";

import { getScriptBranchArrowDirection, moveBetweenScriptBranches } from "@/lib/mathlive-script-navigation";

type FakeAtom = {
  id: string;
  mode?: string;
  parent?: FakeAtom;
  parentBranch?: unknown;
  type: string;
  branch: (name: string) => FakeAtom[] | undefined;
  branches: Record<string, FakeAtom[]>;
};

/**
 * MathLive の原子の木の代わり。`atom("int", { subscript: [...], superscript: [...] })` のように組み、
 * 平らな `atoms` は深さ優先で、枠ごとに先頭の "first" 原子を置く (MathLive のモデルと同じ並び)。
 */
function atom(id: string, branches: Record<string, FakeAtom[]> = {}, extra: { mode?: string; type?: string } = {}): FakeAtom {
  const result: FakeAtom = {
    id,
    type: extra.type ?? "mord",
    ...(extra.mode ? { mode: extra.mode } : {}),
    branches,
    branch: (name) => result.branches[name],
  };
  return result;
}

function build(body: FakeAtom[]) {
  const root = atom("root", { body }, { type: "root" });
  const atoms: FakeAtom[] = [];
  const attach = (parent: FakeAtom, name: string, children: FakeAtom[]) => {
    const first = atom(`${parent.id}.${name}.first`, {}, { type: "first" });
    const list = [first, ...children];
    parent.branches[name] = list;
    for (const child of list) {
      child.parent = parent;
      child.parentBranch = name;
    }
  };
  const visit = (node: FakeAtom) => {
    atoms.push(node);
    for (const [name, children] of Object.entries(node.branches)) {
      attach(node, name, children.filter((child) => child.type !== "first"));
      for (const child of node.branches[name]) visit(child);
    }
  };
  // 配列のセルの枠名は [行, 列] なので、attach の前にそのまま使えるよう文字列の枠だけを扱う。
  visit(root);
  return { atoms, root };
}

function fakeMathField(
  atoms: FakeAtom[],
  caret: { anchor: number; position: number },
  options: { hasEditablePrompts?: boolean } = {},
) {
  const setPositionHandlingPlaceholder = vi.fn();
  const stopCoalescingUndo = vi.fn();
  const model = {
    anchor: caret.anchor,
    mathfield: { hasEditablePrompts: options.hasEditablePrompts ?? false, stopCoalescingUndo },
    position: caret.position,
    at: (offset: number) => atoms[offset],
    offsetOf: (target: FakeAtom) => atoms.indexOf(target),
    setPositionHandlingPlaceholder,
  };
  return { field: { _mathfield: { model } }, setPositionHandlingPlaceholder, stopCoalescingUndo };
}

const offsetOf = (atoms: FakeAtom[], id: string) => atoms.findIndex((candidate) => candidate.id === id);

describe("moveBetweenScriptBranches", () => {
  // \int_{a}^{bc}
  const definiteIntegral = () => {
    const tree = build([atom("int", { subscript: [atom("a")], superscript: [atom("b"), atom("c")] })]);
    return tree.atoms;
  };

  it("moves from the superscript into the subscript of the same atom with ArrowDown, to the end of it", () => {
    const atoms = definiteIntegral();
    const caret = offsetOf(atoms, "c");
    const { field, setPositionHandlingPlaceholder, stopCoalescingUndo } = fakeMathField(atoms, { anchor: caret, position: caret });

    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    expect(setPositionHandlingPlaceholder).toHaveBeenCalledExactlyOnceWith(offsetOf(atoms, "a"));
    expect(stopCoalescingUndo).toHaveBeenCalledOnce();
  });

  it("moves from the subscript into the superscript with ArrowUp, to the end of it", () => {
    const atoms = definiteIntegral();
    const caret = offsetOf(atoms, "a");
    const { field, setPositionHandlingPlaceholder } = fakeMathField(atoms, { anchor: caret, position: caret });

    expect(moveBetweenScriptBranches(field, "up")).toBe(true);
    expect(setPositionHandlingPlaceholder).toHaveBeenCalledExactlyOnceWith(offsetOf(atoms, "c"));
  });

  it("works from the start of a branch, where the caret sits on the branch's first atom", () => {
    const atoms = definiteIntegral();
    const caret = offsetOf(atoms, "int.superscript.first");
    const { field, setPositionHandlingPlaceholder } = fakeMathField(atoms, { anchor: caret, position: caret });

    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    expect(setPositionHandlingPlaceholder).toHaveBeenCalledWith(offsetOf(atoms, "a"));
  });

  it("goes into an empty opposite branch (only its first atom)", () => {
    const atoms = build([atom("x", { subscript: [], superscript: [atom("2")] })]).atoms;
    const caret = offsetOf(atoms, "2");
    const { field, setPositionHandlingPlaceholder } = fakeMathField(atoms, { anchor: caret, position: caret });

    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    expect(setPositionHandlingPlaceholder).toHaveBeenCalledWith(offsetOf(atoms, "x.subscript.first"));
  });

  it("takes a selection by its right end for ArrowDown and by its left end for ArrowUp", () => {
    const atoms = definiteIntegral();
    const inSuperscript = { anchor: offsetOf(atoms, "int.superscript.first"), position: offsetOf(atoms, "c") };
    const inSubscript = { anchor: offsetOf(atoms, "int.subscript.first"), position: offsetOf(atoms, "a") };

    const down = fakeMathField(atoms, inSuperscript);
    expect(moveBetweenScriptBranches(down.field, "down")).toBe(true);
    expect(down.setPositionHandlingPlaceholder).toHaveBeenCalledWith(offsetOf(atoms, "a"));

    const up = fakeMathField(atoms, { anchor: inSubscript.position, position: inSubscript.anchor });
    expect(moveBetweenScriptBranches(up.field, "up")).toBe(true);
    expect(up.setPositionHandlingPlaceholder).toHaveBeenCalledWith(offsetOf(atoms, "c"));
  });

  it("leaves MathLive alone when the atom has only one of the two scripts", () => {
    const onlySuperscript = build([atom("x", { superscript: [atom("2")] })]).atoms;
    const onlySubscript = build([atom("y", { subscript: [atom("1")] })]).atoms;
    const down = fakeMathField(onlySuperscript, { anchor: offsetOf(onlySuperscript, "2"), position: offsetOf(onlySuperscript, "2") });
    const up = fakeMathField(onlySubscript, { anchor: offsetOf(onlySubscript, "1"), position: offsetOf(onlySubscript, "1") });

    expect(moveBetweenScriptBranches(down.field, "down")).toBe(false);
    expect(moveBetweenScriptBranches(up.field, "up")).toBe(false);
    expect(down.setPositionHandlingPlaceholder).not.toHaveBeenCalled();
    expect(up.setPositionHandlingPlaceholder).not.toHaveBeenCalled();
  });

  it("does nothing for the directions that have no target: ArrowUp in the superscript, ArrowDown in the subscript", () => {
    const atoms = definiteIntegral();
    const sup = offsetOf(atoms, "c");
    const sub = offsetOf(atoms, "a");

    expect(moveBetweenScriptBranches(fakeMathField(atoms, { anchor: sup, position: sup }).field, "up")).toBe(false);
    expect(moveBetweenScriptBranches(fakeMathField(atoms, { anchor: sub, position: sub }).field, "down")).toBe(false);
  });

  it("leaves a caret outside any script alone", () => {
    const atoms = build([atom("int", { subscript: [atom("a")], superscript: [atom("b")] }), atom("f")]).atoms;
    const afterFormula = offsetOf(atoms, "f");
    const onTheIntegral = offsetOf(atoms, "int");

    expect(moveBetweenScriptBranches(fakeMathField(atoms, { anchor: afterFormula, position: afterFormula }).field, "down")).toBe(false);
    expect(moveBetweenScriptBranches(fakeMathField(atoms, { anchor: onTheIntegral, position: onTheIntegral }).field, "up")).toBe(false);
  });

  it("uses the innermost script branch, and does not climb to the enclosing one", () => {
    // x_{p}^{ y_{q}^{r} } : r は y の上付きの中。y は下付き q を持つので、↓ は q へ (x の下付き p ではない)。
    const y = atom("y", { subscript: [atom("q")], superscript: [atom("r")] });
    const x = atom("x", { subscript: [atom("p")], superscript: [y] });
    const atoms = build([x]).atoms;
    const inR = offsetOf(atoms, "r");
    const { field, setPositionHandlingPlaceholder } = fakeMathField(atoms, { anchor: inR, position: inR });

    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    expect(setPositionHandlingPlaceholder).toHaveBeenCalledExactlyOnceWith(offsetOf(atoms, "q"));

    // x_{p}^{ z^{s} } : s の上付きを持つ z には下付きが無いので、x の下付きへは登らず MathLive にまかせる。
    const z = atom("z", { superscript: [atom("s")] });
    const nested = build([atom("x2", { subscript: [atom("p2")], superscript: [z] })]).atoms;
    const inS = offsetOf(nested, "s");
    expect(moveBetweenScriptBranches(fakeMathField(nested, { anchor: inS, position: inS }).field, "down")).toBe(false);
  });

  it("looks through other containers (a root's body, a square root) to the script they sit in", () => {
    const sqrt = atom("sqrt", { body: [atom("n")] }, { type: "surd" });
    const atoms = build([atom("int", { subscript: [atom("a")], superscript: [sqrt] })]).atoms;
    const inN = offsetOf(atoms, "n");
    const { field, setPositionHandlingPlaceholder } = fakeMathField(atoms, { anchor: inN, position: inN });

    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    expect(setPositionHandlingPlaceholder).toHaveBeenCalledWith(offsetOf(atoms, "a"));
  });

  it("leaves fractions, root indices and array cells to MathLive even inside a script", () => {
    const fraction = atom("frac", { above: [atom("num")], below: [atom("den")] }, { type: "genfrac" });
    const atoms = build([atom("int", { subscript: [atom("a")], superscript: [fraction] })]).atoms;
    for (const id of ["num", "den"]) {
      const caret = offsetOf(atoms, id);
      expect(moveBetweenScriptBranches(fakeMathField(atoms, { anchor: caret, position: caret }).field, "down"), id).toBe(false);
    }

    const index = atom("surd", { above: [atom("idx")], body: [atom("rad")] }, { type: "surd" });
    const rooted = build([atom("int2", { subscript: [atom("b")], superscript: [index] })]).atoms;
    const inIndex = offsetOf(rooted, "idx");
    expect(moveBetweenScriptBranches(fakeMathField(rooted, { anchor: inIndex, position: inIndex }).field, "down")).toBe(false);

    const cell = atom("cell");
    const array = atom("array", {}, { type: "array" });
    const arrayAtoms = build([atom("int3", { subscript: [atom("c")], superscript: [array] })]).atoms;
    cell.parent = array;
    cell.parentBranch = [0, 0];
    arrayAtoms.push(cell);
    const inCell = arrayAtoms.length - 1;
    expect(moveBetweenScriptBranches(fakeMathField(arrayAtoms, { anchor: inCell, position: inCell }).field, "down")).toBe(false);
  });

  it("leaves LaTeX-command typing (suggestion popover) and editable prompts to MathLive", () => {
    const latex = atom("latex", {}, { mode: "latex", type: "latex" });
    const atoms = build([atom("int", { subscript: [atom("a")], superscript: [latex] })]).atoms;
    const inLatex = offsetOf(atoms, "latex");
    expect(moveBetweenScriptBranches(fakeMathField(atoms, { anchor: inLatex, position: inLatex }).field, "down")).toBe(false);

    const plain = definitionOfIntegral();
    const caret = offsetOf(plain, "b");
    const prompts = fakeMathField(plain, { anchor: caret, position: caret }, { hasEditablePrompts: true });
    expect(moveBetweenScriptBranches(prompts.field, "down")).toBe(false);
    expect(prompts.setPositionHandlingPlaceholder).not.toHaveBeenCalled();
  });

  it("does nothing when MathLive's internal model is not reachable", () => {
    for (const field of [null, undefined, {}, { _mathfield: {} }, { _mathfield: { model: {} } }]) {
      expect(moveBetweenScriptBranches(field, "down")).toBe(false);
    }
  });
});

function definitionOfIntegral() {
  return build([atom("int", { subscript: [atom("a")], superscript: [atom("b")] })]).atoms;
}

describe("getScriptBranchArrowDirection", () => {
  const key = (name: string, overrides: Partial<Parameters<typeof getScriptBranchArrowDirection>[0]> = {}) => ({
    altKey: false,
    ctrlKey: false,
    key: name,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("picks only plain ArrowUp and ArrowDown", () => {
    expect(getScriptBranchArrowDirection(key("ArrowUp"))).toBe("up");
    expect(getScriptBranchArrowDirection(key("ArrowDown"))).toBe("down");
    expect(getScriptBranchArrowDirection(key("ArrowLeft"))).toBeNull();
    expect(getScriptBranchArrowDirection(key("a"))).toBeNull();
  });

  it("ignores Shift selection, other modifiers and IME keystrokes", () => {
    for (const overrides of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(getScriptBranchArrowDirection(key("ArrowDown", overrides)), JSON.stringify(overrides)).toBeNull();
    }
  });
});
