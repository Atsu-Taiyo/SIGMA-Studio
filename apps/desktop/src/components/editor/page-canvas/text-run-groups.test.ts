import { describe, expect, it } from "vitest";

import { assignTextRunGroupIds } from "./text-run-groups";
import type { RenderUnit } from "./types";

function textFlow(id: string): RenderUnit {
  return { type: "textFlow", id, blocks: [] };
}

function problemArea(id: string): RenderUnit {
  return {
    type: "problemArea",
    id,
    blocks: [],
    area: "prompt",
    isFirstProblemArea: true,
    isLastProblemArea: true,
    isFirstProblemFrameArea: true,
    isLastProblemFrameArea: true,
    problem: {
      type: "problem",
      id: "problem",
      lead: [],
      prompt: [],
      hints: [],
      solution: [],
      tags: [],
    },
  } as unknown as RenderUnit;
}

describe("assignTextRunGroupIds", () => {
  it("bundles all text-flow editors into one document-ordered group", () => {
    const assignments = assignTextRunGroupIds([
      textFlow("a"),
      textFlow("b"),
      textFlow("c"),
    ]);

    expect(assignments.get("a")).toEqual({ groupId: "a", order: 0 });
    expect(assignments.get("b")).toEqual({ groupId: "a", order: 1 });
    expect(assignments.get("c")).toEqual({ groupId: "a", order: 2 });
  });

  it("keeps the run continuous through problem areas", () => {
    const assignments = assignTextRunGroupIds([
      textFlow("a"),
      textFlow("b"),
      problemArea("q"),
      textFlow("c"),
      textFlow("d"),
    ]);

    expect(assignments.get("a")).toEqual({ groupId: "a", order: 0 });
    expect(assignments.get("b")).toEqual({ groupId: "a", order: 1 });
    expect(assignments.get("q")).toEqual({ groupId: "a", order: 2 });
    expect(assignments.get("c")).toEqual({ groupId: "a", order: 3 });
    expect(assignments.get("d")).toEqual({ groupId: "a", order: 4 });
  });

  it("uses a problem area as the group root when it is the only text run", () => {
    expect(assignTextRunGroupIds([problemArea("q")]).get("q")).toEqual({ groupId: "q", order: 0 });
  });
});
