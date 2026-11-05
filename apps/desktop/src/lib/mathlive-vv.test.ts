import { describe, expect, it } from "vitest";
import { installVvEditorSupport, installVvSerialization, serializeEditorVector, vvCaretTarget } from "@/lib/mathlive-vv";
const L = String.raw;

describe("vector serialization ownership", () => {
  class Macro {
    type = "macro";
    command = L`\vv`;
    body = [{ command: L`\overset`, bodyToLatex: () => "ACB" }];
    _serialize(options: object) { void options; return L`\vv{AB}`; }
  }
  it("updates only the built-in atom, leaving the shared prototype and custom fields unchanged", () => {
    const builtIn = new Macro(), custom = new Macro();
    const original = Macro.prototype._serialize;
    const field = { _mathfield: { model: { atoms: [builtIn] } } };
    expect(installVvSerialization(field)).toBe(true);
    expect(builtIn._serialize({})).toBe(L`\vv{ACB}`);
    expect(custom._serialize({})).toBe(L`\vv{AB}`);
    expect(Macro.prototype._serialize).toBe(original);
    const installed = builtIn._serialize;
    installVvSerialization(field);
    expect(builtIn._serialize).toBe(installed);
  });
  it("stops old listeners when the same field is reconfigured with a custom macro", () => {
    const builtIn = new Macro(), custom = new Macro();
    const model = { atoms: [builtIn] };
    const field = Object.assign(new EventTarget(), { _mathfield: { model } }) as unknown as HTMLElement;
    installVvEditorSupport(field, true);
    expect(builtIn._serialize({})).toBe(L`\vv{ACB}`);
    model.atoms = [custom];
    installVvEditorSupport(field, false);
    field.dispatchEvent(new Event("input"));
    field.dispatchEvent(new Event("selection-change"));
    expect(custom._serialize({})).toBe(L`\vv{AB}`);
    expect(Object.hasOwn(custom, "_serialize")).toBe(false);
  });
});

describe("editor serialization of \\vv", () => {
  type Atom = Parameters<typeof serializeEditorVector>[0];
  interface Fields { type?: string; command?: string; body?: Atom[]; latex?: string }
  const atom = ({ latex = "", ...fields }: Fields): Atom => {
    const result = { ...fields, bodyToLatex: () => latex };
    // MathLive's Atom.serialize(list), reached through the instance's class.
    Object.defineProperty(result, "constructor", { value: { serialize: (list: Atom[]) => list.map((a) => a.bodyToLatex?.({}) ?? "").join("") } });
    return result as unknown as Atom;
  };
  it("writes the CURRENT operand of the box, not MathLive's parse-time macro arguments", () => {
    const vectorBox = atom({ command: L`\overset`, latex: "ACB" });
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [atom({ type: "first" }), vectorBox] }), {})).toBe(L`\vv{ACB}`);
  });
  it("keeps editor-inserted neighbours outside the vector and ignores other macros", () => {
    const vectorBox = atom({ command: L`\overset`, latex: "AB" });
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [atom({ latex: "2" }), vectorBox, atom({ latex: "x" })] }), {})).toBe(L`2\vv{AB}x`);
    expect(serializeEditorVector(atom({ command: L`\kyoutsuuchoice`, body: [vectorBox] }), {})).toBeNull();
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [atom({ latex: "z" })] }), {})).toBeNull();
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [vectorBox] }), { expandMacro: true })).toBe(L`\vv{AB}`);
  });
});

describe("editor caret inside \\vv", () => {
  // Offsets as MathLive numbers them for `x\vv{AB}+1`: 0 root start, 1 x, 2 macro start,
  // 3 box operand start, 4 A, 5 B, 6 slot start, 7 phantom, 8 after box, 9 after macro.
  type Atom = { command?: string; type?: string; parentBranch?: string; parent?: Atom; leftSibling?: Atom; body?: Atom[]; branch?: (n: string) => Atom[] };
  const x: Atom = { command: "x" };
  const macro: Atom = { command: L`\vv`, type: "macro", leftSibling: x };
  const box: Atom = { command: L`\overset`, parent: macro };
  const operand: Atom[] = [{ type: "first" }, { command: "A" }, { command: "B" }].map((a) => ({ ...a, parent: box, parentBranch: "body" }));
  const slot: Atom[] = [{ type: "first" }, { command: L`\phantom` }].map((a) => ({ ...a, parent: box, parentBranch: "above" }));
  const macroFirst: Atom = { type: "first", parent: macro, parentBranch: "body" };
  macro.body = [macroFirst, box];
  box.branch = (name) => (name === "body" ? operand : slot);
  const atoms: Atom[] = [{ type: "first" }, x, macroFirst, operand[0], operand[1], operand[2], slot[0], slot[1], box, macro];
  const model = { at: (offset: number) => atoms[offset], offsetOf: (atom: Atom) => atoms.indexOf(atom) } as unknown as Parameters<typeof vvCaretTarget>[0];

  it("keeps the caret on the operand and skips the macro edges and the invisible slot", () => {
    expect(vvCaretTarget(model, 2, true)).toBe(3); // entering: operand start
    expect(vvCaretTarget(model, 2, false)).toBe(1); // leaving backwards: before the vector
    expect(vvCaretTarget(model, 6, true)).toBe(9); // past the operand: after the vector
    expect(vvCaretTarget(model, 7, false)).toBe(5); // back from the slot: operand end
    expect(vvCaretTarget(model, 8, false)).toBe(5);
    for (const offset of [0, 1, 3, 4, 5, 9]) expect(vvCaretTarget(model, offset, true)).toBeNull();
  });
});
