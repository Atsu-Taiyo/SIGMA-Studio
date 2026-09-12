import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkPublicTypeConsumer } from "../../test-support/public-type-consumer";

const consumer = `
import {
  importTexDocument,
  importTexProblem,
  type TexProblemInput,
  SigmaDocEditor,
  SigmaDocViewer,
  parseSigmaDocument,
  type SigmaDocument,
  type SigmaDocEditorProps,
  type SigmaDocEditorHandle,
  type OverlayShape,
  type Graph3DSpec,
  type Graph2DSpec,
  type GraphParameter,
  type Graph3DParameter,
} from "@sigma-studio/editor";

const parameter: GraphParameter = { id: "s", name: "s", value: 1, min: -2, max: 2,
  animation: { durationMs: 1000, loop: "pingPong", playOnPage: true } };
const legacy3dParameter: Graph3DParameter = parameter;
declare const graph2d: Graph2DSpec;
graph2d.parameters = [legacy3dParameter];
// @ts-expect-error parameter values must remain numeric through generated exports
const invalidParameter: GraphParameter = { ...parameter, value: "1" };

const texDocument: SigmaDocument = importTexDocument("$x$", "problem.tex");
const problemInput: TexProblemInput = { title: "Problem", prompt: "$x$", solution: "$1$", tags: ["algebra"] };
const texProblem: SigmaDocument = importTexProblem(problemInput);
// @ts-expect-error a problem requires a prompt
importTexProblem({ title: "Missing prompt" });
// @ts-expect-error TeX is text, not an arbitrary object
importTexDocument({ text: "$x$" });

const document: SigmaDocument = parseSigmaDocument({});
const props: SigmaDocEditorProps = {
  document,
  onChange(next, change) {
    const id: string = next.docId;
    const source: "desktop-editor" | "reset" = change.source;
    // @ts-expect-error document ids must not become any through re-exports
    const invalidId: number = next.docId;
  },
};
SigmaDocEditor(props);
SigmaDocViewer({ document });
declare const handle: SigmaDocEditorHandle;
const current: SigmaDocument = handle.getDocument();
handle.reset(current);

// @ts-expect-error invalid documents cannot cross the public reset boundary
handle.reset({ docId: 123 });
// @ts-expect-error canonical overlay shape fields are required
const invalidShape: OverlayShape = {};
// @ts-expect-error canonical graph fields are required
const invalidGraph: Graph3DSpec = {};
`;

describe("Editor public type consumers", () => {
  it.each(["Bundler", "NodeNext"] as const)("retains the complete public API with %s resolution", (resolution) => {
    expect(checkPublicTypeConsumer(path.resolve(import.meta.dirname, ".."), consumer, resolution)).toEqual([]);
  });
});
