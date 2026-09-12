import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers, getSourceDependencies } from "../tests/helpers/source-dependencies";

describe("proposal approval application boundary", () => {
  it("depends on store interfaces and document operations without loading Electron or persistence", () => {
    const source = readFileSync(new URL("./proposal-approval.ts", import.meta.url), "utf8");
    const dependencies = getSourceDependencies(source);
    expect(dependencies.filter((dependency) => !dependency.typeOnly).map((dependency) => dependency.specifier).sort()).toEqual([
      "./proposals/freshness",
      "./proposals/replay",
      "@/lib/ai/sigma-doc-edit-schema",
      "@/lib/sigma-doc-block-hash",
      "@/lib/sigma-doc-schema",
      "node:util",
    ]);
    const storeImports = dependencies.filter((dependency) => dependency.specifier?.includes("local-sigma-doc"));
    expect(storeImports).toHaveLength(2);
    expect(storeImports.every((dependency) => dependency.typeOnly)).toBe(true);
  });

  it("keeps approval replay and freshness ownership out of the Electron entry and storage IPC adapter", () => {
    for (const [fileName, coordinatorPath] of [["./main.ts", "./proposal-approval"], ["./ipc/storage.ts", "../proposal-approval"]]) {
      const source = readFileSync(new URL(fileName, import.meta.url), "utf8");
      const imports = getModuleSpecifiers(source);
      expect(imports, fileName).toContain(coordinatorPath);
      expect(imports, fileName).not.toContain("@/lib/ai/sigma-doc-edit-schema");
      expect(imports, fileName).not.toContain("@/lib/sigma-doc-block-hash");
    }
  });
});
