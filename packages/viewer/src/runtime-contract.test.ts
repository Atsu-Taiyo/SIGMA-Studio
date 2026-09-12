import { describe, expect, it } from "vitest";

import { parseSigmaDocument } from "./index";
import type { OverlayShape } from "./overlay-types";
import type { SigmaDocument } from "./types";

/**
 * canonical-contract.test.ts only guards that the viewer's TypeScript types
 * stay assignable with apps/desktop's model. It says nothing about the
 * *runtime* validator (parseSigmaDocument / viewer-safety.ts), which drifted
 * stricter than what Sigma Studio actually persists and silently rejected a
 * third of one user's real documents. These fixtures encode the exact
 * real-world shapes that tripped that drift so the regression can't recur
 * unnoticed.
 */
describe("runtime contract stays aligned with what Sigma Studio persists", () => {
  it("drops a text shape whose optional attributes are explicitly null, without failing the document", () => {
    // Tiptap serializes an unset attribute as `null`, and the overlay text model used to persist
    // its editor document verbatim, so real files carry shapes like this. The model no longer
    // does — Sigma Studio's own schema now rejects an explicitly-null optional outright, refusing
    // the whole document — which leaves the viewer as the only reader such a file still reaches.
    // It must lose the one shape it cannot read, never the page around it.
    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([{
      id: "overlay_shape_null_attrs",
      type: "text",
      x: 10,
      y: 10,
      rotation: 0,
      props: {
        w: 240,
        h: 24,
        color: "#111111",
        size: "m",
        blocks: [{
          type: "paragraph",
          id: "p_null_attrs",
          align: null,
          lineHeight: null,
          children: [{ type: "text", text: "null attrs", marks: null, color: null, fontSize: null }],
        }],
      },
    } as unknown as OverlayShape]);

    const parsed = parseSigmaDocument(document);

    expect(parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).toEqual([]);
    expect(parsed.content).toEqual(document.content);

    // The nulls are what cost it: the same shape with those keys simply absent comes through.
    const withoutNulls = createDocument();
    withoutNulls.pageLayout = pageLayoutWithShapes([{
      id: "overlay_shape_null_attrs",
      type: "text",
      x: 10,
      y: 10,
      rotation: 0,
      props: {
        w: 240,
        h: 24,
        color: "#111111",
        size: "m",
        blocks: [{
          type: "paragraph",
          id: "p_null_attrs",
          children: [{ type: "text", text: "null attrs" }],
        }],
      },
    } as unknown as OverlayShape]);

    expect((parseSigmaDocument(withoutNulls).pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])
      .map((shape) => shape.id)).toEqual(["overlay_shape_null_attrs"]);
  });

  it("validates boxBlock frame.bodyLineHeight as a CSS length, not a unitless multiplier", () => {
    // Real documents persist bodyLineHeight as a notebook-rule pitch in px
    // (see docs/sigma-doc-schema.md and box-blocks.ts), not the 0.8〜3
    // unitless multiplier used by section/heading/paragraph lineHeight.
    const document = createDocument();
    document.content = [{
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [{ type: "paragraph", id: "box_body", children: [{ type: "text", text: "body" }] }],
      frame: { bodyLineHeight: "23.35px" },
    }];

    expect(() => parseSigmaDocument(document)).not.toThrow();
  });

  it("renders a current-format callout shape and drops an obsolete one instead of rejecting the document", () => {
    const currentCallout: OverlayShape = {
      id: "overlay_shape_callout_current",
      type: "callout",
      x: 100,
      y: 100,
      rotation: 0,
      props: {
        w: 120,
        h: 60,
        radius: 8,
        tail: {
          baseStart: { x: 40, y: 60 },
          baseEnd: { x: 60, y: 60 },
          tip: { x: 50, y: 90 },
        },
        blocks: [{
          type: "paragraph",
          id: "p_callout",
          children: [{ type: "text", text: "callout" }],
        }],
        color: "black",
        size: "m",
        dash: "solid",
        strokeWidth: "m",
      },
    };
    // Mirrors a real persisted callout predating the tail-based redesign:
    // missing radius/color/size/dash/strokeWidth entirely. Sigma Studio's
    // own file-open path drops shapes like this rather than failing the
    // whole document (features/document/overlay-snapshot.ts recoverOverlaySnapshot).
    const obsoleteCallout = {
      id: "overlay_shape_callout_obsolete",
      type: "callout",
      x: 200,
      y: 200,
      rotation: 0,
      props: {
        w: 200,
        h: 60,
        tailX: 100,
        tailY: 0,
        label: "",
        fill: "solid",
        fillColor: "#ffffff",
        fillOpacity: 1,
        tailWidth: 40,
      },
    } as unknown as OverlayShape;

    const document = createDocument();
    document.pageLayout = pageLayoutWithShapes([currentCallout, obsoleteCallout]);

    const parsed = parseSigmaDocument(document);
    const shapes = parsed.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    expect(shapes.map((shape) => shape.id)).toEqual(["overlay_shape_callout_current"]);
  });
});

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "runtime-contract",
    metadata: { title: "Runtime contract" },
    content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "body" }] }],
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function pageLayoutWithShapes(
  shapes: NonNullable<NonNullable<SigmaDocument["pageLayout"]>["overlay"]>["overlaySnapshot"] extends infer Snapshot
    ? Snapshot extends { shapes: infer Shapes }
      ? Shapes
      : never
    : never,
): NonNullable<SigmaDocument["pageLayout"]> {
  return {
    preset: "A4",
    orientation: "portrait",
    pageSize: { widthMm: 210, heightMm: 297 },
    marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes,
        assets: {},
      },
    },
  };
}
