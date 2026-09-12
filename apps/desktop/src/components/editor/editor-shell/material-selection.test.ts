import { describe, expect, it } from "vitest";

import { buildSelectedMaterialContent } from "@/components/editor/editor-shell/material-selection";
import type { OverlayAsset, OverlayShape } from "@/features/document";
import { createEmptyEditorDocument } from "@/lib/blank-document";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

describe("buildSelectedMaterialContent", () => {
  it("captures a selected block without adding unrelated overlay content", () => {
    const block = paragraph("selected-block", "素材本文");
    const unrelatedShape = rectangle("unrelated", 20, 30);
    const document = createDocument([block], [unrelatedShape]);

    const content = buildSelectedMaterialContent(document, block.id, [], {});

    expect(content?.blocks).toEqual([block]);
    expect(content?.blocks[0]).not.toBe(block);
    expect(content?.overlaySnapshot).toEqual({
      version: 1,
      shapes: [],
      assets: {},
    });
  });

  it("captures an explicitly selected shape without a block", () => {
    const selectedShape = {
      ...rectangle("selected-shape", 40, 60),
      anchor: { type: "block", blockId: "unselected-block", dy: 8 } as const,
    };

    const content = buildSelectedMaterialContent(
      createDocument(),
      null,
      [selectedShape],
      {},
    );

    expect(content?.blocks).toEqual([]);
    expect(content?.overlaySnapshot.shapes).toHaveLength(1);
    expect(content?.overlaySnapshot.shapes[0]).toMatchObject({
      id: selectedShape.id,
      x: 0,
      y: 0,
      anchor: { type: "page" },
    });
  });

  it("captures multiple selected text blocks in document order", () => {
    const first = paragraph("selected-first", "最初の本文");
    const second = paragraph("selected-second", "次の本文");
    const content = buildSelectedMaterialContent(
      createDocument([first, second]),
      null,
      [],
      {},
      [second.id, first.id],
    );

    expect(content?.blocks.map((block) => block.id)).toEqual([first.id, second.id]);
  });

  it("deduplicates block-anchored and explicitly selected shapes by id", () => {
    const block = paragraph("selected-block", "素材本文");
    const anchoredShape = {
      ...rectangle("shared-shape", 10, 20, 20, 30),
      anchor: { type: "block", blockId: block.id, dy: 0 } as const,
    };
    const explicitShape = {
      ...anchoredShape,
      props: {
        ...anchoredShape.props,
        w: 44,
      },
    };
    const document = createDocument([block], [anchoredShape]);

    const content = buildSelectedMaterialContent(
      document,
      block.id,
      [explicitShape],
      {},
    );

    expect(content?.overlaySnapshot.shapes).toHaveLength(1);
    expect(content?.overlaySnapshot.shapes[0]).toMatchObject({
      id: anchoredShape.id,
      props: { w: 44 },
    });
  });

  it("copies only referenced assets and lets selected assets override snapshot assets", () => {
    const documentAsset = imageAsset("used", "document");
    const selectedAsset = imageAsset("used", "selection");
    const unusedAsset = imageAsset("unused", "unused");
    const shape = imageShape("selected-image", "used", 25, 35);
    const document = createDocument([], [], {
      used: documentAsset,
      unused: unusedAsset,
    });

    const content = buildSelectedMaterialContent(
      document,
      null,
      [shape],
      {
        used: selectedAsset,
        unused: unusedAsset,
      },
    );

    expect(content?.overlaySnapshot.assets).toEqual({
      used: selectedAsset,
    });
  });

  it("normalizes all selected shape positions to their shared top-left origin", () => {
    const first = rectangle("first", 30, 50, 20, 10);
    const second = rectangle("second", 70, 80, 15, 25);

    const content = buildSelectedMaterialContent(
      createDocument(),
      null,
      [first, second],
      {},
    );

    expect(content?.overlaySnapshot.shapes.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "first", x: 0, y: 0 },
      { id: "second", x: 40, y: 30 },
    ]);
  });

  it("returns null when neither a block nor a shape is selected", () => {
    expect(buildSelectedMaterialContent(createDocument(), null, [], {})).toBeNull();
    expect(buildSelectedMaterialContent(createDocument(), "missing", [], {})).toBeNull();
  });
});

function createDocument(
  content: SigmaBlock[] = [],
  shapes: OverlayShape[] = [],
  assets: Record<string, OverlayAsset> = {},
): SigmaDocument {
  const document = structuredClone(createEmptyEditorDocument());
  document.content = content;
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes,
        assets,
      },
    },
  };
  return document;
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: [{ type: "text", text }],
  };
}

function rectangle(
  id: string,
  x: number,
  y: number,
  w = 20,
  h = 20,
): Extract<OverlayShape, { type: "geo" }> {
  return {
    id,
    type: "geo",
    x,
    y,
    rotation: 0,
    props: {
      w,
      h,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function imageShape(
  id: string,
  assetId: string,
  x: number,
  y: number,
): Extract<OverlayShape, { type: "image" }> {
  return {
    id,
    type: "image",
    x,
    y,
    rotation: 0,
    props: {
      assetId,
      w: 100,
      h: 80,
    },
  };
}

function imageAsset(id: string, source: string): OverlayAsset {
  return {
    id,
    type: "image",
    props: {
      w: 100,
      h: 80,
      name: `${id}.png`,
      isAnimated: false,
      mimeType: "image/png",
      src: `data:image/png;base64,${source}`,
      fileSize: source.length,
    },
  };
}
