// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMultiEditorTextRunSpan, replaceActiveTextRunSpan } from "@/components/editor/text-flow/text-run-span";
import type { OverlayShape, ParagraphNode, SigmaBlock } from "@/features/document";
import {
  createDocumentBlocksClipboardPayload,
  createInlineMathClipboardPayload,
  createOverlayClipboardPayload,
  createTextAndShapesClipboardPayload,
  createTextFlowClipboardPayload,
  readEditorClipboardPayload,
  writeEditorClipboardData,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";
import { createTranslator } from "@/lib/i18n";

import { registerEditorClipboardEvents } from "./clipboard-events";
import { INSERT_INLINE_MATH_EVENT } from "./constants";

vi.mock("@/components/editor/text-flow/text-run-span", () => ({
  isMultiEditorTextRunSpan: vi.fn(() => false),
  replaceActiveTextRunSpan: vi.fn(),
}));

type Ports = Parameters<typeof registerEditorClipboardEvents>[0];
const cleanups: Array<() => void> = [];
const t = createTranslator("ja", "editor");
const paragraph: ParagraphNode = { type: "paragraph", id: "source_p", children: [{ type: "text", text: "本文" }] };
const problem: SigmaBlock = {
  type: "problem", id: "source_problem", prompt: [structuredClone(paragraph)], solution: [], tags: [], lead: [], hints: [],
};
const shape: OverlayShape = {
  id: "source_shape", type: "group", x: 10, y: 20, props: { w: 30, h: 40 },
};

function mount(html = '<div data-target></div>'): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>("[data-target]")!;
}

function clipboardData(payload?: EditorClipboardPayload): DataTransfer {
  const data = new DataTransfer();
  if (payload) writeEditorClipboardData(data, payload);
  return data;
}

function dispatch(target: HTMLElement, type: "copy" | "paste", data: DataTransfer | null): ClipboardEvent {
  const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data });
  target.dispatchEvent(event);
  return event;
}

function install(overrides: Partial<Ports> = {}) {
  const ports = {
    overlayEditing: false,
    selectedInlineMath: null,
    getSelectedBlock: vi.fn((): SigmaBlock | null => structuredClone(paragraph)),
    isMaterialEditing: vi.fn(() => false),
    insertBlocks: vi.fn<Ports["insertBlocks"]>(),
    pasteShapes: vi.fn<Ports["pasteShapes"]>(),
    setCanPasteProblem: vi.fn(),
    setStatusMessage: vi.fn(),
    translate: t,
    ...overrides,
  };
  cleanups.push(registerEditorClipboardEvents(ports));
  return ports;
}

beforeEach(() => {
  vi.mocked(isMultiEditorTextRunSpan).mockReturnValue(false);
  // Reset the production fallback via its normal writer. An empty shape payload is not routed.
  clipboardData(createOverlayClipboardPayload([], {}));
});

describe("TikZ paste routing", () => {
  it.each([false, true])("routes plain TikZ before editor handlers (overlay=%s)", (overlayEditing) => {
    const target = mount('<div class="page-flow"><div contenteditable="true" data-target></div></div>');
    const pasteTikz = vi.fn(() => true);
    install({ overlayEditing, pasteTikz });
    const data = clipboardData();
    data.setData("text/plain", "tikz source");
    expect(dispatch(target, "paste", data).defaultPrevented).toBe(true);
    expect(pasteTikz).toHaveBeenCalledWith("tikz source");
  });

  it.each(['<textarea data-target></textarea>', '<input data-target>', '<div role="dialog"><div data-target></div></div>'])("keeps paste in ordinary inputs and dialogs: %s", (html) => {
    const target = mount(html);
    const pasteTikz = vi.fn(() => true);
    install({ pasteTikz });
    const data = clipboardData();
    data.setData("text/plain", "tikz source");
    dispatch(target, "paste", data);
    expect(pasteTikz).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("editor copy ownership", () => {
  it.each([
    ["body block", structuredClone(paragraph), "textFlowBlocks", false, "status.bodyBlockCopied"],
    ["problem", problem, "documentBlocks", true, "status.problemCopied"],
  ] as const)("copies a selected %s with its canonical payload", (_label, block, kind, canPasteProblem, status) => {
    const target = mount();
    const ports = install({ getSelectedBlock: () => block });
    const data = clipboardData();

    expect(dispatch(target, "copy", data).defaultPrevented).toBe(true);
    expect(readEditorClipboardPayload(data)).toMatchObject({ kind, blocks: [block] });
    expect(ports.setCanPasteProblem).toHaveBeenCalledWith(canPasteProblem);
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t(status));
  });

  it.each([
    '<input data-target>',
    '<textarea data-target></textarea>',
    '<div contenteditable="true"><span data-target>本文</span></div>',
    '<math-field data-target></math-field>',
  ])("leaves native copy to the focused surface: %s", (html) => {
    const target = mount(html);
    const ports = install();
    const data = clipboardData();

    expect(dispatch(target, "copy", data).defaultPrevented).toBe(false);
    expect(readEditorClipboardPayload(data)).toBeNull();
    expect(ports.getSelectedBlock).not.toHaveBeenCalled();
  });

  it("leaves a non-collapsed DOM text selection to native copy", () => {
    const target = mount('<div data-target>選択した文字</div>');
    const range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()!.addRange(range);
    const ports = install();

    expect(dispatch(target, "copy", clipboardData()).defaultPrevented).toBe(false);
    expect(ports.getSelectedBlock).not.toHaveBeenCalled();
  });

  it("copies selected inline math from its static view", () => {
    const target = mount('<span class="inline-math-node" data-target></span>');
    const ports = install({ selectedInlineMath: { tex: "x^2" } });
    const data = clipboardData();

    expect(dispatch(target, "copy", data).defaultPrevented).toBe(true);
    expect(readEditorClipboardPayload(data)).toEqual(createInlineMathClipboardPayload("x^2"));
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t("status.mathCopied"));
    expect(ports.setCanPasteProblem).not.toHaveBeenCalled();
  });
});

describe("editor paste ownership", () => {
  it("captures a cross-tab shape paste before the body editor receives it", () => {
    const target = mount('<div class="page-flow"><div contenteditable="true" data-target></div></div>');
    const bodyPaste = vi.fn();
    target.addEventListener("paste", bodyPaste);
    const ports = install();
    const payload = createOverlayClipboardPayload([shape], {}, "source_doc");

    expect(dispatch(target, "paste", clipboardData(payload)).defaultPrevented).toBe(true);
    expect(ports.pasteShapes).toHaveBeenCalledWith(payload);
    expect(bodyPaste).not.toHaveBeenCalled();
    expect(ports.insertBlocks).not.toHaveBeenCalled();
  });

  it.each([
    '<input data-target>',
    '<textarea data-target></textarea>',
    '<select data-target></select>',
    '<math-field><span data-target></span></math-field>',
    '<div contenteditable="true"><span data-target>下書き</span></div>',
  ])("leaves shape paste to a text-only surface: %s", (html) => {
    const target = mount(html);
    const ports = install();
    expect(dispatch(target, "paste", clipboardData(createOverlayClipboardPayload([shape], {}))).defaultPrevented).toBe(false);
    expect(ports.pasteShapes).not.toHaveBeenCalled();
  });

  it("reads the material dialog state at event time", () => {
    const target = mount();
    let materialEditing = false;
    const ports = install({ isMaterialEditing: () => materialEditing });
    materialEditing = true;
    expect(dispatch(target, "paste", clipboardData(createOverlayClipboardPayload([shape], {}))).defaultPrevented).toBe(false);
    expect(ports.pasteShapes).not.toHaveBeenCalled();
  });

  it("does not resurrect shapes from the local fallback when another app copied text", () => {
    const target = mount();
    const ports = install();
    clipboardData(createOverlayClipboardPayload([shape], {}));
    const external = clipboardData();
    external.setData("text/plain", "other application");
    expect(dispatch(target, "paste", external).defaultPrevented).toBe(false);
    expect(ports.pasteShapes).not.toHaveBeenCalled();
    expect(ports.insertBlocks).not.toHaveBeenCalled();
  });

  it("leaves mixed body-and-shape paste to the body editor", () => {
    const target = mount('<div class="page-flow"><div contenteditable="true" data-target></div></div>');
    const bodyPaste = vi.fn();
    target.addEventListener("paste", bodyPaste);
    const ports = install();
    const payload = createTextAndShapesClipboardPayload({ slice: {}, text: "本文" }, [shape], {});

    expect(dispatch(target, "paste", clipboardData(payload)).defaultPrevented).toBe(false);
    expect(bodyPaste).toHaveBeenCalledOnce();
    expect(ports.pasteShapes).not.toHaveBeenCalled();
  });

  it("routes only the shapes of a mixed paste outside the body", () => {
    const target = mount();
    const ports = install();
    const payload = createTextAndShapesClipboardPayload({ slice: {}, text: "本文" }, [shape], {}, "source_doc");

    expect(dispatch(target, "paste", clipboardData(payload)).defaultPrevented).toBe(true);
    expect(ports.pasteShapes).toHaveBeenCalledWith(createOverlayClipboardPayload([shape], {}, "source_doc"));
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t("status.shapesPastedBodyHint"));
  });

  it("inserts cloned document blocks while preserving the original clipboard ids", () => {
    const target = mount('<div contenteditable="true" data-target></div>');
    const ports = install();
    const payload = createDocumentBlocksClipboardPayload([problem]);
    const data = clipboardData(payload);

    expect(dispatch(target, "paste", data).defaultPrevented).toBe(true);
    const [paste] = vi.mocked(ports.insertBlocks).mock.calls[0];
    expect(paste.kind).toBe("documentBlocks");
    expect(paste.blocks[0]).toMatchObject({ type: "problem", prompt: [{ children: paragraph.children }] });
    expect(paste.blocks[0].id).not.toBe(problem.id);
    expect(readEditorClipboardPayload(data)).toEqual(payload);
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t("status.problemPasted"));
  });

  it("waits until cross-editor deletion commits before inserting document blocks", () => {
    vi.useFakeTimers();
    vi.mocked(isMultiEditorTextRunSpan).mockReturnValue(true);
    const target = mount();
    let deletionCommitted = false;
    vi.mocked(replaceActiveTextRunSpan).mockImplementationOnce(() => {
      window.setTimeout(() => { deletionCommitted = true; }, 0);
      return [];
    });
    const ports = install();
    vi.mocked(ports.insertBlocks).mockImplementation(() => { expect(deletionCommitted).toBe(true); });

    expect(dispatch(target, "paste", clipboardData(createDocumentBlocksClipboardPayload([problem]))).defaultPrevented).toBe(true);
    expect(replaceActiveTextRunSpan).toHaveBeenCalledWith([]);
    expect(ports.insertBlocks).not.toHaveBeenCalled();
    expect(ports.setStatusMessage).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(ports.insertBlocks).toHaveBeenCalledOnce();
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t("status.problemPasted"));
  });

  it("preserves the local fallback for body blocks copied through a menu", () => {
    const target = mount();
    const ports = install();
    clipboardData(createTextFlowClipboardPayload([structuredClone(paragraph)]));

    expect(dispatch(target, "paste", clipboardData()).defaultPrevented).toBe(true);
    expect(ports.insertBlocks).toHaveBeenCalledWith({
      kind: "textFlowBlocks", blocks: [expect.objectContaining({ type: "paragraph", children: paragraph.children })],
    });
  });

  it("dispatches inline math insertion without blocking event propagation", () => {
    const target = mount();
    const ports = install();
    const insert = vi.fn();
    const targetPaste = vi.fn();
    window.addEventListener(INSERT_INLINE_MATH_EVENT, insert);
    cleanups.push(() => window.removeEventListener(INSERT_INLINE_MATH_EVENT, insert));
    target.addEventListener("paste", targetPaste);

    expect(dispatch(target, "paste", clipboardData(createInlineMathClipboardPayload("x^2"))).defaultPrevented).toBe(true);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ detail: { tex: "x^2", target: "document" } }));
    expect(targetPaste).toHaveBeenCalledOnce();
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t("status.mathPasted"));
  });

  it("yields both events to the active overlay editor", () => {
    const target = mount();
    const ports = install({ overlayEditing: true });
    const data = clipboardData(createDocumentBlocksClipboardPayload([problem]));
    expect(dispatch(target, "copy", data).defaultPrevented).toBe(false);
    expect(dispatch(target, "paste", data).defaultPrevented).toBe(false);
    expect(ports.insertBlocks).not.toHaveBeenCalled();
    expect(ports.getSelectedBlock).not.toHaveBeenCalled();
  });

  it("removes copy and capture-phase paste listeners together", () => {
    const target = mount();
    const ports = install();
    cleanups.pop()!();
    const data = clipboardData(createDocumentBlocksClipboardPayload([problem]));
    expect(dispatch(target, "copy", data).defaultPrevented).toBe(false);
    expect(dispatch(target, "paste", data).defaultPrevented).toBe(false);
    expect(ports.insertBlocks).not.toHaveBeenCalled();
    expect(ports.getSelectedBlock).not.toHaveBeenCalled();
  });
});

describe("pasting body text onto a whiteboard (no body to paste into)", () => {
  const center = { x: 480, y: 320 };

  function whiteboard(overrides: Partial<Ports> = {}) {
    return install({ bodyless: true, getBodylessPasteCenter: () => center, ...overrides });
  }

  /** 貼られた図形 (payload) から、文章の図形のブロックを取り出す。 */
  function textShapeBlocks(ports: ReturnType<typeof install>) {
    const [payload] = vi.mocked(ports.pasteShapes).mock.calls[0]!;
    const shapes = payload.shapes.filter((shape) => shape.type === "text");
    expect(shapes).toHaveLength(1);
    return shapes[0]!.type === "text" ? shapes[0]!.props.blocks : [];
  }

  it("pastes a copied problem as its text only, at the centre of what is in view", () => {
    const target = mount();
    const ports = whiteboard();
    const full: SigmaBlock = {
      type: "problem",
      id: "source_problem",
      tags: ["代数"],
      lead: [{ type: "paragraph", id: "lead", children: [{ type: "text", text: "導入文" }] }],
      prompt: [{ type: "paragraph", id: "prompt", children: [{ type: "text", text: "問題文" }] }],
      hints: [{ type: "paragraph", id: "hint", children: [{ type: "text", text: "コメント" }] }],
      solution: [{ type: "paragraph", id: "solution", children: [{ type: "text", text: "解答" }] }],
      frame: { enabled: true },
    } as unknown as SigmaBlock;

    const event = dispatch(target, "paste", clipboardData(createDocumentBlocksClipboardPayload([full])));

    expect(event.defaultPrevented).toBe(true);
    expect(ports.pasteShapes).toHaveBeenCalledTimes(1);
    // 紙の範囲へ押し戻さない (パンで負の座標が見えていても、見えている中央へ置く)。
    expect(vi.mocked(ports.pasteShapes).mock.calls[0]![1]).toEqual({ centerAt: center, unbounded: true });
    // テキスト部分だけ: 紙面の並び (導入文 → 問題文 → コメント → 解答) の段落。番号・枠・タグは付かない。
    const blocks = textShapeBlocks(ports);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph"]);
    expect(JSON.stringify(blocks)).not.toMatch(/frame|numbering|tags|problem/);
    expect(blocks.map((block) => block.type === "paragraph" ? block.children.map((child) => child.type === "text" ? child.text : "").join("") : "")).toEqual([
      "導入文", "問題文", "コメント", "解答",
    ]);
    // 本文には何も入れない (ホワイトボードに本文は無い)。
    expect(ports.insertBlocks).not.toHaveBeenCalled();
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t("status.bodyPastedAsTextShape"));
  });

  it("pastes copied body blocks and a copied formula as text shapes too", () => {
    const blocksPorts = whiteboard();
    dispatch(mount(), "paste", clipboardData(createTextFlowClipboardPayload([structuredClone(paragraph)])));
    expect(textShapeBlocks(blocksPorts)).toMatchObject([{ type: "paragraph", children: [{ type: "text", text: "本文" }] }]);

    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.clearAllMocks();
    const mathPorts = whiteboard();
    dispatch(mount(), "paste", clipboardData(createInlineMathClipboardPayload("x^2")));
    expect(textShapeBlocks(mathPorts)).toMatchObject([{ type: "paragraph", children: [{ type: "mathInline", tex: "x^2" }] }]);
  });

  it("falls back to no centre when the view cannot say where the middle is", () => {
    const ports = whiteboard({ getBodylessPasteCenter: () => null });

    dispatch(mount(), "paste", clipboardData(createTextFlowClipboardPayload([structuredClone(paragraph)])));

    expect(vi.mocked(ports.pasteShapes).mock.calls[0]![1]).toBeUndefined();
  });

  it("leaves a paper page alone: there the body takes the paste as before", () => {
    const ports = install({ getBodylessPasteCenter: () => center });
    const target = mount();

    dispatch(target, "paste", clipboardData(createDocumentBlocksClipboardPayload([problem])));

    expect(ports.pasteShapes).not.toHaveBeenCalled();
    expect(ports.insertBlocks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a text shape being edited", '<div contenteditable="true" data-target></div>'],
    ["a text field", "<textarea data-target></textarea>"],
    ["a dialog", '<div role="dialog"><div data-target></div></div>'],
  ])("leaves a paste into %s to that surface", (_name, html) => {
    const ports = whiteboard();
    const target = mount(html);

    dispatch(target, "paste", clipboardData(createDocumentBlocksClipboardPayload([problem])));

    expect(ports.pasteShapes).not.toHaveBeenCalled();
  });

  it("leaves a paste to the material dialog while it is open", () => {
    const ports = whiteboard({ isMaterialEditing: vi.fn(() => true) });

    dispatch(mount(), "paste", clipboardData(createDocumentBlocksClipboardPayload([problem])));

    expect(ports.pasteShapes).not.toHaveBeenCalled();
  });

  it("does not turn text from another app into a shape", () => {
    const ports = whiteboard();
    const data = clipboardData();
    data.setData("text/plain", "他のアプリの文章");

    const event = dispatch(mount(), "paste", data);

    expect(event.defaultPrevented).toBe(false);
    expect(ports.pasteShapes).not.toHaveBeenCalled();
  });

  it("keeps pasting shapes the way it did", () => {
    const ports = whiteboard();
    const payload = createOverlayClipboardPayload([shape], {}, "source_doc");

    dispatch(mount(), "paste", clipboardData(payload));

    expect(ports.pasteShapes).toHaveBeenCalledWith(payload);
    expect(ports.setStatusMessage).toHaveBeenCalledWith(t("status.shapesPasted"));
  });
});
