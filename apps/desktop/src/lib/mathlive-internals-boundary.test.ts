import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = new URL("../", import.meta.url);

function sourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory));
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)
      ? [fileURLToPath(new URL(entry.name, directory))]
      : [];
  });
}

describe("MathLive internals", () => {
  // docs/architecture.md (Math Editor): only these adapters read MathLive's internal
  // `_mathfield.model`, and each is checked against the real MathLive
  // (`mathlive-script-navigation-real.test.ts`, `mathlive-open-fence.test.ts`,
  // `mathlive-vv-real.test.ts`).
  it("are read only by the designated adapters", () => {
    const root = fileURLToPath(SRC);
    const readers = sourceFiles(SRC)
      .filter((path) => readFileSync(path, "utf8").includes("_mathfield"))
      .map((path) => relative(root, path))
      .sort();
    expect(readers).toEqual([
      "lib/mathlive-open-fence.ts",
      "lib/mathlive-script-navigation.ts",
      "lib/mathlive-vv.ts",
    ]);
  });
});
