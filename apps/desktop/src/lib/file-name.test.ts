import { describe, expect, it } from "vitest";
import { normalizeNewFileName, splitFileName } from "./file-name";

describe("new file names", () => {
  it.each(["高校数学　高校3年 A-B組", "名前  2", "名前\u30002", "名前\u00a02"])("preserves internal spaces and hyphens in %s", name => {
    expect(normalizeNewFileName(` ${name} `)).toBe(name);
  });
  it.each(["name.sigma", "name.sigma.json", "name.sigmadoc.json", "name.SIGMADOC.JSON", "name.pdf", "name.png"])("preserves the extension of %s", name => {
    const parts = splitFileName(name);
    expect(parts.stem).toBe("name");
    expect(parts.stem + parts.extension).toBe(name);
  });
  it.each([".hidden", "name", "名前"])("keeps extensionless name %s", name => {
    expect(splitFileName(name)).toEqual({ stem: name, extension: "" });
  });
});
