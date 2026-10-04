// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiEditInlinePreviewCard } from "./AiEditInlinePreviewCard";
import type { AiProposalContent } from "../model/proposal-content";

function replaceContent(text: string): AiProposalContent {
  const emptyNumbering = { problems: new Map(), headings: new Map() };
  return {
    hunks: [{
      anchorBlockId: "p1",
      removed: [{ id: "p1", type: "paragraph", children: [{ type: "text", text: "書き換え前" }] }],
      added: [{ id: "p1", type: "paragraph", children: text ? [{ type: "text", text }] : [] }],
      notes: [],
      operations: ["replace"],
      numbering: { removed: emptyNumbering, added: emptyNumbering },
    }],
    shapes: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) {
    throw new Error(`no button named ${name}`);
  }
  return found;
}

describe("AiEditInlinePreviewCard on its own", () => {
  it("hides the content behind the bar without applying or discarding, and shows it again", async () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    await act(async () => root.render(
      <AiEditInlinePreviewCard content={replaceContent("書き換え後")} applying={false} onApply={onApply} onDismiss={onDismiss} />,
    ));
    const content = container.querySelector<HTMLElement>(".ai-proposal-card-content")!;

    await act(async () => button("内容を隠す").click());
    expect(content.hidden).toBe(true);
    expect(container.querySelector("[data-ai-proposal-bar]")).not.toBeNull();
    expect(button("内容を表示").getAttribute("aria-controls")).toBe(content.id);

    await act(async () => button("内容を表示").click());
    expect(content.hidden).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("renders the failed reason on the bar and keeps the inline card pending", async () => {
    const reason = "別の操作が完了してから、もう一度お試しください";
    const onApply = vi.fn(async () => ({ ok: false as const, reason }));
    await act(async () => root.render(
      <AiEditInlinePreviewCard content={replaceContent("書き換え後")} applying={false} onApply={onApply} />,
    ));

    await act(async () => button("適用").click());

    expect(onApply).toHaveBeenCalledOnce();
    // 失敗の理由はバーのすぐ下の行 (バーは 1 行のまま)。
    expect(container.querySelector('[data-ai-proposal-bar] + [data-ai-proposal-bar-details] [role="alert"]')?.textContent)
      .toBe(reason);
    expect(container.querySelector('[data-ai-proposal-card="page"]')).not.toBeNull();
    expect(button("適用").disabled).toBe(false);
  });
});
