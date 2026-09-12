import { describe, expect, it } from "vitest";

import {
  composeSkillFile,
  parseSkillFile,
  parseSkillFrontmatter,
  skillSlugFromSourcePath,
} from "./skill-frontmatter";

describe("parseSkillFrontmatter", () => {
  it("reads single-line name and description", () => {
    const fields = parseSkillFrontmatter("---\nname: graph\ndescription: makes graphs\n---\n\nbody\n");
    expect(fields).toEqual({ name: "graph", description: "makes graphs" });
  });

  it("returns empty for missing or unterminated frontmatter", () => {
    expect(parseSkillFrontmatter("# just markdown\n")).toEqual({});
    expect(parseSkillFrontmatter("---\nname: x\nnever closed\n")).toEqual({});
  });

  it("reads a folded block-scalar description", () => {
    const fields = parseSkillFrontmatter("---\nname: x\ndescription: >-\n  folded\n  description\n---\n");
    expect(fields.name).toBe("x");
    expect(fields.description).toBe("folded description");
  });

  it("unquotes JSON-escaped double-quoted values exactly", () => {
    const fields = parseSkillFrontmatter('---\nname: x\ndescription: "say \\"hi\\": now"\n---\n');
    expect(fields.description).toBe('say "hi": now');
  });

  it("strips simple single quotes", () => {
    const fields = parseSkillFrontmatter("---\nname: 'quoted'\ndescription: 'desc'\n---\n");
    expect(fields).toEqual({ name: "quoted", description: "desc" });
  });
});

describe("parseSkillFile / composeSkillFile round-trip", () => {
  it("splits body and rewrites name/description while preserving other keys", () => {
    const raw = [
      "---",
      "name: graph",
      "description: old",
      "license: MIT",
      "allowed-tools: Bash",
      "---",
      "",
      "# Graph",
      "",
      "body text",
    ].join("\n");

    const parsed = parseSkillFile(raw);
    expect(parsed.name).toBe("graph");
    expect(parsed.description).toBe("old");
    expect(parsed.body).toBe("# Graph\n\nbody text");
    expect(parsed.extraFrontmatterLines).toEqual(["license: MIT", "allowed-tools: Bash"]);

    const composed = composeSkillFile({
      name: "graph",
      description: "new desc",
      body: parsed.body,
      extraFrontmatterLines: parsed.extraFrontmatterLines,
    });
    expect(composed).toBe([
      "---",
      "name: graph",
      'description: "new desc"',
      "license: MIT",
      "allowed-tools: Bash",
      "---",
      "",
      "# Graph",
      "",
      "body text",
    ].join("\n"));
  });

  it("escapes YAML-breaking descriptions (colon-space, quotes, newlines)", () => {
    const composed = composeSkillFile({
      name: "layout",
      description: '図の配色: 白黒。"引用"も\n改行も',
      body: "body",
    });
    expect(composed).toContain('description: "図の配色: 白黒。\\"引用\\"も 改行も"');
    // round-trip
    expect(parseSkillFrontmatter(composed).description).toBe('図の配色: 白黒。"引用"も 改行も');
  });

  it("reads a block-scalar description while excluding its source lines from extra frontmatter", () => {
    const raw = [
      "---",
      "name: x",
      "description: >",
      "  a folded",
      "  description",
      "keep: me",
      "---",
      "body",
    ].join("\n");

    const parsed = parseSkillFile(raw);
    expect(parsed.description).toBe("a folded description");
    expect(parsed.extraFrontmatterLines).toEqual(["keep: me"]);
    expect(parsed.body).toBe("body");
  });

  it("treats a file without frontmatter as body-only", () => {
    const parsed = parseSkillFile("# markdown only\n");
    expect(parsed.body).toBe("# markdown only\n");
    expect(parsed.extraFrontmatterLines).toEqual([]);
    expect(parsed.name).toBeUndefined();
  });
});

describe("skillSlugFromSourcePath", () => {
  it("extracts the slug from a manifest sourcePath", () => {
    expect(skillSlugFromSourcePath("skills/graph-helper/SKILL.md")).toBe("graph-helper");
  });

  it("returns null for non-skill paths", () => {
    expect(skillSlugFromSourcePath("instructions/global.md")).toBeNull();
    expect(skillSlugFromSourcePath("skills/nested/dir/SKILL.md")).toBeNull();
  });
});
