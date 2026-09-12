import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageRunningRegionView } from "@/components/editor/PageRunningRegionView";
import { getRunningRegionOverlaySize } from "@/features/document";
import { renderMathHtml } from "@/features/rendering/adapters";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";
import { getDefaultPageLayout, getPageMetrics } from "@/lib/page-layout";
import type { PageRunningRegion } from "@/types/sigma-doc";

describe("PageRunningRegionView", () => {
  it("renders running text with body block classes, variables, line breaks, marks, and math", () => {
    const metrics = getPageMetrics(getDefaultPageLayout());
    const region: PageRunningRegion = {
      enabled: true,
      heightMm: 24,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [
        {
          type: "paragraph",
          id: "header_p",
          align: "center",
          children: [
            { type: "text", text: "{title}\nページ {page}/{total}", marks: ["bold"] },
          ],
        },
        {
          type: "heading",
          id: "header_h",
          level: 2,
          children: [
            { type: "text", text: "関数 " },
            {
              type: "mathInline",
              id: "header_math",
              tex: "y=x^2",
              display: "inline",
              marks: ["boxed"],
              boxedPaddingY: 3,
              semanticRole: "expression",
            },
          ],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <PageRunningRegionView
        region={region}
        kind="header"
        title="二次関数"
        pageNumber={2}
        totalPages={5}
        metrics={metrics}
      />,
    );

    expect(html).toContain("text-flow-editor");
    expect(html).toContain('data-sigma-doc-id="header_p"');
    expect(html).toContain("二次関数");
    expect(html).toContain("ページ 2/5");
    expect(html).toContain("<br");
    expect(html).toContain("<strong>");
    expect(html).toContain("math-preview-inline");
    expect(html).toContain("boxed-inline-math");
    expect(html).not.toContain("page-running-rich-block");
    // The running region draws no `.boxed-run-frame` layer — the plugin that measures and draws it
    // is only mounted in an editor. The rule that stops a segment painting its own border is keyed
    // on `.boxed-run-framed`, which is put on the container by that same pass, so a boxed run here
    // keeps its frame. Scoping that rule on the surface instead (`.text-flow-editor`, which this
    // region is inside) is what silently erased header/footer boxes.
    expect(html).not.toContain("boxed-run-framed");
    expect(html).not.toContain("boxed-run-frame-layer");
  });

  // The running text is drawn by the body's static renderer inside `.text-flow-editor`, with no
  // `.print-*` family of its own. The values were already identical and `.text-flow-editor p`
  // (0,1,1) outranked `.print-paragraph` (0,1,0), so the body rules were what applied all along —
  // this only removes the second CSS family from the PDF surface.
  it("renders running text with the body layout and no print class family", () => {
    const metrics = getPageMetrics(getDefaultPageLayout());
    const region: PageRunningRegion = {
      enabled: true,
      heightMm: 12,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [{
        type: "paragraph",
        id: "footer_p",
        children: [{ type: "text", text: "{page}" }],
      }],
    };

    const html = renderToStaticMarkup(
      <PageRunningRegionView
        region={region}
        kind="footer"
        title="確認テスト"
        pageNumber={3}
        totalPages={8}
        metrics={metrics}
      />,
    );

    expect(html).toContain("text-flow-shell");
    expect(html).toContain("text-flow-editor");
    // The block-level print family is gone.
    expect(html).not.toContain("print-paragraph");
    expect(html).not.toContain("print-heading");
    expect(html).not.toContain("print-list");
    expect(html).not.toContain("print-running-text");
    expect(html).not.toContain("page-running-print-flow");
    // The block still carries its document id: `page-windows.ts` indexes the paged surface by it
    // and running region blocks are cloned onto every page.
    expect(html).toContain('data-sigma-doc-id="footer_p"');
    // `{page}` substitution has to survive the renderer swap.
    expect(html).toContain(">3</");
  });

  // The running region was the last place the PDF path drew overlay shapes by injecting an SVG
  // string. `.paged-surface` now renders them with the same React components as the body, so the
  // editor and the PDF cannot diverge.
  it("draws header shapes as React overlay shapes instead of an injected SVG string", () => {
    const metrics = getPageMetrics(getDefaultPageLayout());
    const region: PageRunningRegion = {
      enabled: true,
      heightMm: 24,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "header_p", children: [{ type: "text", text: "見出し" }] }],
      overlay: {
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [{
            id: "shape_header_rect",
            type: "geo",
            x: 12,
            y: 4,
            rotation: 0,
            props: {
              w: 40,
              h: 16,
              geo: "rectangle",
              fill: "none",
              color: "black",
              labelColor: "black",
              dash: "solid",
              size: "m",
            },
          }],
        },
      },
    } as unknown as PageRunningRegion;

    const html = renderToStaticMarkup(
      <PageRunningRegionView
        region={region}
        kind="header"
        title="タイトル"
        pageNumber={2}
        totalPages={3}
        metrics={metrics}
      />,
    );

    expect(html).toContain('data-overlay-shape-id="shape_header_rect"');
    expect(html).toContain("overlay-shape-geo");
    // The serializer's own wrapper markup is what must be gone.
    expect(html).not.toContain("<svg xmlns=");
    expect(html).toContain('class="page-running-overlay-preview"');
  });

  // `measurePageOwnership` indexes the paged surface by document order, and the running region is
  // cloned once per page — a layer that disappears when a header has no shapes would shift every
  // later index.
  it("keeps the overlay layer even when the header holds no shapes", () => {
    const metrics = getPageMetrics(getDefaultPageLayout());
    const region: PageRunningRegion = {
      enabled: true,
      heightMm: 24,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "header_p", children: [{ type: "text", text: "見出し" }] }],
    } as unknown as PageRunningRegion;

    const html = renderToStaticMarkup(
      <PageRunningRegionView
        region={region}
        kind="header"
        title="タイトル"
        pageNumber={2}
        totalPages={3}
        metrics={metrics}
      />,
    );

    expect(html).toContain('class="page-running-overlay-preview"');
    expect(html).not.toContain("data-overlay-shape-id");
  });

  // The editing band and the displayed region used to size the overlay differently (the page
  // sheet's 2px border), which an SVG `viewBox` hid. React places shapes at absolute px.
  it("sizes the overlay layer from the shared running-region overlay size", () => {
    const metrics = getPageMetrics(getDefaultPageLayout());
    const region = {
      enabled: true,
      heightMm: 24,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "header_p", children: [{ type: "text", text: "見出し" }] }],
    } as unknown as PageRunningRegion;
    const size = getRunningRegionOverlaySize(metrics.content.widthPx, region);

    const html = renderToStaticMarkup(
      <PageRunningRegionView
        region={region}
        kind="header"
        title="タイトル"
        pageNumber={2}
        totalPages={3}
        metrics={metrics}
      />,
    );

    expect(html).toContain(`width:${size.widthPx}px`);
    expect(html).toContain(`height:${size.heightPx}px`);
  });

  // Was a live divergence: `PrintPreview` passed the document's fraction sizing to the running
  // region while the page canvas did not, so a header formula could be typeset differently in the
  // editor than in the PDF. Both callers pass it now; asserted as plumbing rather than as a visual
  // difference, because whether two sizings differ depends on the formula.
  it("threads the document's math fraction sizing into the running text", () => {
    const metrics = getPageMetrics(getDefaultPageLayout());
    const region: PageRunningRegion = {
      enabled: true,
      heightMm: 16,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [{
        type: "paragraph",
        id: "header_math_p",
        children: [{ type: "mathInline", id: "header_frac", tex: "\\frac{1}{2}", display: "inline" }],
      }],
    };

    const html = renderToStaticMarkup(
      <PageRunningRegionView
        region={region}
        kind="header"
        title="t"
        pageNumber={1}
        totalPages={1}
        metrics={metrics}
        mathFractionSizing="uniform"
      />,
    );

    expect(html).toContain(renderMathHtml("\\frac{1}{2}", DEFAULT_MATH_RENDER_ENVIRONMENT));
  });
});
