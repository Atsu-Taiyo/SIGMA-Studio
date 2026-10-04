// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearTextRunSpan, getTextRunEditors } from "@/components/editor/text-flow/text-run-span";
import type { TextFlowBlock } from "@/features/text-editing";
import { setAppLocale } from "@/lib/i18n/react";

import type { PageCanvasInlineContent } from "./editor-extension";
import {
  FlowExtensionFragmentPreview,
  FlowExtensionLayoutContext,
  InlineContentStack,
  TextFlowWithInlineContent,
  type FlowExtensionLayout,
} from "./text-flow-view";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setAppLocale("ja");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  clearTextRunSpan();
  act(() => root.unmount());
  container.remove();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
  });
}

function withLayout(layout: Partial<FlowExtensionLayout>, node: ReactNode): ReactNode {
  return (
    <FlowExtensionLayoutContext.Provider value={{ nodeDisplacements: {}, fragmentSources: {}, ...layout }}>
      {node}
    </FlowExtensionLayoutContext.Provider>
  );
}

function card(key: string, measureRevision?: string): PageCanvasInlineContent {
  return { key, content: <p className={`content-${key}`}>{key}</p>, ...(measureRevision ? { measureRevision } : {}) };
}

function extensionNode(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-flow-extension-node-id="${id}"]`);
  if (!element) throw new Error(`missing extension node ${id}`);
  return element;
}

describe("flow extension nodes", () => {
  it("draws each item as its own node, displaced by its own placement, and tells the probe how far", async () => {
    await render(withLayout(
      { nodeDisplacements: { "extension:a": { dx: 0, dy: 40 }, "extension:b": { dx: 12, dy: 80 } } },
      <InlineContentStack items={[card("a", "r1"), card("b")]} fallbackDisplacement={{ dx: 0, dy: 7 }} />,
    ));
    const first = extensionNode("extension:a");
    expect(first.getAttribute("data-flow-dy")).toBe("40");
    expect(first.getAttribute("data-flow-measure-revision")).toBe("r1");
    expect(first.style.position).toBe("relative");
    expect(first.style.top).toBe("40px");
    expect(first.querySelector(".content-a")).not.toBeNull();
    const second = extensionNode("extension:b");
    expect(second.getAttribute("data-flow-dx")).toBe("12");
    expect(second.getAttribute("data-flow-dy")).toBe("80");
    expect(second.style.left).toBe("12px");
  });

  it("keeps a node that has no placement yet with the block before it, and reports that displacement", async () => {
    await render(withLayout({}, <InlineContentStack items={[card("a"), card("b")]} fallbackDisplacement={{ dx: 0, dy: 7 }} />));
    for (const id of ["extension:a", "extension:b"]) {
      expect(extensionNode(id).getAttribute("data-flow-dy")).toBe("7");
      expect(extensionNode(id).style.top).toBe("7px");
    }
  });

  it("clips a node split at a page boundary to the band its first page shows, without changing its height", async () => {
    await render(withLayout(
      { fragmentSources: { "extension:a": { visibleHeight: 65, totalHeight: 100, origin: { x: 0, y: 30, width: 400 } } } },
      <InlineContentStack items={[card("a")]} />,
    ));
    const node = extensionNode("extension:a");
    expect(node.style.clipPath.replace(/\s+/g, " ")).toBe("inset(0 0 35px 0)");
    expect(node.style.height).toBe("");
    expect(node.hasAttribute("data-flow-dy")).toBe(false);
  });

  it("draws the continuation on the next page as an inert copy that assistive tech skips", async () => {
    await render(
      <FlowExtensionFragmentPreview
        item={card("a")}
        fragment={{ blockId: "extension:a", fragmentIndex: 1, sourceOffsetY: 65, height: 35, x: 10, y: 160, width: 400, totalHeight: 100 }}
      />,
    );
    const replica = container.querySelector<HTMLElement>('[data-flow-extension-replica="extension:a"]');
    expect(replica).not.toBeNull();
    expect(replica!.hasAttribute("inert")).toBe(true);
    expect(replica!.getAttribute("aria-hidden")).toBe("true");
    expect([replica!.style.left, replica!.style.top, replica!.style.width, replica!.style.height])
      .toEqual(["10px", "160px", "400px", "35px"]);
    const content = replica!.firstElementChild as HTMLElement;
    expect(content.style.top).toBe("-65px");
    expect(content.style.width).toBe("400px");
    expect(content.querySelector(".content-a")).not.toBeNull();
    // 正本と同じ id を持たない (計測・e2e が正本だけを拾う)。
    expect(container.querySelector("[data-flow-extension-node-id]")).toBeNull();
  });
});

describe("TextFlowWithInlineContent", () => {
  const GROUP = "text-flow-view-test";
  const BLOCKS: TextFlowBlock[] = ["a", "b", "c"].map((id) => ({
    type: "paragraph",
    id,
    children: [{ type: "text", text: `段落${id}のテキスト` }],
  }));

  function view(content: ReadonlyMap<string, readonly PageCanvasInlineContent[]>): ReactNode {
    return (
      <TextFlowWithInlineContent
        blocks={BLOCKS}
        selectedId={null}
        mathFractionSizing="uniform"
        historyRevision={0}
        commentThreads={[]}
        activeCommentThreadId={null}
        highlightedCommentThreadId={null}
        onSelect={() => {}}
        onChange={() => {}}
        materials={[]}
        inlineContentByTargetId={content}
        textRunGroupId={GROUP}
        textRunOrder={0}
        textRunUnitId="unit"
        textRunScopeId="document"
      />
    );
  }

  function blockIdsOf(editor: Editor): string[] {
    const ids: string[] = [];
    editor.state.doc.forEach((node) => ids.push(String(node.attrs.sigmaDocId)));
    return ids;
  }

  function positionIn(editor: Editor, blockId: string, offset: number): number {
    let position = -1;
    editor.state.doc.forEach((node, nodeOffset) => {
      if (node.attrs.sigmaDocId === blockId) position = nodeOffset + 1 + offset;
    });
    return position;
  }

  it("keeps the editor before a newly anchored card, with its caret and IME composition", async () => {
    await render(view(new Map()));
    const [before] = getTextRunEditors(GROUP);
    expect(blockIdsOf(before.editor)).toEqual(["a", "b", "c"]);
    const caret = positionIn(before.editor, "b", 3);
    await act(async () => {
      before.editor.commands.setTextSelection(caret);
      before.editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    });
    expect(before.editor.view.composing).toBe(true);

    await render(view(new Map([["b", [card("card")]]])));

    const editors = getTextRunEditors(GROUP);
    expect(editors[0].editor).toBe(before.editor);
    expect(before.editor.isDestroyed).toBe(false);
    expect(before.editor.view.composing).toBe(true);
    expect(before.editor.state.selection.head).toBe(caret);
    expect(extensionNode("extension:card")).toBeTruthy();

    // 確定後、元の面は差し込みの後ろのブロックを手放し、後ろの面がそれを持つ。
    await act(async () => {
      before.editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const settled = getTextRunEditors(GROUP);
    expect(settled.map((handle) => blockIdsOf(handle.editor))).toEqual([["a", "b"], ["c"]]);
    expect(settled[0].editor).toBe(before.editor);
    expect(before.editor.state.selection.head).toBe(caret);
  });
});
