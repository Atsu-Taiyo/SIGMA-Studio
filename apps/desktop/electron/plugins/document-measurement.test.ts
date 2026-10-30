// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { documentMeasurementScript } from "./document-measurement";

describe("extension document measurement probes", () => {
  it("serializes arbitrary IDs as data and uses only the canonical canvas", () => {
    const id = 'a";globalThis.injected=true;//';
    const script = documentMeasurementScript([id]);
    expect(script).toContain(JSON.stringify([id]));
    expect(script).toContain(".page-canvas");
    expect(script).toContain("document.fonts.ready");
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });
  it("resolves repeated, missing and arbitrary IDs in order with one paragraph scan", async () => {
    const id = 'a";globalThis.injected=true;//';
    const stage = document.createElement("div");
    stage.className = "paged-surface-stage";
    const canvas = document.createElement("div");
    canvas.className = "page-canvas";
    stage.append(canvas); document.body.append(stage);
    for (const [name, height] of [[id, 11], [id, 22], ["__proto__", 33]] as const) {
      const paragraph = document.createElement("p");
      paragraph.setAttribute("data-sigma-doc-id", name);
      paragraph.getBoundingClientRect = () => ({ height } as DOMRect);
      canvas.append(paragraph);
    }
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const lookup = vi.spyOn(canvas, "querySelector");
    const scan = vi.spyOn(canvas, "querySelectorAll");
    try {
      const ids = [id, "missing", "__proto__", ...Array.from({ length: 100 }, () => id)];
      const result = await new Function(`return (${documentMeasurementScript(ids)})`)();
      expect(result.rows.map((row: { id: string }) => row.id)).toEqual(ids);
      expect(result.rows[0].height).toBe(11);
      expect(result.rows[1]).toEqual({ id: "missing", missing: true });
      expect(result.rows[2].height).toBe(33);
      expect(result.rows.at(-1).height).toBe(11);
      expect("injected" in globalThis).toBe(false);
      // Resolving more probe IDs must not search the entire canvas once per row.
      expect(lookup.mock.calls.length).toBeLessThanOrEqual(1);
      expect(scan.mock.calls.length).toBeLessThanOrEqual(1);
      lookup.mockClear(); scan.mockClear();
      expect(await new Function(`return (${documentMeasurementScript([])})`)()).toEqual({ rows: [] });
      expect(scan).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore(); scan.mockRestore(); context.mockRestore(); stage.remove();
    }
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
