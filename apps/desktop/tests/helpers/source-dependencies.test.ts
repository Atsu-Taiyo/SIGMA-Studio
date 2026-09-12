import path from "node:path";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers, getSourceDependencies } from "./source-dependencies";

describe("source dependency inspection", () => {
  const resolveFrom = {
    sourceRoot: path.resolve("project/src"),
    sourceFile: path.resolve("project/src/features/rendering/core/model.ts"),
  };

  it.each([
    "@/components/editor/EditorShell",
    "../../../components/editor/EditorShell",
    "../../../components/editor/EditorShell.tsx",
    "@/features/rendering/../../components/editor/EditorShell.js",
    path.resolve("project/src/components/editor/EditorShell.tsx"),
  ])("resolves a forbidden local target consistently: %s", (specifier) => {
    const source = `
      import { value } from ${JSON.stringify(specifier)};
      export { value } from ${JSON.stringify(specifier)};
      const load = () => import(${JSON.stringify(specifier)});
    `;
    expect(getModuleSpecifiers(source, { resolveFrom })).toEqual(Array(3).fill("@/components/editor/EditorShell"));
  });

  it("resolves local entrypoints while retaining dependency kinds and type-only edges", () => {
    expect(getSourceDependencies(`
      import type { Document } from "../../document/index.js";
      export type * from "@/features/document/index.ts";
      const value = require("./index");
    `, resolveFrom)).toEqual([
      { kind: "import", specifier: "@/features/document", typeOnly: true },
      { kind: "export", specifier: "@/features/document", typeOnly: true },
      { kind: "require", specifier: "@/features/rendering/core", typeOnly: false },
    ]);
  });

  it("keeps external packages and escaping local dependencies distinct from allowed source roots", () => {
    expect(getModuleSpecifiers(`
      import "react/jsx-runtime";
      import "@tiptap/core";
      export * from "../../../../electron/main";
    `, { resolveFrom })).toEqual(["react/jsx-runtime", "@tiptap/core", "@/../electron/main"]);
  });

  it("does not cache a local target under the first importer's directory", () => {
    const source = 'import "./model";';
    expect(getModuleSpecifiers(source, { resolveFrom })).toEqual(["@/features/rendering/core/model"]);
    expect(getModuleSpecifiers(source, { resolveFrom: {
      ...resolveFrom,
      sourceFile: path.resolve("project/src/features/document/index.ts"),
    } })).toEqual(["@/features/document/model"]);
    expect(getModuleSpecifiers(source)).toEqual(["./model"]);
  });

  it("ignores dependency-looking prose, comments, regular expressions, and JSX text", () => {
    const source = `
      // import runtime from "comment";
      /* export * from "block-comment"; */
      const prose = 'from "string"';
      const pattern = /import\\("regexp"\\)/;
      const view = <span>from "jsx-text"</span>;
    `;
    expect(getModuleSpecifiers(source)).toEqual([]);
  });

  it.each([
    'import type { Value } from "model";',
    'import { type Value, type Other as Alias } from "model";',
    'import type * as Model from "model";',
    'export type { Value } from "model";',
    'export { type Value, type Other as Alias } from "model";',
    'export type * from "model";',
    'type Value = import("model").Value;',
    'type Value = typeof import("model");',
    'import type Model = require("model");',
  ])("recognizes a type-only edge: %s", (source) => {
    expect(getSourceDependencies(source)).toEqual([
      expect.objectContaining({ specifier: "model", typeOnly: true }),
    ]);
  });

  it.each([
    'import { Value } from "model";',
    'import { type Value, runtime as Alias } from "model";',
    'import Runtime, { type Value } from "model";',
    'import * as Runtime from "model";',
    'import "model";',
    'import {} from "model";',
    'export { type Value, runtime } from "model";',
    'export * from "model";',
    'export * as Runtime from "model";',
    'export {} from "model";',
    'import Runtime = require("model");',
    'const runtime = require("model");',
    'const runtime = import("model");',
    'const runtime = import(`model`);',
    'const runtime = import("model", { with: { type: "json" } });',
  ])("recognizes a runtime edge: %s", (source) => {
    expect(getSourceDependencies(source)).toEqual([
      expect.objectContaining({ specifier: "model", typeOnly: false }),
    ]);
  });

  it("finds deferred dependencies inside callbacks in source order", () => {
    expect(getModuleSpecifiers(`
      export { run } from "facade";
      function load() { return import("deferred"); }
      const lazy = () => require("required");
    `)).toEqual(["facade", "deferred", "required"]);
  });

  it.each([
    'const identity = <T>(value: T): T => value;',
    'const value = <Record<string, unknown>>{};',
  ])("finds a forbidden runtime edge after TypeScript-only syntax: %s", (prefix) => {
    const source = `${prefix}\nconst runtime = import("@/components/editor/EditorShell");`;
    const forbidden = getModuleSpecifiers(source).filter((specifier) => specifier.startsWith("@/components/"));

    expect(forbidden).toEqual(["@/components/editor/EditorShell"]);
  });

  it("finds dependencies inside a generic arrow and an angle assertion", () => {
    expect(getModuleSpecifiers(`
      const load = <T>() => import("generic-body");
      const value = <unknown>require("assertion-value");
    `)).toEqual(["generic-body", "assertion-value"]);
  });

  it("uses TSX syntax for dependencies in JSX expressions and after JSX elements", () => {
    expect(getModuleSpecifiers(`
      const view = <span>{import("jsx-expression")}</span>;
      const runtime = import("after-jsx");
    `)).toEqual(["jsx-expression", "after-jsx"]);
  });

  it.each([
    'const value = ; import("hidden-by-invalid-source");',
    'const view = <div>; import("hidden-by-invalid-source");',
  ])("refuses to approve a recovered syntax tree: %s", (source) => {
    expect(() => getModuleSpecifiers(source)).toThrow("Cannot parse source dependencies");
  });

  it.each(['import(moduleName)', 'import(`prefix/${moduleName}`)', 'require(moduleName)'])(
    "does not silently approve a dependency whose path cannot be inspected: %s",
    (source) => {
      expect(getSourceDependencies(source)[0]).toMatchObject({ specifier: null, typeOnly: false });
      expect(() => getModuleSpecifiers(source)).toThrow("Cannot verify a computed");
    },
  );

  it("can inspect known edges around an explicitly reviewed optional-module loader", () => {
    const source = 'import { run } from "known"; const load = (name: string) => import(name);';
    expect(getModuleSpecifiers(source, { allowComputed: true })).toEqual(["known"]);
    expect(getSourceDependencies(source)).toContainEqual({
      kind: "dynamic-import", specifier: null, typeOnly: false,
    });
  });
});
