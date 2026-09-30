import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { validateAiSvg } from "@/lib/ai/svg-image";
import { parseSkillFile, SKILL_CONTENT_MAX_LENGTH } from "@/lib/ai/skill-frontmatter";
import { MCP_TOOL_CATEGORY_MAP } from "@/lib/ai/mcp-tool-categories";
import { APP_BODY_TOOL_ROUTES } from "@/lib/ai/mcp-tool-profile";

import { OFFICIAL_SKILL_DEFINITIONS } from "./ai-resource-store";

const SKILLS_ROOT = path.join(__dirname, "official-skills");

/** 現在のアプリ内AI(app profile)が使えるツール名。本文編集の8入口は4入口へ置き換わる。 */
const LEGACY_BODY_TOOL_NAMES = Object.keys(APP_BODY_TOOL_ROUTES);
const APP_BODY_TOOL_NAMES = Object.values(APP_BODY_TOOL_ROUTES).map((route) => route.name);
const KNOWN_TOOL_NAMES = new Set<string>([
  ...Object.values(MCP_TOOL_CATEGORY_MAP).flat().filter((name) => !LEGACY_BODY_TOOL_NAMES.includes(name)),
  ...APP_BODY_TOOL_NAMES,
]);
/** ツール名ではないが、snake_case に見える語（操作名・返値の項目・例に使うID）。 */
const COMMON_SNAKE_WORDS = new Set([
  "expected_revision", "file_id", "run_id", "target_id", "write_mode",
  "replace_text", "format_inline", "replace_structure", "has_solution",
]);
const EXAMPLE_ID_PATTERN = /^ai_/;

async function readSkill(bundledPath: string): Promise<string> {
  return fs.readFile(path.join(SKILLS_ROOT, bundledPath), "utf8");
}

function fencedBlocks(content: string, language: string): string[] {
  return [...content.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1]!);
}

describe("official skills", () => {
  it("bundles exactly the skills the app defines, one directory each", async () => {
    const directories = (await fs.readdir(SKILLS_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const defined = OFFICIAL_SKILL_DEFINITIONS.map((definition) => path.dirname(definition.bundledPath)).sort();

    expect(defined).toEqual(directories);
    expect(new Set(OFFICIAL_SKILL_DEFINITIONS.map((definition) => definition.id)).size)
      .toBe(OFFICIAL_SKILL_DEFINITIONS.length);
  });

  for (const definition of OFFICIAL_SKILL_DEFINITIONS) {
    describe(definition.id, () => {
      it("has frontmatter that agrees with the definition and fits the editor limit", async () => {
        const raw = await readSkill(definition.bundledPath);
        const parsed = parseSkillFile(raw);
        const directory = path.dirname(definition.bundledPath);

        expect(parsed.name).toBe(directory);
        expect(definition.sourcePath).toBe(`skills/${directory}/SKILL.md`);
        expect(parsed.description).toBe(definition.description);
        expect(raw.length).toBeLessThanOrEqual(SKILL_CONTENT_MAX_LENGTH);
      });

      it("names only tools that the in-app agent can call", async () => {
        const raw = await readSkill(definition.bundledPath);
        const toolLikeTokens = [...new Set([...raw.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)].map((match) => match[0]))];
        const unknown = toolLikeTokens.filter((name) =>
          !KNOWN_TOOL_NAMES.has(name) && !COMMON_SNAKE_WORDS.has(name) && !EXAMPLE_ID_PATTERN.test(name));
        const legacy = toolLikeTokens.filter((name) => LEGACY_BODY_TOOL_NAMES.includes(name));

        expect(unknown, "unknown tool-like names").toEqual([]);
        expect(legacy, "body tools replaced by insert_content / edit_text / edit_problem / organize_blocks").toEqual([]);
      });

      it("ships only SVG and JSON examples that the tools accept", async () => {
        const raw = await readSkill(definition.bundledPath);

        for (const svg of fencedBlocks(raw, "svg")) {
          expect(() => validateAiSvg(svg.trim())).not.toThrow();
        }
        for (const json of fencedBlocks(raw, "json")) {
          expect(() => JSON.parse(json)).not.toThrow();
        }
      });
    });
  }

  it("keeps SVG as the first choice for figures and illustrations", async () => {
    const svg = await readSkill("sigma-svg-figure/SKILL.md");
    const shapes = await readSkill("sigma-shape-editing/SKILL.md");
    const image = await readSkill("sigma-image-material-reconstruction/SKILL.md");

    expect(svg).toContain("insert_svg_image");
    expect(svg).toContain("update_svg_image");
    expect(fencedBlocks(svg, "svg").length).toBeGreaterThanOrEqual(2);
    // 個別編集は頼まれたときだけ。それ以外の図はSVGへ回す。
    expect(shapes).toContain("insert_svg_image");
    expect(image).toContain("insert_svg_image");
  });
});
