import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers } from "../../../tests/helpers/source-dependencies";

const extensionModules = [
  "sigma-doc-text-attributes.ts",
  "sigma-doc-text-identity.ts",
  "sigma-doc-container-extensions.ts",
  "nested-problem-extension.ts",
  "node-queries.ts",
];

describe("SigmaDoc Tiptap extension boundaries", () => {
  it.each(extensionModules)("keeps %s independent from React and editor composition", (fileName) => {
    const source = readFileSync(new URL(fileName, import.meta.url), "utf8");
    const forbidden = getModuleSpecifiers(source).filter((specifier) => (
      /^(?:react|react-dom)(?:\/|$)/.test(specifier)
      || specifier === "@tiptap/react"
      || /(?:^|\/)editor\//.test(specifier)
      || specifier.includes("/features/ai-edit")
      || specifier.includes("/lib/ai/")
      || specifier.includes("/electron/")
    ));

    expect(forbidden).toEqual([]);
  });

  it("allows Tiptap tests to use the schema without importing the React controller", () => {
    const directory = new URL(".", import.meta.url);
    const tests = readdirSync(directory).filter((fileName) => /\.test\.tsx?$/.test(fileName));
    const controllerImports = tests.flatMap((fileName) => (
      getModuleSpecifiers(readFileSync(new URL(fileName, directory), "utf8"))
        .filter((specifier) => specifier.includes("TextFlowEditor"))
        .map((specifier) => ({ fileName, specifier }))
    ));

    expect(controllerImports).toEqual([]);
  });
});
