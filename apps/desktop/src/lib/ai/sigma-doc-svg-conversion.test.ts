import { describe, expect, it } from "vitest";

import { normalizeOverlaySnapshot, type OverlayAsset, type OverlayShape, type OverlaySnapshot, type SigmaDocument } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import { AI_SVG_CONVERSION_LINE_SIZES, convertSvgImageShape, convertSvgImageToSigma } from "@/lib/svg-to-sigma";

import { createSigmaDocAgentSession, executeSigmaDocAgentDraftTool, getSigmaDocAgentSessionDraft } from "./sigma-doc-agent-tools";
import {
  applySigmaDocMutationOp,
  createAiEditSessionDocumentDraft,
  getInvalidAiOverlayAssetIdsInDocument,
  isAllowedAiOverlayAssetSource,
  type SigmaDocMutationOp,
} from "./sigma-doc-edit-schema";

/** A hairline, a main line, a kept-as-SVG arc between them, and a label: what "図形に変換" sees in a figure. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">'
  + '<line x1="10" y1="20" x2="190" y2="20" stroke="#111111" stroke-width="0.75"/>'
  + '<path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="#111111" stroke-width="2"/>'
  + '<rect x="40" y="40" width="60" height="30" fill="none" stroke="#111111" stroke-width="2"/>'
  + '<text x="120" y="60" font-size="15" fill="#111111">ラベル</text></svg>';
const svgAsset = (source = SVG): OverlayAsset => ({
  id: "figure_asset", type: "image",
  props: { w: 200, h: 120, name: "図", mimeType: "image/svg+xml", isAnimated: false, src: `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`, fileSize: source.length },
});
const image = (extra: Partial<OverlayShape> = {}): OverlayShape => ({
  id: "figure", type: "image", x: 40, y: 60, props: { assetId: "figure_asset", w: 200, h: 120 }, ...extra,
} as OverlayShape);
const other = (id: string): OverlayShape => ({
  id, type: "geo", x: 0, y: 0, props: { w: 20, h: 20, geo: "rectangle", fill: "none", color: "#111111", labelColor: "#111111", dash: "solid", size: "m" },
} as OverlayShape);

function documentWith(shapes: OverlayShape[], assets: Record<string, OverlayAsset> = { figure_asset: svgAsset() }): SigmaDocument {
  return { ...structuredClone(sampleDocument), pageLayout: { ...structuredClone(sampleDocument.pageLayout), overlay: { overlaySnapshot: { version: 1, shapes, assets } } } } as SigmaDocument;
}
const snapshotOf = (document: SigmaDocument): OverlaySnapshot => normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
const lineSizes = (shapes: readonly OverlayShape[]) => shapes.flatMap((shape) => (shape.type === "line" || shape.type === "geo" ? [shape.props.size] : []));

describe("the AI's SVG conversion and the canvas's", () => {
  it("lifts a hairline to a thin line only when it is asked to (the AI path)", () => {
    const snapshot: OverlaySnapshot = { version: 1, shapes: [image()], assets: { figure_asset: svgAsset() } };
    const target = { image: snapshot.shapes[0] as Extract<OverlayShape, { type: "image" }>, asset: snapshot.assets.figure_asset };
    expect(AI_SVG_CONVERSION_LINE_SIZES).toEqual(["s", "m", "l", "xl"]);
    const canvas = convertSvgImageShape(target);
    const ai = convertSvgImageShape(target, undefined, undefined, undefined, { lineSizes: AI_SVG_CONVERSION_LINE_SIZES });
    expect(lineSizes(canvas.shapes)).toContain("xs");
    expect(lineSizes(ai.shapes)).not.toContain("xs");
    expect(lineSizes(ai.shapes)).toEqual(lineSizes(canvas.shapes).map((size) => (size === "xs" ? "s" : size)));
    // The same converter otherwise: the image keeps its id at the head, and nothing in the snapshot moves.
    expect(ai.shapes[0]).toMatchObject({ id: "figure", type: "group" });
    expect(ai.preservedCount).toBe(1);
    expect(snapshot.shapes).toEqual([image()]);
    // The snapshot-level conversion the canvas menu uses keeps xs.
    expect(lineSizes(convertSvgImageToSigma(snapshot, "figure").snapshot.shapes)).toContain("xs");
  });

  it("lets a kept SVG fragment through the AI asset gate, so later AI proposals on the material still validate", () => {
    const converted = convertSvgImageToSigma({ version: 1, shapes: [image()], assets: { figure_asset: svgAsset() } }, "figure");
    const fragments = Object.values(converted.snapshot.assets);
    expect(fragments).toHaveLength(1);
    expect(isAllowedAiOverlayAssetSource(fragments[0]!.props.src)).toBe(true);
    expect(getInvalidAiOverlayAssetIdsInDocument(documentWith(converted.snapshot.shapes, converted.snapshot.assets))).toEqual([]);
    // Scripts and outside references stay refused.
    const unsafe = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>').toString("base64")}`;
    expect(isAllowedAiOverlayAssetSource(unsafe)).toBe(false);
  });
});

describe("replaceOverlayShape", () => {
  const conversion = () => convertSvgImageShape({ image: image() as never, asset: svgAsset() }, undefined, undefined, undefined, { lineSizes: AI_SVG_CONVERSION_LINE_SIZES });
  const op = (extra: Partial<Extract<SigmaDocMutationOp, { operation: "replaceOverlayShape" }>> = {}) => {
    const { shapes, assets } = conversion();
    return { operation: "replaceOverlayShape" as const, summary: "変換", shapeId: "figure", shapes, assets, ...extra };
  };

  it("puts the replacement in the image's place and stack position, and drops the image's picture", () => {
    const document = documentWith([other("below"), image(), other("above")]);
    const replacement = op();
    const next = snapshotOf(applySigmaDocMutationOp(document, replacement).nextDocument);
    const ids = next.shapes.map((shape) => shape.id);
    expect(ids[0]).toBe("below");
    expect(ids.at(-1)).toBe("above");
    expect(next.shapes.find((shape) => shape.id === "figure")?.type).toBe("group");
    expect(ids).toEqual(["below", ...replacement.shapes.map((shape) => shape.id), "above"]);
    expect(next.assets.figure_asset).toBeUndefined();
    expect(Object.keys(next.assets)).toEqual(Object.keys(replacement.assets));
  });

  it("refuses a missing target, a head that drops the id, a member id that is taken and an unsafe asset", () => {
    const document = documentWith([image(), other("taken")]);
    expect(() => applySigmaDocMutationOp(document, op({ shapeId: "missing" }))).toThrow(/missing/);
    const replacement = op();
    expect(() => applySigmaDocMutationOp(document, { ...replacement, shapes: replacement.shapes.slice(1) })).toThrow();
    expect(() => applySigmaDocMutationOp(document, { ...replacement, shapes: [replacement.shapes[0]!, { ...replacement.shapes[1]!, id: "taken" }] })).toThrow(/taken/);
    const unsafe = { ...svgAsset(), id: "bad", props: { ...svgAsset().props, src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } };
    expect(() => applySigmaDocMutationOp(document, { ...replacement, assets: { bad: unsafe } })).toThrow();
  });

  it("replays after the insertion of the same image in one proposal (inserted, then converted in the same turn)", () => {
    const base = documentWith([], {});
    const insertion = { operation: "insertOverlayShape" as const, summary: "挿入", targetId: base.content[0]!.id, overlayShape: image(), assets: { figure_asset: svgAsset() } };
    const replayed = createAiEditSessionDocumentDraft(base, null, {
      summary: "提案", plan: [], warnings: [], operations: [insertion], mutationOperations: [op()],
    });
    const snapshot = snapshotOf(replayed.nextDocument);
    expect(snapshot.shapes.find((shape) => shape.id === "figure")?.type).toBe("group");
    expect(snapshot.assets.figure_asset).toBeUndefined();
  });
});

describe("draft_convert_svg_image", () => {
  it("estimates text and math without the app, says so in the proposal, and lifts hairlines", () => {
    const session = createSigmaDocAgentSession({ document: documentWith([image()]), selectedId: null });
    const result = executeSigmaDocAgentDraftTool(session, "draft_convert_svg_image", { shapeId: "figure" });
    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain("推定");
    expect(result.data).toMatchObject({ conversion: { measurement: "estimate", keptAsSvgCount: 1, groupId: "figure" } });
    expect((result.data as { conversion: { note?: string } }).conversion.note).toContain("図形に変換");
    const snapshot = snapshotOf(session.draftDocument);
    expect(snapshot.shapes.find((shape) => shape.id === "figure")?.type).toBe("group");
    expect(lineSizes(snapshot.shapes)).not.toContain("xs");
    const draft = getSigmaDocAgentSessionDraft(session, { summary: result.message, plan: [], changedIds: result.changedIds, warnings: [] });
    expect(draft.draft.mutationOperations).toMatchObject([{ operation: "replaceOverlayShape", shapeId: "figure" }]);
  });

  it("uses the conversion the app measured as it is", () => {
    const measured = convertSvgImageShape({ image: image() as never, asset: svgAsset() }, undefined, undefined, () => ({ width: 77, height: 20, baseline: 15 }), { lineSizes: AI_SVG_CONVERSION_LINE_SIZES });
    const session = createSigmaDocAgentSession({ document: documentWith([image()]), selectedId: null });
    const result = executeSigmaDocAgentDraftTool(session, "draft_convert_svg_image", { shapeId: "figure", measuredConversion: measured });
    expect(result.ok, result.message).toBe(true);
    expect(result.message).not.toContain("推定");
    expect(result.data).toMatchObject({ conversion: { measurement: "app" } });
    const text = snapshotOf(session.draftDocument).shapes.find((shape) => shape.type === "text");
    expect(text).toMatchObject({ props: { w: 77 } });
  });

  it("refuses a raster image, a locked image, a converted group and a measurement of another image", () => {
    const png: OverlayAsset = { id: "png", type: "image", props: { w: 1, h: 1, name: "写真", mimeType: "image/png", isAnimated: false, src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", fileSize: 10 } };
    const cases: Array<[SigmaDocument, Record<string, unknown>, RegExp]> = [
      [documentWith([image({ props: { assetId: "png", w: 1, h: 1 } } as never)], { png }), { shapeId: "figure" }, /SVG画像/],
      [documentWith([image({ locked: true })]), { shapeId: "figure" }, /固定/],
      [documentWith([other("figure")]), { shapeId: "figure" }, /SVG画像/],
      [documentWith([image()]), { shapeId: "figure", measuredConversion: { ...convertSvgImageShape({ image: image({ id: "elsewhere" }) as never, asset: svgAsset() }) } }, /一致しません/],
    ];
    for (const [document, args, message] of cases) {
      const session = createSigmaDocAgentSession({ document, selectedId: null });
      const result = executeSigmaDocAgentDraftTool(session, "draft_convert_svg_image", args);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(message);
      expect(session.mutationOperations).toEqual([]);
    }
  });

  it("refuses a conversion that would leave more SVG fragments than one proposal holds", () => {
    // Arcs between rectangles: every arc stays SVG on its own.
    const parts = Array.from({ length: 17 }, (_, index) => `<rect x="${index * 10}" y="10" width="5" height="5" fill="none" stroke="#111111" stroke-width="2"/>`
      + `<path d="M${index * 10},40 A5,5 0 0 1 ${index * 10 + 8},40" fill="none" stroke="#111111" stroke-width="2"/>`).join("");
    const crowded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">${parts}</svg>`;
    const measured = convertSvgImageShape({ image: image() as never, asset: svgAsset(crowded) }, undefined, () => ({ x: 0, y: 30, w: 10, h: 12 }));
    expect(measured.preservedCount).toBe(17);
    const session = createSigmaDocAgentSession({ document: documentWith([image()], { figure_asset: svgAsset(crowded) }), selectedId: null });
    const result = executeSigmaDocAgentDraftTool(session, "draft_convert_svg_image", { shapeId: "figure", measuredConversion: measured });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("17");
  });
});
