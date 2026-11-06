import { describe, expect, it } from "vitest";

import { serializeEditorVector, vvCaretTarget } from "@/lib/mathlive-vv-editor";

const L = String.raw;

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
  // Offsets as MathLive 0.111 numbers them for `x\vv{AB}+1` (checked in mathlive-vv-editor-real.test.ts):
  // 0 root start, 1 x, 2 macro start, 3 operand start, 4 A, 5 B, 6 slot start, 7 phantom start,
  // 8 rule, 9 phantom, 10 the box, 11 the macro, 12 +, 13 1.
  type Atom = { command?: string; type?: string; parentBranch?: string; parent?: Atom; leftSibling?: Atom; body?: Atom[]; branch?: (n: string) => Atom[] };
  const x: Atom = { command: "x" };
  const macro: Atom = { command: L`\vv`, type: "macro", leftSibling: x };
  const box: Atom = { command: L`\overset`, parent: macro, parentBranch: "body" };
  const operand: Atom[] = [{ type: "first" }, { command: "A" }, { command: "B" }].map((a) => ({ ...a, parent: box, parentBranch: "body" }));
  const phantom: Atom = { command: L`\phantom`, parent: box, parentBranch: "above" };
  const slot: Atom[] = [{ type: "first", parent: box, parentBranch: "above" }, phantom];
  const inPhantom: Atom[] = [{ type: "first" }, { command: L`\rule` }].map((a) => ({ ...a, parent: phantom, parentBranch: "body" }));
  const macroFirst: Atom = { type: "first", parent: macro, parentBranch: "body" };
  macro.body = [macroFirst, box];
  box.branch = (name) => (name === "body" ? operand : slot);
  const atoms: Atom[] = [{ type: "first" }, x, macroFirst, ...operand, slot[0], ...inPhantom, phantom, box, macro, { command: "+" }, { command: "1" }];
  const model = { at: (offset: number) => atoms[offset], offsetOf: (atom: Atom) => atoms.indexOf(atom) } as unknown as Parameters<typeof vvCaretTarget>[0];

  it("keeps the caret on the operand and skips the macro edges and the whole invisible slot", () => {
    expect(vvCaretTarget(model, 2, true)).toBe(3); // entering: operand start
    expect(vvCaretTarget(model, 2, false)).toBe(1); // leaving backwards: before the vector
    expect(vvCaretTarget(model, 10, false)).toBe(5); // back from the box: operand end
    for (const offset of [6, 7, 8, 9]) {
      expect(vvCaretTarget(model, offset, true)).toBe(11); // past the operand: after the vector
      expect(vvCaretTarget(model, offset, false)).toBe(5); // back into the operand's end
    }
    for (const offset of [0, 1, 3, 4, 5, 11, 12, 13]) expect(vvCaretTarget(model, offset, true)).toBeNull();
  });
});
