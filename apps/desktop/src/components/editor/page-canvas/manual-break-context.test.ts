import { describe, expect, it } from "vitest";
import type { SigmaBlock, SigmaDocument } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import { canInsertManualBreakAtBlock, canUseManualBreakAtBlock } from "./manual-break-context";
import { resolveColumnCommandState } from "./column-command-state";

const paragraph = (id: string): SigmaBlock => ({ type: "paragraph", id, children: [{ type: "text", text: id }] });
const box = (id: string, blocks: SigmaBlock[]): SigmaBlock => ({ ...createBoxBlock("fancybox", "", { id }), blocks });
const columns = (id: string, children: SigmaBlock[]): SigmaBlock => ({ type: "layoutSection", id, layout: { columnCount: 2 }, children: children as Extract<SigmaBlock, { type: "layoutSection" }>["children"] });
const document = (content: SigmaBlock[]): SigmaDocument => ({ version: "2.0", docId: "test", metadata: { title: "test" }, content, outputProfiles: { student: {}, teacher: {}, answerBook: {} } });

describe("contextual layout commands", () => {
  it("rejects page breaks at every depth below a box, including code and quotes", () => {
    const doc = document([paragraph("outside"), box("outer", [
      paragraph("body"), box("inner", [{ type: "codeBlock", id: "code", children: [{ type: "text", text: "code" }] }]),
      { type: "quote", id: "quote", blocks: [paragraph("quoted") as Extract<SigmaBlock, { type: "paragraph" }>] },
    ])]);
    for (const id of ["body", "inner", "code", "quote", "quoted"]) expect(canUseManualBreakAtBlock(doc, id), id).toBe(false);
    expect(canUseManualBreakAtBlock(doc, "outside")).toBe(true);
    expect(canUseManualBreakAtBlock(doc, "outer")).toBe(true);
  });

  it("rejects manual breaks in independent columns inside and outside boxes", () => {
    const doc = document([columns("outerColumns", [box("outer", [
      paragraph("body"), columns("innerColumns", [paragraph("columnBody"), box("inner", [paragraph("deepBody")])]),
    ])])]);
    expect(canInsertManualBreakAtBlock(document([columns("outside", [paragraph("left"), paragraph("right")])]), "left")).toBe(false);
    expect(canUseManualBreakAtBlock(doc, "body")).toBe(false);
    expect(canUseManualBreakAtBlock(doc, "columnBody")).toBe(false);
    expect(canUseManualBreakAtBlock(doc, "innerColumns")).toBe(false);
    expect(canUseManualBreakAtBlock(doc, "deepBody")).toBe(false);
  });

  it("hides extra column insertion when all local boundaries are already used", () => {
    const section = columns("columns", [paragraph("first"), { ...paragraph("second"), pagination: { break: true } }, paragraph("third")]);
    const doc = document([box("box", [section])]);
    expect(canUseManualBreakAtBlock(doc, "second")).toBe(false);
    expect(canInsertManualBreakAtBlock(doc, "third")).toBe(false);
  });

  it("offers the same column controls inside and outside boxes, but none inside quotes", () => {
    const quote = (id: string): SigmaBlock => ({ type: "quote", id, blocks: [paragraph(id + "Body") as Extract<SigmaBlock, { type: "paragraph" }>] });
    const doc = document([paragraph("outside"), quote("outsideQuote"), box("box", [paragraph("inside"), quote("insideQuote")])]);
    expect(resolveColumnCommandState(doc, "inside")).toEqual(resolveColumnCommandState(doc, "outside"));
    expect(resolveColumnCommandState(doc, "insideQuoteBody").enabled).toBe(false);
    expect(resolveColumnCommandState(doc, "outsideQuoteBody").enabled).toBe(false);
  });
});
