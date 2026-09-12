import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SigmaDocViewer,
  parseSigmaDocument,
  type Graph3DSpec,
  type OverlayAnchor,
  type OverlayTextShape,
  type SigmaDocument,
  type SigmaDocViewerError,
} from "./index";

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

afterEach(async () => {
  await act(async () => {
    for (const { container, root } of mountedRoots.splice(0)) {
      root.unmount();
      container.remove();
    }
  });
});

describe("SigmaDocViewer", () => {
  it("renders a stable loading shell during SSR", () => {
    const html = renderToStaticMarkup(
      <SigmaDocViewer document={createDocument({ bodyText: "SSR_DOCUMENT" })} />,
    );

    expect(html).toContain('data-sigma-viewer="true"');
    expect(html).toContain('data-sigma-viewer-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("SSR_DOCUMENT");
    expect(html).not.toContain("contenteditable");
  });

  it("shows the complete problem while omitting author comments and editing controls", async () => {
    const document = createDocument({
      bodyText: "READONLY_PROMPT https://example.com/material",
      problem: true,
      commentText: "AUTHOR_ONLY_COMMENT",
    });

    const { container } = await renderViewer(<SigmaDocViewer document={document} />);

    expect(container.querySelector("[data-sigma-viewer]")?.getAttribute("data-sigma-viewer-state")).toBe("ready");
    expect(container.textContent).toContain("READONLY_PROMPT");
    expect(container.textContent).toContain("https://example.com/material");
    expect(container.textContent).toContain("READONLY_ANSWER");
    expect(container.textContent).toContain("READONLY_HINT");
    expect(container.textContent).toContain("READONLY_SOLUTION");
    const visibleText = container.textContent ?? "";
    expect(visibleText.indexOf("READONLY_PROMPT")).toBeLessThan(visibleText.indexOf("READONLY_ANSWER"));
    expect(visibleText.indexOf("READONLY_ANSWER")).toBeLessThan(visibleText.indexOf("READONLY_HINT"));
    expect(visibleText.indexOf("READONLY_HINT")).toBeLessThan(visibleText.indexOf("READONLY_SOLUTION"));
    expect(container.textContent).not.toContain("AUTHOR_ONLY_COMMENT");
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("button, input, textarea, select")).toBeNull();
    expect(Array.from(container.querySelectorAll("style"), (style) => style.textContent).join("\n"))
      .not.toContain("@page");
  });

  it("renders an accessible fallback and reports an invalid SigmaDoc", async () => {
    const onError = vi.fn<(error: SigmaDocViewerError) => void>();
    const invalidDocument = {
      ...createDocument({ bodyText: "SHOULD_NOT_RENDER" }),
      version: "999.0",
    } as unknown as SigmaDocument;

    expect(() => parseSigmaDocument(invalidDocument)).toThrow();

    const { container } = await renderViewer(
      <SigmaDocViewer document={invalidDocument} onError={onError} />,
    );

    const fallback = container.querySelector('[data-sigma-viewer-state="error"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("SHOULD_NOT_RENDER");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-document" }));
  });

  it("renders allowed data images and replaces unsupported assets with a reported placeholder", async () => {
    const onError = vi.fn<(error: SigmaDocViewerError) => void>();
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const document = createDocument({ bodyText: "IMAGE_DOCUMENT" });
    document.pageLayout = {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [
            {
              id: "shape_data_image",
              type: "image",
              x: 20,
              y: 30,
              props: { assetId: "asset_data_image", w: 120, h: 80 },
            },
            {
              id: "shape_remote_image",
              type: "image",
              x: 160,
              y: 30,
              props: { assetId: "asset_remote_image", w: 120, h: 80 },
            },
            {
              id: "shape_invalid_image",
              type: "image",
              x: 300,
              y: 30,
              props: { assetId: "asset_invalid_image", w: 120, h: 80 },
            },
            {
              id: "shape_empty_image",
              type: "image",
              x: 440,
              y: 30,
              props: { assetId: "asset_empty_image", w: 120, h: 80 },
            },
            {
              id: "shape_graph3d",
              type: "graph3dShape",
              x: 20,
              y: 130,
              props: {
                w: 320,
                h: 220,
                spec: createGraph3DSpec(),
                previewAssetId: "asset_graph3d_preview",
              },
            },
          ],
          assets: {
            asset_data_image: {
              id: "asset_data_image",
              type: "image",
              props: {
                w: 1,
                h: 1,
                name: "pixel.png",
                isAnimated: false,
                mimeType: "image/png",
                src: `  ${dataUrl}\n`,
                fileSize: 42,
              },
            },
            asset_invalid_image: {
              id: "asset_invalid_image",
              type: "image",
              props: {
                w: 1,
                h: 1,
                name: "fake.png",
                isAnimated: false,
                mimeType: "image/png",
                src: "data:image/png;base64,AAAA",
                fileSize: 3,
              },
            },
            asset_empty_image: {
              id: "asset_empty_image",
              type: "image",
              props: {
                w: 1,
                h: 1,
                name: "empty.png",
                isAnimated: false,
                mimeType: "image/png",
                src: "   ",
                fileSize: 0,
              },
            },
            asset_remote_image: {
              id: "asset_remote_image",
              type: "image",
              props: {
                w: 640,
                h: 360,
                name: "remote.png",
                isAnimated: false,
                mimeType: "image/png",
                src: "https://example.com/remote.png",
                fileSize: 1234,
              },
            },
            asset_graph3d_preview: {
              id: "asset_graph3d_preview",
              type: "image",
              props: {
                w: 640,
                h: 440,
                name: "3D preview.png",
                isAnimated: false,
                mimeType: "image/png",
                src: "data:image/png;base64,AAAA",
                fileSize: 3,
              },
            },
          },
        },
      },
    };

    const { container } = await renderViewer(
      <SigmaDocViewer document={document} onError={onError} />,
    );

    const renderedSources = Array.from(container.querySelectorAll("image"), (image) => image.getAttribute("href"));
    expect(renderedSources).toContain(dataUrl);
    expect(renderedSources).not.toContain("https://example.com/remote.png");
    expect(container.querySelector('[data-sigma-viewer-asset-placeholder="asset_remote_image"]')).not.toBeNull();
    expect(container.querySelector('[data-sigma-viewer-asset-placeholder="asset_invalid_image"]')).not.toBeNull();
    expect(container.querySelector('[data-sigma-viewer-asset-placeholder="asset_empty_image"]')).not.toBeNull();
    expect(container.querySelector('[data-sigma-viewer-asset-placeholder="asset_graph3d_preview"]')).not.toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "unsupported-asset",
      assetId: "asset_remote_image",
    }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "unsupported-asset",
      assetId: "asset_invalid_image",
    }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "unsupported-asset",
      assetId: "asset_empty_image",
    }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "unsupported-asset",
      assetId: "asset_graph3d_preview",
    }));
  });

  it("renders an answer label even when answer.expected is empty", async () => {
    const document = createDocument({ bodyText: "EMPTY_ANSWER_PROMPT", problem: true });
    const problem = document.content[0];
    if (problem.type !== "problem") throw new Error("expected problem");
    problem.answer = { type: "text", expected: "" };

    const { container } = await renderViewer(<SigmaDocViewer document={document} />);

    expect(container.textContent).toContain("EMPTY_ANSWER_PROMPT");
    expect(container.textContent).toContain("答");
    expect((container.textContent ?? "").indexOf("答")).toBeLessThan((container.textContent ?? "").indexOf("READONLY_HINT"));
  });

  it("renders only the requested problem parts and removes document-level content", async () => {
    const document = createDocument({ bodyText: "PARTIAL_PROMPT", problem: true });
    document.content.push(paragraph("outside_problem", "OUTSIDE_PROBLEM"));

    const problemOnly = await renderViewer(
      <SigmaDocViewer document={document} visibleParts={["problem"]} />,
    );
    expect(problemOnly.container.textContent).toContain("PARTIAL_PROMPT");
    expect(problemOnly.container.textContent).not.toContain("READONLY_ANSWER");
    expect(problemOnly.container.textContent).not.toContain("READONLY_HINT");
    expect(problemOnly.container.textContent).not.toContain("READONLY_SOLUTION");
    expect(problemOnly.container.textContent).not.toContain("OUTSIDE_PROBLEM");

    const solutionOnly = await renderViewer(
      <SigmaDocViewer document={document} visibleParts={["solution"]} />,
    );
    expect(solutionOnly.container.textContent).toContain("READONLY_SOLUTION");
    expect(solutionOnly.container.textContent).not.toContain("PARTIAL_PROMPT");
    expect(solutionOnly.container.textContent).not.toContain("READONLY_ANSWER");
    expect(solutionOnly.container.textContent).not.toContain("READONLY_HINT");

    const commentsOnly = await renderViewer(
      <SigmaDocViewer document={document} visibleParts={["comments"]} />,
    );
    expect(commentsOnly.container.textContent).toContain("READONLY_HINT");
    expect(commentsOnly.container.textContent).not.toContain("PARTIAL_PROMPT");
    expect(commentsOnly.container.textContent).not.toContain("READONLY_SOLUTION");

    const problemAndSolution = await renderViewer(
      <SigmaDocViewer document={document} visibleParts={["solution", "problem"]} />,
    );
    expect(problemAndSolution.container.textContent).toContain("PARTIAL_PROMPT");
    expect(problemAndSolution.container.textContent).toContain("READONLY_SOLUTION");
    expect(problemAndSolution.container.textContent).not.toContain("READONLY_ANSWER");
    expect(problemAndSolution.container.textContent).not.toContain("READONLY_HINT");
  });

  it("can force problem numbers off without changing the source document", async () => {
    const document = createDocument({ bodyText: "NUMBERED_PROMPT", problem: true });
    const problem = document.content[0];
    if (problem.type !== "problem") throw new Error("expected problem");
    problem.numbering = { enabled: true, value: 7 };

    const numbered = await renderViewer(<SigmaDocViewer document={document} visibleParts={["problem"]} />);
    expect(numbered.container.querySelector(".print-problem-number")?.textContent).toBe("7");

    const hidden = await renderViewer(
      <SigmaDocViewer document={document} visibleParts={["problem"]} hideProblemNumbers />,
    );
    expect(hidden.container.querySelector(".print-problem-number")).toBeNull();
    expect(problem.numbering).toEqual({ enabled: true, value: 7 });
  });

  it("keeps only overlays anchored to visible problem content in partial mode", async () => {
    const document = createDocument({ bodyText: "OVERLAY_PROMPT", problem: true });
    document.pageLayout = {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      header: {
        enabled: true,
        heightMm: 10,
        offsetMm: 0,
        showOnFirstPage: true,
        blocks: [paragraph("header_text", "PARTIAL_HEADER")],
      },
      overlay: {
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [
            overlayTextShape("prompt_overlay", "PROMPT_OVERLAY", { type: "block", blockId: "prompt", dy: 0 }),
            overlayTextShape("solution_overlay", "SOLUTION_OVERLAY", { type: "block", blockId: "solution", dy: 0 }),
            overlayTextShape("page_overlay", "PAGE_OVERLAY", { type: "page" }),
          ],
        },
      },
    };

    const { container } = await renderViewer(
      <SigmaDocViewer document={document} visibleParts={["problem"]} />,
    );

    expect(container.innerHTML).toContain("PROMPT_OVERLAY");
    expect(container.innerHTML).not.toContain("SOLUTION_OVERLAY");
    expect(container.innerHTML).not.toContain("PAGE_OVERLAY");
    expect(container.textContent).not.toContain("PARTIAL_HEADER");
    expect(document.pageLayout?.header?.blocks[0]?.id).toBe("header_text");
    expect(document.pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(3);
  });

  it("clips overflowing content and expands it from the built-in control", async () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this instanceof HTMLElement && this.classList.contains("sigma-viewer__viewport-content") ? 800 : 0;
      },
    });

    try {
      const mounted = await renderViewer(
        <SigmaDocViewer document={createDocument({ bodyText: "TALL_DOCUMENT" })} maxHeightPx={240} />,
      );
      const viewport = mounted.container.querySelector<HTMLElement>(".sigma-viewer__viewport");
      const button = mounted.container.querySelector<HTMLButtonElement>(".sigma-viewer__expand-button");

      expect(viewport?.dataset.sigmaViewerHeightLimited).toBe("true");
      expect(viewport?.dataset.sigmaViewerOverflow).toBe("true");
      expect(viewport?.style.maxHeight).toBe("240px");
      expect(button?.textContent).toBe("すべて表示");

      await act(async () => {
        button?.click();
      });

      expect(viewport?.dataset.sigmaViewerHeightLimited).toBe("false");
      expect(viewport?.style.maxHeight).toBe("");
      expect(mounted.container.querySelector(".sigma-viewer__expand-button")).toBeNull();

      await mounted.rerender(
        <SigmaDocViewer
          document={createDocument({ bodyText: "REPLACED_TALL_DOCUMENT", docId: "replacement" })}
          maxHeightPx={240}
        />,
      );

      expect(mounted.container.querySelector<HTMLElement>(".sigma-viewer__viewport")?.dataset.sigmaViewerHeightLimited)
        .toBe("true");
      expect(mounted.container.querySelector(".sigma-viewer__expand-button")?.textContent).toBe("すべて表示");
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
    }
  });

  it("revalidates and redraws when the controlled document is replaced", async () => {
    const first = createDocument({ bodyText: "FIRST_CONTROLLED_DOCUMENT" });
    const second = createDocument({ bodyText: "SECOND_CONTROLLED_DOCUMENT", docId: "doc_second" });
    const mounted = await renderViewer(<SigmaDocViewer document={first} />);

    expect(mounted.container.textContent).toContain("FIRST_CONTROLLED_DOCUMENT");

    await mounted.rerender(<SigmaDocViewer document={second} />);

    expect(mounted.container.textContent).toContain("SECOND_CONTROLLED_DOCUMENT");
    expect(mounted.container.textContent).not.toContain("FIRST_CONTROLLED_DOCUMENT");
  });

  /**
   * publish 済みの `@sigma-studio/viewer` は desktop の描画経路をそのまま同梱するので、
   * 数式 markup の無害化 (`features/rendering/adapters/math-html.ts`) がここにも効く。
   * `viewer-safety.ts` は `tex` を検査しない (= 入口では止まらない) ので、
   * 「出口で守れている」ことをこの DOM 検査が担保する。
   */
  it("never mounts an executable element for math that carries raw HTML", async () => {
    const document = createDocument({ bodyText: "MATH_XSS" });
    document.content = [{
      type: "paragraph",
      id: "prompt",
      children: [{
        type: "mathInline",
        id: "math_xss",
        tex: "\\text{<img src=x onerror=alert(1)>}",
        display: "inline",
      }],
    }];

    const { container } = await renderViewer(<SigmaDocViewer document={document} />);

    expect(container.querySelector("[data-sigma-viewer]")?.getAttribute("data-sigma-viewer-state")).toBe("ready");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    for (const element of Array.from(container.querySelectorAll("*"))) {
      expect(element.getAttributeNames().filter((name) => /^on/i.test(name))).toEqual([]);
    }
    // 落ちた先は「読める文字」であること (黙って消えていない)。
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

function createGraph3DSpec(): Graph3DSpec {
  return {
    version: 1,
    parameters: [],
    objects: [{
      id: "surface",
      kind: "parametricSurface",
      x: "u",
      y: "v",
      z: "sin(u) + cos(v)",
      u: { min: "-5", max: "5", samples: 24 },
      v: { min: "-5", max: "5", samples: 24 },
    }],
    cuts: [],
    regions: [],
    annotations: [],
    camera: {
      projection: "perspective",
      position: { x: 5, y: -6, z: 4 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
    view: {
      coordinateSystem: "zUp",
      showAxes: true,
      showGrid: true,
      showAxisLabels: true,
      backgroundColor: "#ffffff",
    },
  };
}

async function renderViewer(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });

  const rerender = async (nextElement: ReactElement) => {
    await act(async () => {
      root.render(nextElement);
    });
    await waitForSettledViewer(container);
  };

  await rerender(element);
  return { container, rerender };
}

async function waitForSettledViewer(container: HTMLElement) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = container.querySelector("[data-sigma-viewer]")?.getAttribute("data-sigma-viewer-state");
    if (state === "ready" || state === "error") return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("SigmaDocViewer did not leave its loading state.");
}

function createDocument(options: {
  bodyText: string;
  docId?: string;
  problem?: boolean;
  commentText?: string;
}): SigmaDocument {
  const prompt = paragraph("prompt", options.bodyText);
  const content: SigmaDocument["content"] = options.problem
    ? [{
        type: "problem",
        id: "problem_readonly",
        tags: [],
        lead: [],
        prompt: [prompt],
        answer: { type: "text", expected: "READONLY_ANSWER" },
        hints: [paragraph("hint", "READONLY_HINT")],
        solution: [paragraph("solution", "READONLY_SOLUTION")],
      }]
    : [prompt];

  return {
    version: "2.0",
    docId: options.docId ?? "doc_viewer_test",
    metadata: { title: "Viewer test" },
    content,
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true },
      answerBook: { onlySolutions: true, showSolutions: true, showHints: false, includeAnswers: true },
    },
    comments: options.commentText
      ? [{
          id: "comment_author_only",
          anchor: { type: "block", blockId: "prompt", quote: options.bodyText },
          messages: [{
            id: "comment_message_author_only",
            authorName: "Author",
            body: [{ type: "text", text: options.commentText }],
            createdAt: "2026-07-20T00:00:00.000Z",
          }],
          createdAt: "2026-07-20T00:00:00.000Z",
        }]
      : undefined,
  };
}

function paragraph(id: string, text: string): Extract<SigmaDocument["content"][number], { type: "paragraph" }> {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text }],
  };
}

function overlayTextShape(
  id: string,
  text: string,
  anchor: OverlayAnchor,
): OverlayTextShape {
  return {
    id,
    type: "text" as const,
    x: 40,
    y: 40,
    anchor,
    props: {
      w: 160,
      h: 16,
      blocks: [{ type: "paragraph", id: "sigmadocviewer_test_52", children: [{ type: "text", text }] }],
      color: "#111111",
      size: "m" as const,
    },
  };
}
