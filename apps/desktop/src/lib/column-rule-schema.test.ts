import { describe, expect, it } from "vitest";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";
import { parseSigmaDocument } from "./sigma-doc-schema";

const rule = { style: "dashed" as const, widthPx: 2, color: "#123456" };
const document: SigmaDocument = {
  version: "2.0", docId: "rules", metadata: { title: "段間の線" },
  pageLayout: { ...getDefaultPageLayout(), flow: { type: "columns", columnCount: 2, columnGapMm: 8, columnRule: rule } },
  content: [{
    type: "layoutSection", id: "local", layout: { columnCount: 2, columnRule: { ...rule, style: "dotted" } },
    children: [{ type: "paragraph", id: "p", children: [] }],
  }],
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

describe("column-rule persistence", () => {
  it("round trips separate global and local rules", () => {
    const parsed = parseSigmaDocument(JSON.parse(JSON.stringify(document)));
    expect(parsed.pageLayout?.flow.columnRule).toEqual(rule);
    expect(parsed.content[0]).toMatchObject({ layout: { columnRule: { ...rule, style: "dotted" } } });
  });
  it.each([
    { style: "unknown" }, { widthPx: -1 }, { widthPx: 100 }, { color: "red;position:fixed" },
  ])("rejects invalid rule properties %j", invalid => {
    const input = structuredClone(document);
    input.pageLayout!.flow.columnRule = { ...rule, ...invalid } as typeof rule;
    expect(() => parseSigmaDocument(input)).toThrow();
  });
});
