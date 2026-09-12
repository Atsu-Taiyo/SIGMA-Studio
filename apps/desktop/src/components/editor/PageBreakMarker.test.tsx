// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageBreakMarker } from "@/components/editor/PageCanvasEditor";
import { setBlockBreakBefore } from "@/features/text-editing";
import type { RichBlock } from "@/features/document";
import { setAppLocale } from "@/lib/i18n/react";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setAppLocale("ja");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  setAppLocale("ja");
  container.remove();
});

describe("PageBreakMarker", () => {
  it("段組の改段マーカーを mousedown とキーボード操作で解除する", async () => {
    const block: RichBlock = {
      type: "paragraph",
      id: "p_break",
      children: [{ type: "text", text: "改段後" }],
      pagination: { break: true },
    };
    let updatedBlock: RichBlock | undefined;
    const onChange = vi.fn((
      blockId: string,
      updater: (current: RichBlock) => RichBlock,
    ) => {
      expect(blockId).toBe("p_break");
      updatedBlock = updater(block);
    });

    await act(async () => {
      root.render(
        <PageBreakMarker
          blockId="p_break"
          kind="columnBreak"
          onRemove={(blockId) => {
            onChange(blockId, (current) => setBlockBreakBefore(current, false));
          }}
        />,
      );
    });

    const marker = container.querySelector<HTMLElement>(".page-break-marker");
    const button = marker?.querySelector<HTMLButtonElement>(".page-break-marker-remove");
    expect(marker?.textContent).toContain("改段");
    expect(button?.getAttribute("aria-label")).toBe("改段を解除");
    expect(button?.textContent).toBe("× 解除");
    expect(button?.tabIndex).toBe(0);

    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => button?.dispatchEvent(mouseDown));
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(updatedBlock?.pagination?.break).not.toBe(true);

    // The pointer click following mousedown is ignored, so one gesture is one change/undo unit.
    await act(async () => button?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    })));
    expect(onChange).toHaveBeenCalledTimes(1);

    // Native button Enter/Space activation arrives as a detail=0 click.
    await act(async () => button?.click());
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
