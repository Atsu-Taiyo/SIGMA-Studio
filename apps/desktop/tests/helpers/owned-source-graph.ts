import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { getModuleSpecifiers } from "./source-dependencies";

/** Follow an entry's actual local dependencies within its implementation directory. */
export function readOwnedSourceGraph(entryFile: string, ownedDirectory: string, sourceRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [resolve(entryFile)];
  const ownedRoot = resolve(ownedDirectory);
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    const source = readFileSync(file, "utf8");
    files.set(file, source);
    for (const specifier of getModuleSpecifiers(source)) {
      const target = specifier.startsWith("@/")
        ? resolve(sourceRoot, specifier.slice(2))
        : specifier.startsWith(".") ? resolve(dirname(file), specifier) : null;
      if (!target) continue;
      const local = relative(ownedRoot, target);
      if (local === ".." || local.startsWith(`..${sep}`)) continue;
      const resolved = [target, `${target}.ts`, `${target}.tsx`, resolve(target, "index.ts"), resolve(target, "index.tsx")]
        .find((candidate) => /\.[cm]?[jt]sx?$/u.test(candidate) && existsSync(candidate));
      if (resolved) pending.push(resolved);
    }
  }
  return files;
}
