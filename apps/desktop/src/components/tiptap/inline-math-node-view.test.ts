import { getSchema } from "@tiptap/core";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InlineMathNodeView } from "@/components/tiptap/inline-math-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { renderMathHtml } from "@/features/rendering/adapters";

/**
 * 数式ノードの表示は素の DOM。**打鍵で作り直された文書でも、tex が同じなら DOM を触らない**のが
 * この WI の肝なので、そこを固定する (React ノードビューだった頃は全数式が毎回調停されていた)。
 */
const windowRef = new Window();
const schema = getSchema(createRichTextEngineExtensions({ enableMathDelimiters: true }));

beforeEach(() => {
  (globalThis as { document?: unknown }).document = windowRef.document;
  (globalThis as { window?: unknown }).window = windowRef;
  // `CustomEvent` も happy-dom のものに揃える (グローバルのままだと dispatchEvent が受け取らない)。
  (globalThis as { CustomEvent?: unknown }).CustomEvent = windowRef.CustomEvent;
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
});

function mathNode(tex: string, id = "m1") {
  return schema.nodes.mathInline.create({ id, tex });
}

function createNodeView(tex: string, id = "m1") {
  const node = mathNode(tex, id);
  // 選択の通知はブロック id を文書から引くので、本物の doc を持たせる。
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ sigmaDocId: "p1" }, [node]),
  ]);
  const editor = { isDestroyed: false, state: { doc } } as never;
  const view = new InlineMathNodeView(
    { decorations: [], editor, getPos: () => 1, node },
    { mathEnvironment: TEST_MATH_ENVIRONMENT },
  );
  return { node, view };
}

/** 既定の描画環境。ここは DOM の形を見るテストなので前文マクロは持たせない。 */
const TEST_MATH_ENVIRONMENT = DEFAULT_MATH_RENDER_ENVIRONMENT;

describe("InlineMathNodeView", () => {
  it("builds the shared static math DOM", () => {
    const { view } = createNodeView("x^2");

    expect(view.dom.className).toBe("inline-math-node");
    expect(view.dom.getAttribute("data-sigma-doc-math-inline")).toBe("");
    expect(view.dom.getAttribute("data-id")).toBe("m1");
    expect(view.dom.getAttribute("data-tex")).toBe("x^2");
    expect(view.dom.getAttribute("title")).toBe("x^2");
    expect(view.dom.contentEditable).toBe("false");
    expect(view.dom.firstElementChild?.className).toBe("math-preview math-preview-inline");
    expect(view.dom.firstElementChild?.innerHTML).toBe(renderMathHtml("x^2", TEST_MATH_ENVIRONMENT));
  });

  it("does not touch the DOM when the formula did not change", () => {
    // 打鍵のたびに文書は作り直されるが、数式の中身は変わっていない。ここで DOM を書き換えると
    // 文書中の全数式が打鍵ごとに作り直される (この WI が消したかったコスト)。
    const { view } = createNodeView("x^2");
    const body = view.dom.firstElementChild as HTMLElement;
    const markup = body.innerHTML;

    expect(view.update(mathNode("x^2"), [])).toBe(true);

    expect(view.dom.firstElementChild).toBe(body);
    expect(body.innerHTML).toBe(markup);
  });

  it("rewrites only the body when the formula changes", () => {
    const { view } = createNodeView("x^2");
    const body = view.dom.firstElementChild as HTMLElement;

    expect(view.update(mathNode(String.raw`\frac{1}{2}`), [])).toBe(true);

    expect(view.dom.firstElementChild).toBe(body);
    expect(view.dom.getAttribute("data-tex")).toBe(String.raw`\frac{1}{2}`);
    expect(view.dom.getAttribute("title")).toBe(String.raw`\frac{1}{2}`);
    expect(body.innerHTML).toBe(renderMathHtml(String.raw`\frac{1}{2}`, TEST_MATH_ENVIRONMENT));
  });

  it("follows the id when the node is replaced by one with a new id", () => {
    const { view } = createNodeView("x^2", "m1");

    view.update(mathNode("x^2", "m2"), []);

    expect(view.dom.getAttribute("data-id")).toBe("m2");
  });

  it("refuses a node of another type so ProseMirror rebuilds the view", () => {
    const { view } = createNodeView("x^2");

    expect(view.update(schema.nodes.paragraph.create(), [])).toBe(false);
  });

  it("marks and unmarks the selected formula", () => {
    const { view } = createNodeView("x^2");

    view.selectNode();
    expect(view.dom.classList.contains("selected")).toBe(true);

    view.deselectNode();
    expect(view.dom.classList.contains("selected")).toBe(false);
  });

  it("keeps events to itself only while editing", () => {
    // 編集中は `<math-field>` がキーもポインタも持つ。非編集時に握ると本文側の選択が壊れる。
    const { view } = createNodeView("x^2");

    expect(view.stopEvent()).toBe(false);
  });

  it("blocks editing while the AI edit lock decoration is on the node", () => {
    // ロックの本体は `filterTransaction` (書き込みを拒否) だが、ロック中の数式は編集にも
    // 入れない。装飾は ProseMirror がこのノードビューに配るので、そこから読む。
    const { view } = createNodeView("x^2");
    const lockDecoration = { type: { attrs: { "data-edit-guard-atom": "true" } } } as never;

    view.update(mathNode("x^2"), [lockDecoration]);
    view.selectNode();

    expect(view.dom.classList.contains("editing")).toBe(false);
  });

  it("stops answering edit requests once destroyed", () => {
    // 破棄後に編集へ入ると、IME の入力ソースを取ったまま返さないビューができる
    // (`restoreDesktopInputSource` を呼ぶ主が居ない)。
    const { view } = createNodeView("x^2", "m9");

    view.destroy();
    windowRef.dispatchEvent(new windowRef.CustomEvent("sigma-studio:edit-inline-math", {
      detail: { id: "m9" },
    }) as never);

    expect(view.dom.classList.contains("editing")).toBe(false);
  });

  it("tells the formula panel again when the selected formula is rewritten", () => {
    // undo/redo や AI 適用で選択中の数式が変わったとき、知らせ直さないとパネルが古い TeX を
    // 編集し続ける。
    const { view } = createNodeView("x^2");
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push(String((event as CustomEvent).detail?.tex ?? ""));
    };
    windowRef.addEventListener("sigma-studio:select-inline-math", listener as never);

    view.selectNode();
    view.update(mathNode("y^2"), []);
    windowRef.removeEventListener("sigma-studio:select-inline-math", listener as never);

    expect(seen).toEqual(["x^2", "y^2"]);
  });

  it("ignores DOM mutations (the body is rewritten by hand)", () => {
    const { view } = createNodeView("x^2");

    expect(view.ignoreMutation()).toBe(true);
  });
});
