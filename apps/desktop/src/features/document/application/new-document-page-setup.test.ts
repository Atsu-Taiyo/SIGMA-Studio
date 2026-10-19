import { describe, expect, it } from "vitest";

import type { PageLayout, SigmaDocument } from "../model";
import type { OverlaySnapshot } from "../overlay-model";
import {
  applyNewDocumentPageSetup,
  deriveNewDocumentPageSetup,
  normalizeNewDocumentPageSetup,
} from "./new-document-page-setup";
import { ensurePageLayout, getDefaultPageLayout } from "./page-layout";

const DATA_PNG = "data:image/png;base64,iVBORw0KGgo=";

function blank(): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: "doc_new",
    metadata: { title: "新しい教材" },
    content: [{ type: "paragraph", id: "p_new", children: [{ type: "text", text: "" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  });
}

function imageShape(id: string, assetId: string) {
  return { id, type: "image", x: 0, y: 0, rotation: 0, props: { assetId, w: 40, h: 20 } } as const;
}

function asset(id: string, src: string, storage?: { kind: "remote-asset"; storageKey: string; assetId: string }) {
  return { id, type: "image", props: { w: 40, h: 20, name: id, isAnimated: false, mimeType: "image/png", src, fileSize: 1, ...(storage ? { storage } : {}) } } as const;
}

function sourceDocument(): SigmaDocument {
  const layout: PageLayout = {
    ...getDefaultPageLayout("B5"),
    orientation: "landscape",
    pageSize: { widthMm: 257, heightMm: 182 },
    marginsMm: { top: 10, right: 12, bottom: 11, left: 13 },
    flow: { type: "columns", columnCount: 2, columnGapMm: 6, columnRule: { style: "solid", widthPx: 1, color: "#999999" } },
    header: {
      enabled: true,
      heightMm: 6,
      offsetMm: 4,
      showOnFirstPage: false,
      blocks: [{ type: "paragraph", id: "header_school", children: [{ type: "text", text: "○○高校 数学科" }] }],
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [imageShape("logo", "asset_logo"), imageShape("shared_logo", "asset_shared")],
          assets: {
            asset_logo: asset("asset_logo", DATA_PNG),
            asset_shared: asset("asset_shared", "sigma-doc-storage://abc"),
          },
        } as unknown as OverlaySnapshot,
      },
    },
    footer: {
      enabled: true,
      heightMm: 5,
      offsetMm: 4,
      showOnFirstPage: true,
      blocks: [{ type: "paragraph", id: "footer_page", align: "center", children: [{ type: "text", text: "{page}" }] }],
    },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [imageShape("body_figure", "asset_body")],
        assets: { asset_body: asset("asset_body", DATA_PNG) },
      } as unknown as OverlaySnapshot,
    },
    background: "grid",
  };
  return {
    ...blank(),
    docId: "doc_source",
    metadata: { title: "前の教材", headingNumbering: { enabled: true, style: "chapterJa", depth: 2 } },
    content: [{ type: "paragraph", id: "p_body", children: [{ type: "text", text: "本文" }] }],
    pageLayout: layout,
  };
}

describe("new document page setup", () => {
  it("carries the paper, margins, columns, header/footer and heading numbers onto a blank document", () => {
    const setup = deriveNewDocumentPageSetup(sourceDocument());
    const created = applyNewDocumentPageSetup(blank(), setup);

    expect(created.docId).toBe("doc_new");
    expect(created.metadata.title).toBe("新しい教材");
    expect(created.content).toEqual(blank().content);
    expect(created.metadata.headingNumbering).toEqual({ enabled: true, style: "chapterJa", depth: 2 });
    expect(created.pageLayout).toMatchObject({
      preset: "B5",
      orientation: "landscape",
      pageSize: { widthMm: 257, heightMm: 182 },
      marginsMm: { top: 10, right: 12, bottom: 11, left: 13 },
      flow: { columnCount: 2, columnGapMm: 6, columnRule: { style: "solid" } },
      background: "grid",
      header: { enabled: true, heightMm: 6, offsetMm: 4, showOnFirstPage: false },
      footer: { enabled: true, heightMm: 5, offsetMm: 4 },
    });
    expect(created.pageLayout?.header?.blocks).toEqual(sourceDocument().pageLayout?.header?.blocks);
    expect(created.pageLayout?.footer?.blocks[0]).toMatchObject({ align: "center" });
  });

  it("leaves the body figures behind and keeps only header images that live in the document itself", () => {
    const created = applyNewDocumentPageSetup(blank(), deriveNewDocumentPageSetup(sourceDocument()));

    expect(created.pageLayout?.overlay).toBeUndefined();
    const headerSnapshot = created.pageLayout?.header?.overlay?.overlaySnapshot;
    expect(headerSnapshot?.shapes.map((shape) => shape.id)).toEqual(["logo"]);
    expect(Object.keys(headerSnapshot?.assets ?? {})).toEqual(["asset_logo"]);
  });

  it("does not share header objects with the source document", () => {
    const source = sourceDocument();
    const created = applyNewDocumentPageSetup(blank(), deriveNewDocumentPageSetup(source));
    const header = created.pageLayout!.header!;
    header.blocks[0] = { type: "paragraph", id: "changed", children: [] };

    expect(source.pageLayout?.header?.blocks[0]).toMatchObject({ id: "header_school" });
  });

  it("never turns a new material into a whiteboard", () => {
    const whiteboard = { ...blank(), content: [], pageLayout: getDefaultPageLayout("whiteboard") };

    expect(deriveNewDocumentPageSetup(whiteboard)).toBeNull();
    expect(normalizeNewDocumentPageSetup({ pageLayout: { preset: "whiteboard" } })).toBeNull();
    expect(applyNewDocumentPageSetup(blank(), { pageLayout: getDefaultPageLayout("whiteboard") })).toEqual(blank());
  });

  it("falls back to the blank document for corrupt stored values", () => {
    for (const value of [null, "A4", [], {}, { pageLayout: "B5" }, { pageLayout: [] }]) {
      expect(normalizeNewDocumentPageSetup(value)).toBeNull();
    }
    expect(applyNewDocumentPageSetup(blank(), null)).toEqual(blank());
  });

  it("repairs numbers and keeps the body below an enabled header", () => {
    const setup = normalizeNewDocumentPageSetup({
      pageLayout: {
        preset: "A4",
        marginsMm: { top: 2, right: -4, bottom: "x", left: 15 },
        header: { enabled: true, heightMm: 9, offsetMm: 6, blocks: [] },
      },
      headingNumbering: { enabled: true, style: "roman", depth: 7 },
    });

    expect(setup?.pageLayout.marginsMm).toEqual({ top: 15, right: 17, bottom: 18, left: 15 });
    expect(setup?.headingNumbering).toEqual({ enabled: true });
  });

  it("drops heading numbers that the new document should not invent", () => {
    const withoutNumbers = { ...sourceDocument(), metadata: { title: "前の教材" } };
    const created = applyNewDocumentPageSetup(
      { ...blank(), metadata: { title: "新しい教材", headingNumbering: { enabled: true } } },
      deriveNewDocumentPageSetup(withoutNumbers),
    );

    expect(created.metadata.headingNumbering).toBeUndefined();
  });
});
