import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getSourceDependencies } from "../../tests/helpers/source-dependencies";
const sourceRoot = path.resolve(import.meta.dirname, "../../src");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory,entry.name)) : /\.[jt]sx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path.join(directory,entry.name)] : []);
}
describe("optional collaboration dependency boundary", () => {
  it("keeps pure document and rendering models independent of sync and desktop adapters", () => {
    const violations: string[] = [];
    for (const folder of ["features/document", "features/rendering/core", "features/text-editing"]) {
      for (const file of files(path.join(sourceRoot, folder))) {
        for (const edge of getSourceDependencies(readFileSync(file,"utf8"), { sourceRoot, sourceFile:file })) {
          if (edge.specifier && /^(?:yjs|y-protocols|@cloudflare|@supabase|electron)(?:\/|$)|^@\/features\/collaboration(?:\/|$)/.test(edge.specifier)) violations.push(`${path.relative(sourceRoot,file)} -> ${edge.specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
