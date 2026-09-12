import { describe, expect, it } from "vitest";

import { resolveTexBracketEdit, type TexBracketKeyEventLike } from "@/lib/tex-bracket-pairs";

function keyEvent(key: string, overrides: Partial<TexBracketKeyEventLike> = {}): TexBracketKeyEventLike {
  return { altKey: false, ctrlKey: false, key, metaKey: false, ...overrides };
}

/**
 * `|` をキャレット、`«..»` を選択範囲として書ける短縮記法。角括弧は TeX 本文にも
 * 現れるので、選択の印には使えない。
 */
function edit(key: string, marked: string, overrides: Partial<TexBracketKeyEventLike> = {}): string | null {
  const caret = marked.indexOf("|");
  const selectionStart = caret >= 0 ? caret : marked.indexOf("«");
  const selectionEnd = caret >= 0 ? caret : marked.indexOf("»") - 1;
  const value = marked.replace(/[|«»]/g, "");
  const edit = resolveTexBracketEdit(keyEvent(key, overrides), { selectionEnd, selectionStart, value });
  if (!edit) {
    return null;
  }

  const nextValue = `${value.slice(0, edit.from)}${edit.insert}${value.slice(edit.to)}`;
  return edit.selectionStart === edit.selectionEnd
    ? `${nextValue.slice(0, edit.selectionStart)}|${nextValue.slice(edit.selectionStart)}`
    : `${nextValue.slice(0, edit.selectionStart)}«${nextValue.slice(edit.selectionStart, edit.selectionEnd)}»${nextValue.slice(edit.selectionEnd)}`;
}

describe("TeX bracket pairs", () => {
  it("closes an opening bracket at the end of the input", () => {
    expect(edit("(", "|")).toBe("(|)");
    expect(edit("{", "\\frac|")).toBe("\\frac{|}");
    expect(edit("[", "\\sqrt|")).toBe("\\sqrt[|]");
  });

  it("closes an escaped curly bracket with an escaped closing bracket", () => {
    expect(edit("{", "\\|")).toBe("\\{|\\}");
    expect(edit("{", "\\\\|")).toBe("\\\\{|}");
  });

  it("closes before whitespace and before an existing closing bracket", () => {
    expect(edit("(", "| x")).toBe("(|) x");
    expect(edit("{", "\\frac{a}{|}")).toBe("\\frac{a}{{|}}");
    expect(edit("(", "|)")).toBe("(|))");
  });

  // `(` を既存の項の直前で打ったときに `()x+1` になるのを防ぐ (CodeMirror と同じ規則)。
  // ここでは自動で閉じず、末尾で `)` を打てば `(x+1)` になる。
  it("leaves an opening bracket alone when a term follows the caret", () => {
    expect(edit("(", "|x+1")).toBeNull();
    expect(edit("{", "|\\alpha")).toBeNull();
  });

  it("wraps the selection instead of replacing it", () => {
    expect(edit("(", "«x+1»")).toBe("(«x+1»)");
    expect(edit("{", "\\frac«a»+b")).toBe("\\frac{«a»}+b");
    // 直後に項が続いていても、選択があるときは必ず囲う。
    expect(edit("(", "a+«x»+1")).toBe("a+(«x»)+1");
  });

  it("skips over a closing bracket instead of doubling it", () => {
    expect(edit(")", "(x|)")).toBe("(x)|");
    expect(edit("}", "\\frac{a|}")).toBe("\\frac{a}|");
    expect(edit("]", "[|]")).toBe("[]|");
    expect(edit("}", "\\{x|\\}")).toBe("\\{x\\}|");
  });

  it("types a closing bracket normally when the next character is different", () => {
    expect(edit(")", "(x|")).toBeNull();
    expect(edit(")", "(x|+1")).toBeNull();
  });

  it("deletes both halves of an empty pair on backspace", () => {
    expect(edit("Backspace", "(|)")).toBe("|");
    expect(edit("Backspace", "\\frac{|}")).toBe("\\frac|");
    expect(edit("Backspace", "a[|]b")).toBe("a|b");
    expect(edit("Backspace", "\\{|\\}")).toBe("|");
  });

  it("leaves backspace alone outside an empty pair", () => {
    expect(edit("Backspace", "(x|)")).toBeNull();
    expect(edit("Backspace", "|")).toBeNull();
    expect(edit("Backspace", "(x)|")).toBeNull();
  });

  // Ctrl / Alt 系はショートカット (Ctrl+[ など) が先に取るので、ここでは何もしない。
  it("ignores modified and composing keystrokes", () => {
    expect(edit("(", "|", { ctrlKey: true })).toBeNull();
    expect(edit("(", "|", { metaKey: true })).toBeNull();
    expect(edit("[", "|", { altKey: true })).toBeNull();
    expect(edit("(", "|", { isComposing: true })).toBeNull();
    expect(edit("(", "|", { keyCode: 229 })).toBeNull();
  });

  it("ignores keys that are not brackets", () => {
    expect(edit("a", "|")).toBeNull();
    expect(edit("Enter", "(|)")).toBeNull();
  });
});
