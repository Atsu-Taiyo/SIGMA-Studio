// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { buildPageWindows, compactPagedCodeBlocks, measurePageOwnership, preserveSettledTextBlockHeights } from "./page-windows";

describe("settled output text boxes", () => {
  it("retains fractional border-box heights without mutating the editor or its content", () => {
    const source = document.createElement("div");
    source.innerHTML = '<div class="text-flow-editor"><p style="padding-bottom: 12px">日本語 <em>text</em></p><h2>Heading</h2><p><br></p></div>';
    const blocks = source.querySelectorAll<HTMLElement>("p, h2");
    [26.078125, 42.375, 14.7421875].forEach((height, index) => {
      blocks[index].getBoundingClientRect = () => domRect(0, index * 50, 200, height);
    });
    const original = source.outerHTML;
    const clone = source.cloneNode(true) as HTMLElement;
    preserveSettledTextBlockHeights(source, clone);
    expect(source.outerHTML).toBe(original);
    const reparsed = document.createElement("div");
    reparsed.innerHTML = clone.outerHTML;
    expect(Array.from(reparsed.querySelectorAll<HTMLElement>("p, h2"), p => p.style.getPropertyValue("--paged-settled-text-height"))).toEqual(["26.078125px", "42.375px", "14.7421875px"]);
    expect(clone.querySelector("p")!.style.height).toBe("var(--paged-settled-text-height)");
    expect(clone.querySelector("p")!.style.boxSizing).toBe("border-box");
    expect(clone.querySelector("p")!.style.paddingBottom).toBe("12px");
    expect(clone.textContent).toBe(source.textContent);
  });

  it("normalizes a transformed source and leaves unmeasured boxes alone", () => {
    const source = document.createElement("div");
    source.style.transform = "matrix(2, 0, 0, 2, 0, 0)";
    source.innerHTML = '<div class="text-flow-editor"><p>Scaled</p><p>Hidden</p></div>';
    document.body.append(source);
    source.querySelector("p")!.getBoundingClientRect = () => domRect(0, 0, 400, 50.25);
    const clone = source.cloneNode(true) as HTMLElement;
    preserveSettledTextBlockHeights(source, clone);
    source.remove();
    expect(clone.querySelector("p")!.style.getPropertyValue("--paged-settled-text-height")).toBe("25.125px");
    expect(clone.querySelectorAll<HTMLElement>("p")[1].style.height).toBe("");
  });
});

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

  it("clones only visible overlay shapes while retaining a shape across paper boundaries", () => {
    const stageRoot = document.createElement("div");
    stageRoot.className = "page-mode";
    const canvas = document.createElement("div");
    canvas.className = "page-canvas";
    stageRoot.appendChild(canvas);
    const shapes = [
      { id: "first", top: 10, height: 10 },
      { id: "cross", top: 96, height: 35 },
      { id: "last", top: 300, height: 10 },
    ];
    for (const shape of shapes) {
      const element = document.createElement("div");
      element.className = "overlay-shape";
      element.dataset.overlayShapeId = shape.id;
      element.dataset.testShape = shape.id;
      element.getBoundingClientRect = () => domRect(0, shape.top, 20, shape.height);
      canvas.appendChild(element);
    }
    stageRoot.getBoundingClientRect = () => domRect(0, 0, 200, 340);
    canvas.getBoundingClientRect = () => domRect(0, 0, 200, 340);
    const container = document.createElement("div");
    buildPageWindows({ stageRoot, canvas, container, metrics: {
      pageCount: 3, pageHeightPx: 100, pageStridePx: 120, pageWidthPx: 200,
    } });
    const pages = Array.from(container.querySelectorAll(".paged-surface-page"));
    const present = (page: Element) => Array.from(page.querySelectorAll("[data-test-shape]"))
      .map((shape) => shape.getAttribute("data-test-shape"));
    expect(pages.map(present)).toEqual([["first", "cross"], ["cross"], ["last"]]);
    expect(pages[0].querySelector('[data-overlay-shape-id="cross"]')).not.toBeNull();
    expect(pages[1].querySelector('[data-overlay-shape-id="cross"]')).toBeNull();
  });

  it("hydrates only the code continuation owned by each cloned page", () => {
    const stageRoot = document.createElement("div");
    stageRoot.className = "page-mode";
    const canvas = document.createElement("div");
    canvas.className = "page-canvas";
    canvas.innerHTML = `
      <pre class="print-code text-flow-box-fragment-source" data-sigma-doc-id="large_code"
        style="clip-path:inset(0 0 100px 0);--text-flow-box-fragment-hidden-bottom:100px"><button data-code-block-action-button="true">⋯</button><span class="hljs-keyword">line 1</span><br><span style="color: red">line 2</span></pre>
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
    expect(continuation?.textContent).toBe("line 1line 2");
    expect(continuation?.querySelector("br")).not.toBeNull();
    expect(continuation?.querySelector(".hljs-keyword")?.textContent).toBe("line 1");
    expect(continuation?.querySelector<HTMLElement>("span[style]")?.style.color).toBe("red");
    expect(continuation?.querySelector("[data-code-block-action-button]")).toBeNull();
    expect(continuation?.classList.contains("text-flow-box-fragment-source")).toBe(false);
    expect(continuation?.style.clipPath).toBe("");
    expect(continuation?.hasAttribute("data-sigma-doc-id")).toBe(false);
  });
});

describe("compactPagedCodeBlocks", () => {
  it("removes the editing action without adding its label to compacted plain code", () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre class="print-code"><button data-code-block-action-button="true">⋯</button>one<br>two</pre>';

    compactPagedCodeBlocks(root);

    const code = root.querySelector(".print-code")!;
    expect(code.textContent).toBe("one\ntwo");
    expect(code.childNodes).toHaveLength(1);
    expect(code.querySelector("button")).toBeNull();
  });

  it("keeps syntax highlighting and inline styles in the cloned code", () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre class="print-code"><button data-code-block-action-button="true">⋯</button><span class="hljs-keyword">const</span> <span style="font-size: 18pt; color: red">answer</span><br><strong>42</strong></pre>';

    compactPagedCodeBlocks(root);

    const code = root.querySelector(".print-code")!;
    expect(code.querySelector("button")).toBeNull();
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code.querySelector<HTMLElement>("span[style]")?.style.fontSize).toBe("18pt");
    expect(code.querySelector("strong")?.textContent).toBe("42");
    expect(code.querySelector("br")).not.toBeNull();
  });

  it("removes wrapping fences without losing styles inside them", () => {
    const root = document.createElement("div");
    root.innerHTML = '<pre class="print-code">```js<br><span class="hljs-keyword">const</span> <span style="color: red">answer</span><br>```</pre>';

    compactPagedCodeBlocks(root);

    const code = root.querySelector(".print-code")!;
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code.querySelector<HTMLElement>("span[style]")?.style.color).toBe("red");
    expect(code.textContent).toBe("const answer");
  });

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
