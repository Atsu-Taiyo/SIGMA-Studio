import path from "node:path";

import { build } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createBuildOptions } from "../scripts/build-options.mjs";

const FORBIDDEN_BUNDLE_INPUTS = [
  { label: "Tiptap", pattern: /(?:^|\/)node_modules\/@tiptap\//u },
  { label: "ProseMirror", pattern: /(?:^|\/)node_modules\/prosemirror-/u },
  { label: "Next.js", pattern: /(?:^|\/)node_modules\/next\//u },
  { label: "Electron", pattern: /(?:^|\/)(?:node_modules\/electron|apps\/desktop\/electron)(?:\/|$)/u },
  { label: "MCP", pattern: /(?:^|\/)node_modules\/@modelcontextprotocol\//u },
  { label: "AI implementation", pattern: /(?:^|\/)apps\/desktop\/src\/(?:lib\/ai|components\/ai)(?:\/|$)/u },
];

describe("viewer package boundary", () => {
  it("keeps editor, AI, framework, and persistence runtimes out of the browser bundle", async () => {
    const result = await build({
      ...createBuildOptions(),
      logLevel: "silent",
      metafile: true,
      write: false,
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) => input.replace(/\\/g, "/"));
    const violations = FORBIDDEN_BUNDLE_INPUTS.flatMap(({ label, pattern }) =>
      inputs.filter((input) => pattern.test(input)).map((input) => `${label}: ${input}`),
    );

    expect(violations).toEqual([]);
    const javascriptOutputs = result.outputFiles.filter((output) => output.path.endsWith(".js"));
    expect(javascriptOutputs.length).toBeGreaterThan(0);
    const bundledJavaScript = javascriptOutputs.map((output) => output.text).join("\n");
    expect(bundledJavaScript).not.toMatch(/apps\/desktop|desktopAPI|contenteditable=["']?true|@tiptap|prosemirror|electron|modelcontextprotocol|process\.env/u);
  });

  it("generates public declarations without desktop source paths", () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const configPath = path.join(packageRoot, "tsconfig.build.json");
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(configFile.error).toBeUndefined();

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      packageRoot,
      { declarationMap: false },
      configPath,
    );
    const declarations: string[] = [];
    const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
    const emitResult = program.emit(undefined, (fileName, source) => {
      if (fileName.endsWith(".d.ts")) declarations.push(source);
    });
    const errors = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics]
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

    expect(errors).toEqual([]);
    expect(declarations.length).toBeGreaterThan(0);
    const publicDeclarations = declarations.join("\n");
    expect(publicDeclarations).not.toMatch(/apps\/desktop|from\s+["']@\//u);
    expect(publicDeclarations).not.toMatch(/from\s+["'](?:\.\.\/)+/u);
  });
});
