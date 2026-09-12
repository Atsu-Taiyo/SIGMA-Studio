import { describe, expect, it } from "vitest";

import { sampleDocument } from "./sample-document";

describe("sampleDocument", () => {
  it("bundles the current range sample without graph overlays", () => {
    expect(sampleDocument.version).toBe("2.0");
    expect(sampleDocument.docId).toBe("doc_complex_square_product_range_20260606");
    expect(sampleDocument.content).toHaveLength(1);
    expect(sampleDocument.content[0]).toMatchObject({
      type: "problem",
      id: "problem_complex_square_product_range",
      tags: ["複素数平面", "軌跡", "東大実戦"],
      prompt: [
        { id: "p_problem_statement" },
        { id: "p_source_note" },
      ],
      hints: [],
    });

    const problem = sampleDocument.content[0];
    expect(problem.type).toBe("problem");
    if (problem.type !== "problem") {
      return;
    }
    expect(problem.solution.map((block) => block.id)).not.toContain("p_solution_separator");
    expect(problem.solution.map((block) => block.id)).not.toContain("p_solution_label");
    expect(problem.solution.map((block) => block.id)).not.toContain("p_graph_intro");
    expect(problem.solution.at(-1)?.id).toBe("p_range_f_conclusion");
    expect([...problem.lead, ...problem.prompt, ...problem.solution, ...problem.hints]
      .some((block) => block.pagination?.break === true)).toBe(false);

    const shapes = sampleDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const shapeIds = shapes.map((shape) => shape.id);

    expect((sampleDocument.pageLayout?.overlay as Record<string, unknown> | undefined)?.previewSvg).toBeUndefined();
    expect(JSON.stringify(sampleDocument.pageLayout?.overlay)).not.toContain("<svg");
    expect(shapes).toEqual([]);
    expect(new Set(shapeIds).size).toBe(shapeIds.length);
    expect(shapeIds.some((id) => id.startsWith("complex_range_f_"))).toBe(false);
    expect(JSON.stringify(sampleDocument)).not.toContain("graph2dShape");
    expect(JSON.stringify(sampleDocument)).not.toContain("complex_product_region_graph");
  });
});
