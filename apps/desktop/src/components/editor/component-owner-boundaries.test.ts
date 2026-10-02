import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers } from "../../../tests/helpers/source-dependencies";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file)
      : /\.tsx?$/u.test(file) && !/\.(?:test|spec)\.tsx?$/u.test(file) ? [file] : [];
  });
}

/** Extracted owners depend on contracts/models, never back on their composition entry. */
describe("editor component ownership boundaries", () => {
  it.each([
    ["components/editor/editor-shell", "@/components/editor/EditorShell"],
    ["components/editor/overlay-canvas", "@/components/editor/OverlayCanvasEditorClient"],
    ["components/editor/page-canvas", "@/components/editor/PageCanvasEditor"],
    ["features/ai-edit/application", "@/components/editor/AiEditPanel"],
    ["features/ai-edit/view", "@/components/editor/AiEditPanel"],
  ])("keeps %s independent of its parent", (directory, parent) => {
    const violations = sourceFiles(join(sourceRoot, directory)).flatMap((file) => {
      const dependencies = getModuleSpecifiers(readFileSync(file, "utf8"), {
        resolveFrom: { sourceFile: file, sourceRoot },
      });
      return dependencies.filter((specifier) => specifier === parent)
        .map((specifier) => `${file}: ${specifier}`);
    });
    expect(violations).toEqual([]);
  });
});
