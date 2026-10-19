import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { isValidOverlaySnapshot, type OverlayShape, type OverlaySnapshot } from "@/features/document";
import { validateAiSvg } from "@/lib/ai/svg-image";
import { parseSkillFile, SKILL_CONTENT_MAX_LENGTH } from "@/lib/ai/skill-frontmatter";
import { convertSvgImageToSigma } from "@/lib/svg-to-sigma";

import { BODY_IMPLEMENTATION_ROUTES } from "../mcp/sigma-doc-mcp-app-tools";
import { createSigmaDocMcpServer } from "../mcp/sigma-doc-mcp-server-core";
import { OFFICIAL_SKILL_DEFINITIONS } from "./ai-resource-store";

const SKILLS_ROOT = path.join(__dirname, "official-skills");

/** 本文編集の4入口の内部実装の名前。公開されないので、スキルに書くとモデルが呼べない。 */
const BODY_IMPLEMENTATION_NAMES = Object.keys(BODY_IMPLEMENTATION_ROUTES);
/** アプリ内AIが呼べるツール名。実際のMCPサーバーの tools/list から読む。 */
const KNOWN_TOOL_NAMES = new Set<string>();

beforeAll(async () => {
  const server = createSigmaDocMcpServer();
  const client = new Client({ name: "official-skills-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    for (const tool of (await client.listTools()).tools) {
      KNOWN_TOOL_NAMES.add(tool.name);
    }
  } finally {
    await client.close();
  }
});
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

/**
 * 画面の「図形に変換」と同じ変換器に、insert_svg_image が入れるのと同じ画像を渡す
 * (`w` を省略した挿入と同じく、表示サイズは viewBox の大きさ = 1単位1px)。
 * 文字の幅の測定は画面の DOM が要るので、ここでは変換器の見積もりを使う。分解されるかどうかは測定に依らない。
 */
function convertLikeTheEditor(svg: string) {
  const { width, height } = validateAiSvg(svg.trim());
  const snapshot: OverlaySnapshot = {
    version: 1,
    shapes: [{ id: "figure", type: "image", x: 40, y: 60, props: { assetId: "figure_asset", w: width, h: height } }],
    assets: { figure_asset: { id: "figure_asset", type: "image", props: { w: width, h: height, name: "図", mimeType: "image/svg+xml",
      isAnimated: false, src: `data:image/svg+xml,${encodeURIComponent(svg.trim())}`, fileSize: svg.length } } },
  };
  return convertSvgImageToSigma(snapshot, "figure");
}

function figure(body: string, defs = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}

const TRIANGLE_HEAD = (fill = "#111111") =>
  `<marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${fill}"/></marker>`;

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
        const internal = toolLikeTokens.filter((name) => BODY_IMPLEMENTATION_NAMES.includes(name));

        expect(unknown, "unknown tool-like names").toEqual([]);
        expect(internal, "internal body-edit names; use insert_content / edit_text / edit_problem / organize_blocks").toEqual([]);
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
    // 部品ごとに編集したい図もSVGで描き、画面の「図形に変換」で分解する。insert_shapeで作り直さない。
    expect(shapes).toContain("insert_svg_image");
    expect(image).toContain("insert_svg_image");
    for (const skill of [svg, shapes, image]) {
      expect(skill).toContain("「図形に変換」");
    }
    expect(image).toContain("SVGで描いてから分解する");
    expect(svg).toContain("## 変換しやすい書き方");
    expect(svg).toContain("## 変換した後の直し方");
    // 部品ごとに編集したい図は convert_svg_image で分解する。AIの変換は極細を細に切り上げる。
    expect(svg).toContain("`convert_svg_image`");
    expect(svg).toContain("極細を細(1.25)に切り上げる");
    expect(image).toContain("`convert_svg_image`");
    expect(shapes).toContain("`convert_svg_image`");
    expect(svg).not.toContain("図形として作り直せる");
    expect(shapes).not.toContain("`insert_shape` を部品の数だけ");
  });

  it("ships SVG figure examples that \"Convert to shapes\" splits completely", async () => {
    const svg = await readSkill("sigma-svg-figure/SKILL.md");
    const shapes: OverlayShape[] = [];
    for (const example of fencedBlocks(svg, "svg")) {
      const result = convertLikeTheEditor(example);
      // 例に、分解されずにSVG画像のまま残る部分があってはいけない。
      expect(result.preservedCount, example).toBe(0);
      expect(isValidOverlaySnapshot(result.snapshot)).toBe(true);
      shapes.push(...result.snapshot.shapes);
    }
    const lines = shapes.flatMap((shape) => shape.type === "line" ? [shape] : []);
    const texts = shapes.flatMap((shape) => shape.type === "text" ? [shape] : []);
    // 例は、規約に書いた形を一通り見せる: Q曲線の弧、三角とV字の矢じり、破線、文字と数式、図形。
    expect(lines.some((line) => line.props.kind === "curve" && line.props.points.length === 3)).toBe(true);
    expect(lines.some((line) => line.props.arrowheadEnd?.startsWith("triangle"))).toBe(true);
    expect(lines.some((line) => ["thinArrow", "arrow", "openArrow"].some((head) => line.props.arrowheadEnd?.startsWith(head)))).toBe(true);
    expect(lines.some((line) => line.props.dash === "dashed")).toBe(true);
    expect(shapes.some((shape) => shape.type === "geo" && shape.props.geo === "triangle")).toBe(true);
    expect(shapes.some((shape) => shape.type === "geo" && shape.props.geo === "rectangle" && shape.rotation !== 0)).toBe(true);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((text) => text.props.blocks.some((block) => block.type === "paragraph"
      && block.children.some((child) => child.type === "mathInline" && child.tex.includes("\\theta"))))).toBe(true);
    // 線の太さは区分の値で書いたので、そのまま主線=中・補助線=細になる。
    const sizes = new Set(shapes.flatMap((shape) => shape.type === "line" || shape.type === "geo" ? [shape.props.size] : []));
    expect([...sizes].sort()).toEqual(["m", "s"]);
  });

  it("states the conversion rules the converter actually has", async () => {
    const svg = await readSkill("sigma-svg-figure/SKILL.md");
    const converts = (source: string) => convertLikeTheEditor(source).preservedCount === 0;

    // 書けば分解される形。
    expect(converts(figure('<path d="M60,100 Q60,89.3 54.6,80" fill="none" stroke="#111111" stroke-width="1.25"/>'))).toBe(true);
    expect(converts(figure('<line x1="20" y1="60" x2="180" y2="60" stroke="#111111" stroke-width="2" marker-end="url(#head)"/>', TRIANGLE_HEAD()))).toBe(true);
    expect(converts(figure('<line x1="20" y1="60" x2="180" y2="60" stroke="#111111" stroke-width="2" marker-start="url(#head)"/>',
      TRIANGLE_HEAD().replace('orient="auto"', 'orient="auto-start-reverse"')))).toBe(true);
    // 両端の矢印は auto-start-reverse の marker 1つを両方に付ける。
    expect(converts(figure('<line x1="20" y1="60" x2="180" y2="60" stroke="#111111" stroke-width="2" marker-start="url(#head)" marker-end="url(#head)"/>',
      TRIANGLE_HEAD().replace('orient="auto"', 'orient="auto-start-reverse"')))).toBe(true);
    expect(converts(figure('<g font-size="15" fill="#111111"><text x="20" y="40">ラベル</text></g><g stroke="#111111"><line x1="20" y1="60" x2="180" y2="60"/></g>'))).toBe(true);
    expect(svg).toContain("`orient=\"auto-start-reverse\"`");

    // スキルが「分解されない」と書く形は、実際に SVG のまま残る。変換器が対応したら、スキルの規約も書き換える。
    const leftAsSvg: [string, string][] = [
      ["円弧 `A`", figure('<path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="#111111"/>')],
      ["3次ベジェ（`C` `S`）", figure('<path d="M20,100 C60,20 140,20 180,100" fill="none" stroke="#111111"/>')],
      ["Q の連続", figure('<path d="M20,100 Q60,20 100,100 Q140,180 180,100" fill="none" stroke="#111111"/>')],
      ["曲線と直線の混在", figure('<path d="M20,100 L40,100 Q100,20 180,100" fill="none" stroke="#111111"/>')],
      ["曲線を `Z` で閉じたもの", figure('<path d="M20,100 Q100,20 180,100 Z" fill="none" stroke="#111111"/>')],
      ["`fill=\"none\"` を付ける", figure('<polyline points="20,100 100,20 180,100" stroke="#111111"/>')],
      ["`marker-mid`", figure('<polyline points="20,100 100,20 180,100" fill="none" stroke="#111111" marker-mid="url(#head)" marker-end="url(#head)"/>', TRIANGLE_HEAD())],
      ["`orient=\"auto\"` のまま始点に付けると", figure('<line x1="20" y1="60" x2="180" y2="60" stroke="#111111" marker-start="url(#head)" marker-end="url(#head)"/>', TRIANGLE_HEAD())],
      ["色違い", figure('<line x1="20" y1="60" x2="180" y2="60" stroke="#111111" marker-end="url(#head)"/>', TRIANGLE_HEAD("#ff0000"))],
      ["要素が2つ以上の marker", figure('<line x1="20" y1="60" x2="180" y2="60" stroke="#111111" marker-end="url(#head)"/>',
        TRIANGLE_HEAD().replace("</marker>", '<circle cx="5" cy="5" r="1" fill="#111111"/></marker>'))],
      ["`dominant-baseline`", figure('<text x="20" y="40" fill="#111111" dominant-baseline="middle">ラベル</text>')],
      ["**文字を stroke の付いた `g` に入れない**", figure('<g stroke="#111111"><text x="20" y="40" fill="#111111">ラベル</text></g>')],
      ["`tspan` には `x` `y` `dx` `text-anchor` を付けない", figure('<text x="20" y="40" fill="#111111">一行目<tspan x="20" dy="18">二行目</tspan></text>')],
      ["グラデーション", figure('<rect x="20" y="20" width="160" height="80" fill="url(#shade)"/>',
        '<linearGradient id="shade"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#111111"/></linearGradient>')],
    ];
    for (const [rule, source] of leftAsSvg) {
      expect(svg, rule).toContain(rule);
      expect(() => validateAiSvg(source), rule).not.toThrow();
      // 分解される円を隣に置くと、その部分だけが SVG のまま残るのが見える。
      const withCircle = source.replace("</svg>", '<circle cx="100" cy="60" r="10" fill="none" stroke="#111111"/></svg>');
      expect(convertLikeTheEditor(withCircle), rule).toMatchObject({ convertedCount: 1 });
      expect(convertLikeTheEditor(withCircle).preservedCount, rule).toBeGreaterThan(0);
    }

    // 線の太さの区分と、破線・点線の分かれ目。
    const strokeSize = (width: string, dash = "") => {
      // 1つだけの部品は、グループにならずに元の画像のIDを引き継ぐ。
      const [line] = convertLikeTheEditor(figure(`<line x1="20" y1="60" x2="180" y2="60" stroke="#111111" stroke-width="${width}"${dash}/>`)).snapshot.shapes;
      return line?.type === "line" ? [line.props.size, line.props.dash] : [];
    };
    expect(svg).toContain("極細0.75・細1.25・中2・太3・極太5px");
    expect(["0.75", "1.25", "2", "3", "5"].map((width) => strokeSize(width)[0])).toEqual(["xs", "s", "m", "l", "xl"]);
    expect(strokeSize("1.25", ' stroke-dasharray="4 3"')[1]).toBe("dashed");
    expect(strokeSize("1.25", ' stroke-dasharray="1 3"')[1]).toBe("dotted");
  });
});
