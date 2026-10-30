// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { documentMeasurementScript } from "./document-measurement";

describe("extension document measurement probes", () => {
  it("serializes arbitrary IDs as data and uses only the canonical canvas", () => {
    const id = 'a";globalThis.injected=true;//';
    const script = documentMeasurementScript([id]);
    expect(script).toContain(JSON.stringify([id]));
    expect(script).toContain("CSS.escape(id)");
    expect(script).toContain(".page-canvas");
    expect(script).toContain("document.fonts.ready");
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });
  it.each([{ ids: [""] }, { ids: ["x".repeat(257)] }, { ids: Array.from({ length: 25_001 }, () => "p") }])("rejects invalid probe lists", ({ ids }) => {
    expect(() => documentMeasurementScript(ids)).toThrow();
  });
  it("measures later paragraphs in the full stage rather than a single printed page clone", async () => {
    document.body.innerHTML = '<div class="page-canvas"><p data-sigma-doc-id="first"></p></div>'
      + '<div class="paged-surface-stage"><div class="page-canvas"><p data-sigma-doc-id="later"></p></div></div>';
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    vi.stubGlobal("CSS", { escape: (id: string) => id });
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    try {
      const result = await new Function(`return (${documentMeasurementScript(["later", "absent"])})`)();
      expect(result.rows[0]).toMatchObject({ id: "later", baseline: 0 });
      expect(result.rows[0].missing).toBeUndefined();
      expect(result.rows[1]).toEqual({ id: "absent", missing: true });
    } finally {
      context.mockRestore(); vi.unstubAllGlobals(); document.body.innerHTML = "";
    }
  });
});
