import { expect, it } from "vitest";
import { importTexProblem } from "./tex-import";
import { parseSigmaDocument } from "./sigma-doc-schema";
import { facetKeyParts, withoutSolutions } from "./problem-library-provider";

it("drops solutions from every problem, including ones inside boxes, and keeps the rest", () => {
  const source = parseSigmaDocument(importTexProblem({ title: "t", prompt: "$x$を求めよ。", solution: "$x=1$" }));
  const problem = source.content[0];
  if (problem.type !== "problem") throw new Error("fixture");
  const boxed = parseSigmaDocument({ ...source, content: [problem, { type: "boxBlock", id: "box_1", styleId: "fancybox", blocks: [{ ...problem, id: "inner" }] }] });
  const stripped = withoutSolutions(boxed);
  expect(stripped.content[0]).toMatchObject({ type: "problem", prompt: problem.prompt, solution: [] });
  expect(stripped.content[1]).toMatchObject({ type: "boxBlock", blocks: [{ id: "inner", solution: [], prompt: problem.prompt }] });
  expect(() => parseSigmaDocument(stripped)).not.toThrow();
  // The input is not mutated.
  expect(problem.solution.length).toBeGreaterThan(0);
});

it("splits a facet key into its group, type and path", () => {
  expect(facetKeyParts("db|大学|私立>関西学院大")).toEqual({ group: "db", type: "大学", path: ["私立", "関西学院大"] });
});
