// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { buildPageWindows, compactPagedCodeBlocks, measurePageOwnership } from "./page-windows";

describe("buildPageWindows", () => {
  it("keeps a continued paragraph's identity on the page showing its visible lines", () => {
    const canvas = document.createElement("div");
    canvas.className = "page-canvas";
    canvas.innerHTML = '<div class="editor-box-fragment-viewport"><p data-sigma-doc-id="continued">two pages</p></div>';
    const viewport = canvas.firstElementChild as HTMLElement;
    const paragraph = viewport.firstElementChild as HTMLElement;
    canvas.getBoundingClientRect = () => domRect(0, 0, 200, 220);
    viewport.getBoundingClientRect = () => domRect(10, 130, 180, 50);
    paragraph.getBoundingClientRect = () => domRect(10, 80, 180, 100);
    expect(measurePageOwnership(canvas, { pageCount: 2, pageHeightPx: 100, pageStridePx: 120, pageWidthPx: 200 })).toEqual([1]);
  });
  it("keeps each page queryable while adding a numbered preview slot", () => {
    const stageRoot = document.createElement("div");
    stageRoot.className = "page-mode";
    const canvas = document.createElement("div");
    canvas.className = "page-canvas";
    stageRoot.appendChild(canvas);
    const container = document.createElement("div");

    stageRoot.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    canvas.getBoundingClientRect = () => ({
      bottom: 2240,
      height: 2240,
      left: 0,
      right: 794,
      top: 0,
      width: 794,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const written = buildPageWindows({
      stageRoot,
      canvas,
      container,
      metrics: {
        pageCount: 2,
        pageHeightPx: 1120,
        pageStridePx: 1120,
        pageWidthPx: 794,
      },
    });

    expect(written).toBe(2);
    expect(container.querySelectorAll(".paged-surface-page")).toHaveLength(2);
    expect(container.querySelectorAll(".paged-surface-page-slot")).toHaveLength(2);
    expect(Array.from(container.querySelectorAll(".paged-surface-page-number")).map((node) => node.textContent))
      .toEqual(["1 / 2", "2 / 2"]);
  });

  it("hydrates only the code continuation owned by each cloned page", () => {
    const stageRoot = document.createElement("div");
    stageRoot.className = "page-mode";
    const canvas = document.createElement("div");
    canvas.className = "page-canvas";
    canvas.innerHTML = `
      <pre class="print-code text-flow-box-fragment-source" data-sigma-doc-id="large_code"
        style="clip-path:inset(0 0 100px 0);--text-flow-box-fragment-hidden-bottom:100px">line 1<br>line 2</pre>
      <div class="editor-box-fragment-viewport" data-paged-code-fragment
        data-fragment-page-index="1" data-box-source-id="large_code">
        <div class="editor-box-fragment-editor"></div>
      </div>
    `;
    stageRoot.appendChild(canvas);
    const container = document.createElement("div");
    stageRoot.getBoundingClientRect = () => domRect(0, 0, 794, 2240);
    canvas.getBoundingClientRect = () => domRect(0, 0, 794, 2240);

    buildPageWindows({
      stageRoot,
      canvas,
      container,
      metrics: { pageCount: 2, pageHeightPx: 1120, pageStridePx: 1120, pageWidthPx: 794 },
    });

    const pages = container.querySelectorAll(".paged-surface-page");
    expect(pages[0].querySelectorAll("[data-paged-code-fragment] .print-code")).toHaveLength(0);
    const continuation = pages[1].querySelector<HTMLElement>("[data-paged-code-fragment] .print-code");
    expect(continuation?.textContent).toBe("line 1\nline 2");
    expect(continuation?.classList.contains("text-flow-box-fragment-source")).toBe(false);
    expect(continuation?.style.clipPath).toBe("");
    expect(continuation?.hasAttribute("data-sigma-doc-id")).toBe(false);
  });
});

describe("compactPagedCodeBlocks", () => {
  it("does not keep a wrapping markdown fence at the start of compacted print code", () => {
    const root = document.createElement("div");
    const ordinary = document.createElement("pre");
    ordinary.className = "print-code";
    ordinary.textContent = "const a = 1;";
    const fenced = document.createElement("pre");
    fenced.className = "print-code";
    fenced.textContent = "```js\nconst fence = \"```\";\n```";
    root.append(ordinary, fenced);

    compactPagedCodeBlocks(root);

    expect(ordinary.textContent).toBe("const a = 1;");
    expect(ordinary.textContent?.startsWith("```")).toBe(false);
    expect(fenced.textContent).toBe("const fence = \"```\";");
    expect(fenced.textContent?.startsWith("```")).toBe(false);
  });

  it("drops a leading opening fence without a closing fence", () => {
    const root = document.createElement("div");
    const code = document.createElement("pre");
    code.className = "print-code";
    code.textContent = "```asdasda\nasdasdasdsaadasdasdas";
    root.append(code);
    compactPagedCodeBlocks(root);
    expect(code.textContent).toBe("asdasda\nasdasdasdsaadasdasdas");
  });
});

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
