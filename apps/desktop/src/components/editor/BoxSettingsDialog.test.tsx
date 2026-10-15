// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoxSettingsDialog } from "@/components/editor/BoxSettingsDialog";
import { BOX_PREVIEW_BODY_BLOCK_LIMIT, BOX_PREVIEW_ID_PREFIX, type BoxPreviewPaper } from "@/components/editor/BoxSettingsPreview";
import type { BoxBlockNode, CustomFrame } from "@/features/document";
import { createBoxBlock, patchBoxFrame, setBoxCustomFrame, setBoxStyle } from "@/lib/box-blocks";
import { addFrameToLibrary, FRAME_LIBRARY_STORAGE_KEY, getFrameLibrary } from "@/lib/frame-library";
import { setAppLocale } from "@/lib/i18n/react";

const CUSTOM: CustomFrame = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40" viewBox="0 0 60 40"><rect width="60" height="40" fill="none" stroke="#000"/></svg>',
  width: 60,
  height: 40,
  slice: 10,
  borderPx: 18,
  paddingPx: 12,
};

let container: HTMLDivElement;
let root: Root;
let current: BoxBlockNode;

/** Applies the dialog's changes the way the text flow editor does, so the dialog sees its own edits. */
function Host({ initial, withCustomFrames, onBox, paper }: {
  initial: BoxBlockNode;
  withCustomFrames: boolean;
  onBox: (box: BoxBlockNode) => void;
  paper?: BoxPreviewPaper;
}) {
  const [box, setBox] = useState(initial);
  useEffect(() => onBox(box), [box, onBox]);
  return (
    <BoxSettingsDialog
      boxBlock={box}
      title={box.title ?? []}
      body={box.blocks}
      paper={paper}
      onStyleChange={(styleId) => setBox((previous) => setBoxStyle(previous, styleId))}
      onFrameChange={(patch) => setBox((previous) => patchBoxFrame(previous, patch))}
      onCustomFrameChange={withCustomFrames
        ? (updater) => setBox((previous) => {
            const next = updater(previous.frame?.custom);
            return next ? setBoxCustomFrame(previous, next) : previous;
          })
        : undefined}
      onTitleChange={vi.fn()}
      onResetStyle={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render(initial: BoxBlockNode, withCustomFrames = true, paper?: BoxPreviewPaper) {
  const onBox = (box: BoxBlockNode) => {
    current = box;
  };
  await act(async () => root.render(<Host initial={initial} withCustomFrames={withCustomFrames} onBox={onBox} paper={paper} />));
  await act(async () => byTestId("box-style-picker")!.click());
}

/** The box drawn in the dialog's live preview (not a style thumbnail). */
const previewBox = () => byTestId("box-live-preview")!.querySelector<HTMLElement>(".print-box-block")!;

beforeEach(() => {
  setAppLocale("ja");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.removeItem(FRAME_LIBRARY_STORAGE_KEY);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("BoxSettingsDialog custom frames", () => {
  it("offers the frames on the shelf after the built-in styles, and frames the box with the one picked", async () => {
    const entry = addFrameToLibrary(CUSTOM, "桜の枠")!;
    await render(createBoxBlock("tcolorbox", "定理", { id: "box_1" }));

    expect(byTestId("custom-frame-editor")).toBeNull();
    expect(document.body.textContent).toContain("自分の枠（問題と共通）");
    await act(async () => byTestId(`box-frame-library-${entry.id}`)!.click());

    expect(current.styleId).toBe("custom");
    expect(current.frame?.custom).toEqual(entry.custom);
    expect(current.title).toEqual([{ type: "text", text: "定理" }]);
    expect(byTestId(`box-frame-library-${entry.id}`)!.getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("custom-frame-editor")).not.toBeNull();
    expect(document.body.querySelector('[data-testid="custom-frame-name"]')).toHaveProperty("value", "桜の枠");
  });

  it("shows only what a drawn frame leaves to the box settings", async () => {
    await render(setBoxCustomFrame(createBoxBlock("fancybox", "", { id: "box_1" }), CUSTOM));

    const text = document.body.textContent ?? "";
    expect(text).toContain("タイトル位置");
    expect(text).toContain("タイトルの文字色");
    expect(text).not.toContain("枠線幅（px）");
    expect(text).not.toContain("パディング");
    expect(text).not.toContain("箱の地色");
    expect(byTestId("custom-frame-editor")).not.toBeNull();
  });

  it("starts a new frame from an example, puts it on the box and keeps it on the shelf", async () => {
    await render(createBoxBlock("fancybox", "", { id: "box_1" }));

    await act(async () => byTestId("box-frame-new")!.click());
    expect(document.body.textContent).toContain("新しい枠を作ります");
    expect(current.styleId).toBe("fancybox");

    await act(async () => byTestId("custom-frame-preset-double-diamond")!.click());
    expect(current.styleId).toBe("custom");
    expect(current.frame?.custom).toMatchObject({ width: 160, height: 100, slice: 24 });
    expect(getFrameLibrary().map((entry) => entry.name)).toEqual(["二重線とひし形"]);
  });

  it("swaps the SVG draft when another shelf frame is picked, so editing it cannot overwrite that frame with the previous one", async () => {
    const svg = (stroke: string) => CUSTOM.svg.replace('stroke="#000"', `stroke="${stroke}"`);
    const a = addFrameToLibrary({ ...CUSTOM, svg: svg("#aa0000") }, "A")!;
    const b = addFrameToLibrary({ ...CUSTOM, svg: svg("#00bb00") }, "B")!;
    await render(createBoxBlock("fancybox", "", { id: "box_1" }));
    const draft = () => document.body.querySelector<HTMLTextAreaElement>('[data-testid="custom-frame-svg"]')!;

    await act(async () => byTestId(`box-frame-library-${a.id}`)!.click());
    expect(draft().value).toBe(a.custom.svg);
    await act(async () => byTestId(`box-frame-library-${b.id}`)!.click());
    expect(draft().value).toBe(b.custom.svg);

    // Editing the draft now edits B, on the box and on B's shelf entry; A stays as it was.
    const edited = svg("#0000cc");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft(), edited);
      draft().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current.frame?.custom?.svg).toContain('stroke="#0000cc"');
    const shelf = getFrameLibrary();
    expect(shelf.find((entry) => entry.id === b.id)?.custom.svg).toContain('stroke="#0000cc"');
    expect(shelf.find((entry) => entry.id === a.id)?.custom.svg).toBe(a.custom.svg);

    await act(async () => byTestId("box-frame-new")!.click());
    expect(draft().value).toBe("");
  });

  it("goes back to a built-in style without losing the drawing", async () => {
    await render(setBoxCustomFrame(createBoxBlock("fancybox", "", { id: "box_1" }), CUSTOM));

    await act(async () => byTestId("box-style-doublebox")!.click());
    expect(current.styleId).toBe("doublebox");
    expect(current.frame?.custom).toBe(CUSTOM);
    expect(byTestId("custom-frame-editor")).toBeNull();
  });

  it("offers only the built-in styles to a host that cannot write a drawing", async () => {
    addFrameToLibrary(CUSTOM, "桜の枠");
    await render(createBoxBlock("fancybox", "", { id: "box_1" }), false);

    expect(byTestId("box-frame-new")).toBeNull();
    expect(document.body.textContent).not.toContain("自分の枠（問題と共通）");
  });
});

describe("BoxSettingsDialog live preview", () => {
  it("draws the box itself, title and body, with the paper's renderer instead of a placeholder", async () => {
    const box = createBoxBlock("titlebox", "定理の見出し", { id: "box_1", bodyId: "box_1_p", bodyText: "本文の一行目" });
    box.frame = { ...box.frame, borderWidthPx: 3, borderColor: "#dc2626", bodyColor: "#b91c1c" };
    await render(box, true, { widthPx: 700, fontSize: "14pt" });

    const preview = previewBox();
    expect(preview.className).toContain("box-frame--title-band");
    expect(preview.querySelector(".print-box-title")?.textContent).toBe("定理の見出し");
    expect(preview.querySelector(".print-box-body")?.textContent).toContain("本文の一行目");
    // The frame comes from the same variables the paper's box reads.
    expect(preview.style.getPropertyValue("--sigma-doc-box-border-width")).toBe("3px");
    expect(preview.style.getPropertyValue("--sigma-doc-box-border-color")).toBe("#dc2626");
    expect(preview.style.getPropertyValue("--sigma-doc-box-body-color")).toBe("#b91c1c");
    // Typeset at the paper's width and type size, then scaled, so lines break as they do on the page.
    const sheet = preview.closest<HTMLElement>(".text-flow-editor")!;
    expect(sheet.style.getPropertyValue("--box-preview-paper-width")).toBe("700px");
    expect(sheet.style.getPropertyValue("--editor-font-size")).toBe("14pt");
  });

  it("follows each change at once: corners, title position and the title typed in the dialog", async () => {
    await render(createBoxBlock("fancybox", "見出し", { id: "box_1" }));
    expect(previewBox().style.getPropertyValue("--sigma-doc-box-radius")).toBe("0px");

    const rounded = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "角丸")!;
    await act(async () => rounded.click());
    expect(current.frame?.cornerStyle).toBe("round");
    expect(previewBox().style.getPropertyValue("--sigma-doc-box-radius")).toBe("4px");

    const center = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "中央")!;
    await act(async () => center.click());
    expect(previewBox().className).toContain("box-frame--title-position-c");
  });

  it("keeps the preview copy's ids apart from the paper's and caps a long body", async () => {
    const box = createBoxBlock("fancybox", "長い箱", { id: "box_1", bodyId: "p_0", bodyText: "1 段落目" });
    box.blocks = Array.from({ length: BOX_PREVIEW_BODY_BLOCK_LIMIT + 4 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p_${index}`,
      children: [{ type: "text" as const, text: `${index + 1} 段落目` }],
    }));
    await render(box);

    const preview = previewBox();
    const ids = Array.from(byTestId("box-live-preview")!.querySelectorAll("[data-sigma-doc-id]"))
      .map((element) => element.getAttribute("data-sigma-doc-id")!);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith(BOX_PREVIEW_ID_PREFIX))).toBe(true);
    expect(preview.querySelectorAll(".print-box-body > *")).toHaveLength(BOX_PREVIEW_BODY_BLOCK_LIMIT);
  });

  it("previews a drawn frame with the drawing", async () => {
    await render(setBoxCustomFrame(createBoxBlock("fancybox", "自作", { id: "box_1" }), CUSTOM));

    const preview = previewBox();
    expect(preview.className).toContain("box-frame--custom");
    expect(preview.style.getPropertyValue("--custom-frame-image-closed")).toContain("url(");
  });
});
