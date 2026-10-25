// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProblemSettingsDialog } from "@/components/editor/ProblemSettingsDialog";
import { ProblemNumberLayoutSettings } from "@/components/editor/ProblemLayoutSettings";
import type { ProblemNode } from "@/features/document";
import { setAppLocale } from "@/lib/i18n/react";

let container: HTMLDivElement;
let root: Root;
let current: ProblemNode;

/** Applies the dialog's changes the way the page editor does, so the dialog sees its own edits. */
function Host({ initial, onProblem }: { initial: ProblemNode; onProblem: (problem: ProblemNode) => void }) {
  const [problem, setProblem] = useState(initial);
  useEffect(() => onProblem(problem), [problem, onProblem]);
  return <ProblemSettingsDialog problem={problem} onChange={(updater) => setProblem(updater)} onClose={vi.fn()} />;
}

function createProblem(tags: string[] = []): ProblemNode {
  return {
    type: "problem",
    id: "problem_1",
    tags,
    lead: [],
    prompt: [{ type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "問題文" }] }],
    solution: [],
    hints: [],
  };
}

it("commits number fonts without blur and reflects canonical external updates", async () => {
  current = createProblem();
  const onChange = (update: (problem: ProblemNode) => ProblemNode) => { current = update(current); };
  const renderField = () => act(async () => root.render(<ProblemNumberLayoutSettings problem={current} onChange={onChange} />));
  await renderField();
  const field = () => document.body.querySelector<HTMLInputElement>('[data-testid="problem-number-font-family"]')!;
  const write = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await write('"Noto Serif JP", serif');
  expect(current.numbering?.fontFamily).toBe('"Noto Serif JP", serif');
  current = { ...current, numbering: { ...current.numbering, fontFamily: "monospace" } };
  await renderField();
  expect(field().value).toBe("monospace");
  await write("serif;position:fixed");
  expect(current.numbering?.fontFamily).toBe("monospace");
});

async function render(initial = createProblem()) {
  const onProblem = (problem: ProblemNode) => {
    current = problem;
  };
  await act(async () => root.render(<Host initial={initial} onProblem={onProblem} />));
}

const tagInput = () => document.body.querySelector<HTMLInputElement>(".problem-tag-input-shell input")!;
const chips = () => Array.from(document.body.querySelectorAll(".problem-tag-tip-label"), (chip) => chip.textContent);

/** Writes the field the way the browser does (React only reports a value its tracker has not seen). */
async function input(value: string, isComposing = false) {
  await act(async () => {
    const field = tagInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
  });
}

async function key(name: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    tagInput().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
}

async function composition(type: "compositionstart" | "compositionend", data = "") {
  await act(async () => {
    tagInput().dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
  });
}

/**
 * The Japanese IME as Chromium on macOS delivers it: the Enter that confirms the conversion arrives
 * while the text is still being composed (`isComposing`, keyCode 229), and the confirmed text is
 * written into the field after that keydown, before `compositionend`.
 */
async function composeWithIme(steps: readonly string[], committed: string) {
  await composition("compositionstart");
  for (const step of steps) {
    await input(step, true);
  }
  await key("Enter", { isComposing: true, keyCode: 229 });
  await input(committed, true);
  await composition("compositionend", committed);
}

beforeEach(() => {
  setAppLocale("ja");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ProblemSettingsDialog tags", () => {
  it("leaves the Enter that confirms an IME conversion to the IME, then turns the confirmed word into a chip", async () => {
    await render();

    await composeWithIme(["び", "びぶ", "びぶん", "微分"], "微分");
    // The confirmation only confirms: no chip yet, and the word stays where it was typed.
    expect(current.tags).toEqual([]);
    expect(tagInput().value).toBe("微分");

    await key("Enter", { keyCode: 13 });
    expect(current.tags).toEqual(["微分"]);
    expect(chips()).toEqual(["微分"]);
    // The word moved into the chip; nothing of it is left in the field to become a second tag.
    expect(tagInput().value).toBe("");
  });

  it("splits at a separator only once the IME has confirmed the text", async () => {
    await render();

    // A half-converted reading must not become a chip just because the separator is typed in it.
    await composeWithIme(["びぶん", "びぶん、", "びぶん、せきぶん", "微分、積分"], "微分、積分");
    expect(current.tags).toEqual(["微分"]);
    expect(tagInput().value).toBe("積分");

    await key("Enter", { keyCode: 13 });
    expect(current.tags).toEqual(["微分", "積分"]);
    expect(tagInput().value).toBe("");
  });

  it("keeps the typed (non-IME) flow: Enter, separators, symbols and deleting chips", async () => {
    await render(createProblem(["既存"]));

    await input("C++/数II");
    await key("Enter", { keyCode: 13 });
    expect(current.tags).toEqual(["既存", "C++/数II"]);
    expect(tagInput().value).toBe("");

    await input("a, b");
    expect(current.tags).toEqual(["既存", "C++/数II", "a"]);
    expect(tagInput().value).toBe(" b");
    await key("Enter", { keyCode: 13 });
    expect(current.tags).toEqual(["既存", "C++/数II", "a", "b"]);

    // Backspace in the empty field takes the last chip; a chip's own button takes that chip.
    await key("Backspace", { keyCode: 8 });
    expect(current.tags).toEqual(["既存", "C++/数II", "a"]);
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="既存 を削除"]')!.click());
    expect(current.tags).toEqual(["C++/数II", "a"]);
  });

  it("does not delete a chip with the Backspace that edits an IME composition", async () => {
    await render(createProblem(["微分"]));

    await composition("compositionstart");
    await input("び", true);
    await input("", true);
    // The last composing character is gone, but this Backspace still belongs to the IME.
    await key("Backspace", { isComposing: true, keyCode: 229 });
    await composition("compositionend");
    expect(current.tags).toEqual(["微分"]);
  });
});

describe("ProblemSettingsDialog lead line", () => {
  const leadSwitch = () => document.body.querySelector<HTMLInputElement>('[data-testid="problem-lead-shown"]')!;

  it("turns the lead line off and back on, leaving no layout behind", async () => {
    await render();
    expect(leadSwitch().checked).toBe(true);
    expect(leadSwitch().disabled).toBe(false);

    await act(async () => leadSwitch().click());
    expect(current.areaLayout).toEqual({ lead: { hidden: true } });
    expect(leadSwitch().checked).toBe(false);

    await act(async () => leadSwitch().click());
    expect(current.areaLayout).toBeUndefined();
    expect(leadSwitch().checked).toBe(true);
  });

  it("warns that the lead text goes, then throws it away when the line is turned off", async () => {
    await render({
      ...createProblem(),
      lead: [{ type: "paragraph", id: "lead_1", children: [{ type: "text", text: "次の問いに答えよ。" }] }],
    });

    expect(leadSwitch().checked).toBe(true);
    expect(leadSwitch().disabled).toBe(false);
    expect(document.body.textContent).toContain("導入文の文字は削除されます");

    await act(async () => leadSwitch().click());
    expect(current.lead).toEqual([]);
    expect(current.areaLayout).toEqual({ lead: { hidden: true } });
    expect(leadSwitch().checked).toBe(false);

    // もう一度オンにしても、捨てた文字は戻らない。行だけが空で戻る。
    await act(async () => leadSwitch().click());
    expect(current.lead).toEqual([]);
    expect(current.areaLayout).toBeUndefined();
    expect(leadSwitch().checked).toBe(true);
  });

  it("turns off a lead that was written after the line was switched off", async () => {
    await render({
      ...createProblem(),
      lead: [{ type: "paragraph", id: "lead_1", children: [{ type: "text", text: "AIが書いた導入文" }] }],
      areaLayout: { lead: { hidden: true } },
    });

    // 文字があるので行は描かれている: チェックはオンに見え、外すと捨てて畳む。
    expect(leadSwitch().checked).toBe(true);
    await act(async () => leadSwitch().click());
    expect(current.lead).toEqual([]);
    expect(leadSwitch().checked).toBe(false);
  });
});
