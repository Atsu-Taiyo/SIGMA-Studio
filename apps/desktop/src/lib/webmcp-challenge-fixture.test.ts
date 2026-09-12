import { describe, expect, it } from "vitest";

import challengeDocument from "../../public/demo/webmcp-challenge.sigmadoc.json";

import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";

describe("WebMCP Challenge demo fixture", () => {
  it("is a canonical SigmaDoc with body, math, shape, graph, and table targets", () => {
    const document = SigmaDocumentSchema.parse(challengeDocument);
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];

    expect(document.content.map((block) => block.id)).toEqual([
      "challenge_heading",
      "challenge_intro",
      "challenge_explanation",
      "challenge_task",
    ]);
    expect(shapes.map((shape) => shape.type)).toEqual(["geo", "graph2dShape", "tableShape"]);
  });
});
