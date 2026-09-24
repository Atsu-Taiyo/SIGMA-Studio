import path from "node:path";

import { build } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createBuildOptions } from "../scripts/build-options.mjs";

describe("Editor package boundary", () => {
  it("bundles the canonical desktop editor without Electron, Next.js runtimes", async () => {
    const result = await build({
      ...createBuildOptions(),
      logLevel: "silent",
      metafile: true,
      write: false,
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) =>
      input.replace(/\\/g, "/"),
    );
    const javascriptOutputs = result.outputFiles.filter((output) => output.path.endsWith(".js"));
    expect(javascriptOutputs.length).toBeGreaterThan(0);
    const bundledJavaScript = javascriptOutputs
      .map((output) => output.text)
      .join("\n");

    expect(inputs.some((input) => input.endsWith("/apps/desktop/src/components/editor/EditorShell.tsx"))).toBe(true);
    expect(inputs.some((input) => input.endsWith("/editor-shell/use-comment-actions.ts"))).toBe(true);
    expect(inputs.some((input) => input.includes("/node_modules/@tiptap/"))).toBe(true);
    expect(inputs.some((input) => input.endsWith("/apps/desktop/src/lib/tex-import.ts"))).toBe(true);
    expect(inputs.some((input) => input.endsWith("/apps/desktop/src/lib/tex-import/macros.ts"))).toBe(true);
    expect(inputs.some((input) => input.includes("/node_modules/next/"))).toBe(false);
    expect(inputs.some((input) => input.includes("/node_modules/electron/"))).toBe(false);
    expect(inputs.some((input) => input.includes("/apps/desktop/electron/"))).toBe(false);
    expect(inputs.some((input) => input.includes("/node_modules/@modelcontextprotocol/"))).toBe(false);
    expect(inputs.some((input) => input.includes("/features/ai-edit/"))).toBe(false);
    expect(inputs.filter(input => /\/(?:features\/collaboration|node_modules\/(?:yjs|y-protocols|@supabase))\//.test(input))).toEqual([]);
    const allowedWebMcpExecutionModules = [
      "ai-edit-attachment-names.ts",
      "ai-edit-reference.ts",
      "ai-overlay-placement.ts",
      "sigma-doc-agent-tools.ts",
      "sigma-doc-edit-schema.ts",
      "sigma-doc-search.ts",
      "svg-image.ts",
      "validation-locale.ts",
    ];
    const unexpectedAiModules = inputs.filter((input) =>
      input.includes("/lib/ai/")
      && !allowedWebMcpExecutionModules.some((fileName) => input.endsWith(`/lib/ai/${fileName}`)),
    );
    expect(unexpectedAiModules).toEqual([]);
    expect(inputs.some((input) => /\/components\/editor\/(?:Ai|ai-)/u.test(input))).toBe(false);
    expect(inputs.some((input) => input.endsWith("src/desktop-ai-disabled.tsx"))).toBe(true);
    expect(bundledJavaScript).not.toMatch(
      /from\s*["'](?:electron|next(?:\/|["']))|process\.env/u,
    );
  });

  it("generates public declarations without repository-internal source paths", () => {
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
    const program = ts.createProgram(
      parsedConfig.fileNames,
      parsedConfig.options,
    );
    const emitResult = program.emit(undefined, (fileName, source) => {
      if (fileName.endsWith(".d.ts")) declarations.push(source);
    });
    const errors = [
      ...ts.getPreEmitDiagnostics(program),
      ...emitResult.diagnostics,
    ]
      .filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      )
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );

    expect(errors).toEqual([]);
    expect(declarations.length).toBeGreaterThan(0);
    const publicDeclarations = declarations.join("\n");
    expect(publicDeclarations).not.toMatch(/apps\/desktop|from\s+["']@\//u);
    expect(publicDeclarations).not.toMatch(/from\s+["'](?:\.\.\/)+/u);
  });
});
