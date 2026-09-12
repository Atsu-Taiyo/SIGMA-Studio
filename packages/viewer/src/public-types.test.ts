import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkPublicTypeConsumer } from "../../test-support/public-type-consumer";

const consumer = `
import {
  SigmaDocViewer,
  parseSigmaDocument,
  type SigmaDocument,
  type SigmaDocViewerProps,
  type SigmaDocViewerPart,
  type OverlayShape,
  type Graph3DSpec,
  type Graph2DSpec,
  type GraphParameter,
  type Graph3DParameter,
} from "@sigma-studio/viewer";

const parameter: GraphParameter = { id: "s", name: "s", value: 1, min: -2, max: 2,
  animation: { durationMs: 1000, loop: "pingPong", playOnPage: true } };
const legacy3dParameter: Graph3DParameter = parameter;
declare const graph2d: Graph2DSpec;
graph2d.parameters = [legacy3dParameter];
// @ts-expect-error parameter values must remain numeric through generated exports
const invalidParameter: GraphParameter = { ...parameter, value: "1" };

const document: SigmaDocument = parseSigmaDocument({});
const part: SigmaDocViewerPart = "solution";
const props: SigmaDocViewerProps = { document, visibleParts: [part] };
SigmaDocViewer(props);
const id: string = props.document.docId;

// These checks also reject declarations that silently resolve to any.
// @ts-expect-error document ids are strings
const invalidId: number = document.docId;
// @ts-expect-error viewer parts are constrained to the public union
const invalidPart: SigmaDocViewerPart = "not-a-part";
// @ts-expect-error canonical overlay shape fields are required
const invalidShape: OverlayShape = {};
// @ts-expect-error canonical graph fields are required
const invalidGraph: Graph3DSpec = {};
`;

describe("Viewer public type consumers", () => {
  it.each(["Bundler", "NodeNext"] as const)("retains the complete public API with %s resolution", (resolution) => {
    expect(checkPublicTypeConsumer(path.resolve(import.meta.dirname, ".."), consumer, resolution)).toEqual([]);
  });
});
