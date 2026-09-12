import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Expand editor feature styles while keeping the document/palette import boundaries visible. */
export function readStylesheet(file: string | URL, encoding: "utf8"): string {
  const filename = file instanceof URL ? fileURLToPath(file) : file;
  const source = readFileSync(filename, encoding);
  return source.replace(/@import "(\.\/styles\/[^\"]+)";/g, (_match, relative: string) =>
    readStylesheet(path.resolve(path.dirname(filename), relative), encoding));
}
