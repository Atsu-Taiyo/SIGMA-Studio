import { createTranslator } from "@/lib/i18n";
import { describe, expect, it } from "vitest";
import { buildMathliveContextPrompt } from "./ai-edit-runtime";

import {
  buildMcpEditPrompt,
  buildMcpEditTurnPrompt,
  formatAiResourcePromptSection,
  buildMcpEditAppContextToolGuide,
  buildMcpContentToolGuidePrompt,
  buildMcpEditGraphExamples,
  buildMcpEditInvariantGuidance,
  buildMcpEditInvariantGuidanceSection,
  buildMcpEditTurnHardRules,
  buildMcpChatgptVisualPreviewPrompt,
  buildMcpGraphToolGuidePrompt,
  buildMcpImageMaterialReconstructionPrompt,
  buildMcpImageSourceFidelityRule,
  buildMcpMaterialReusePrompt,
  buildMcpOfficialSkillGuide,
  buildMcpShapeToolGuidePrompt,
  buildMcpTableToolGuidePrompt,
  buildMcpWebSearchPrompt,
} from "./mcp-edit-prompt";
import type { AiResourceRunContext } from "../../../electron/ai-resource-store";

/** プロンプトの既存アサートは日本語のまま維持する (locale を明示する)。 */
const tJa = createTranslator("ja", "prompt");
const tEn = createTranslator("en", "prompt");

describe("MathLive AI context prompt", () => {
  it("distinguishes TeX values from JSON escaping and requires complete commands", () => {
    expect(buildMathliveContextPrompt(tJa)).toContain("TeXコマンドを必ずバックスラッシュ1個");
    expect(buildMathliveContextPrompt(tJa)).toContain("例外は数式内の改行");
    expect(buildMathliveContextPrompt(tJa)).toContain("バックスラッシュ2個の直後に半角スペース");
    expect(buildMathliveContextPrompt(tJa)).toContain(String.raw`分数・根号は \frac{分子}{分母}`);
    expect(buildMathliveContextPrompt(tJa)).toContain(String.raw`\left と \right を対応する区切り記号付きの1組`);
    expect(buildMathliveContextPrompt(tJa)).toContain(String.raw`\left. / \right.`);
  });

  it("keeps independent prose out of alignment-only TeX rows", () => {
    expect(buildMathliveContextPrompt(tJa)).toContain(String.raw`\text{...}`);
    expect(buildMathliveContextPrompt(tJa)).toContain("独立したparagraph");
    expect(buildMathliveContextPrompt(tJa)).toContain("前後の数式も別paragraphへ分割");
  });
});

// **必ず呼び出した「文字列」を並べること。** 関数参照のまま並べると
// `expect(fn).not.toContain(...)` が何も検査せずに通り、走査が静かに死ぬ
// (定数 → builder 化のときに実際そうなっていた: code-review 指摘)。
const ALL_EXPORTED_STRINGS: string[] = [
  buildMcpImageMaterialReconstructionPrompt(tJa),
  buildMcpMaterialReusePrompt(tJa),
  buildMcpContentToolGuidePrompt(tJa),
  buildMcpShapeToolGuidePrompt(tJa),
  buildMcpGraphToolGuidePrompt(tJa),
  buildMcpTableToolGuidePrompt(tJa),
  buildMcpEditInvariantGuidance(tJa),
  buildMcpEditInvariantGuidanceSection(tJa),
  buildMcpEditPrompt({ locale: "ja", provider: "claude", instruction: "三角形を追加して", fileId: "file_abc" }),
  buildMcpEditPrompt({ locale: "ja", provider: "codex", instruction: "三角形を追加して", fileId: "file_abc" }),
  buildMcpEditPrompt({ locale: "ja", provider: "antigravity", instruction: "三角形を追加して", fileId: "file_abc" }),
  buildMcpEditTurnPrompt("claude", { instruction: "三角形を追加して", fileId: "file_abc" }),
  buildMcpEditTurnPrompt("codex", { instruction: "三角形を追加して", fileId: "file_abc" }),
  buildMcpEditTurnPrompt("antigravity", { instruction: "三角形を追加して", fileId: "file_abc" }),
];

describe("mcp-edit-prompt anti-regression sweep", () => {
  it.each(["ja", "en"] as const)("keeps Antigravity headless tool guidance on new and resumed %s turns", (locale) => {
    const t = createTranslator(locale, "prompt");
    for (const isResumedTurn of [false, true]) {
      const args = { locale, instruction: "Rewrite the selected math paragraph", fileId: "file_abc", isResumedTurn };
      const prompt = buildMcpEditPrompt({ ...args, provider: "antigravity" });
      expect(prompt).toContain(t("mcp.antigravityHeadlessTools"));
      expect(prompt).toContain(t("mcp.antigravityTextEditExample"));
      for (const provider of ["claude", "codex"] as const) {
        expect(buildMcpEditPrompt({ ...args, provider })).not.toContain(t("mcp.antigravityHeadlessTools"));
      }
    }
  });

  it.each(ALL_EXPORTED_STRINGS.map((value, index) => [index, value] as const))(
    "output #%i contains no draft_/dynamic tool/get_material_catalog leftovers",
    (_index, value) => {
      // 関数参照が紛れ込むと以下の not.toContain が素通りするので、まず型を見る。
      expect(typeof value).toBe("string");
      expect(value).not.toContain("draft_");
      expect(value).not.toContain("dynamic tool");
      expect(value).not.toContain("get_material_catalog");
    },
  );
});

describe("MCP tool name coverage", () => {
  it("mentions the MCP-native tool names and invariant rules", () => {
    for (const name of [
      "insert_content",
      "edit_text",
      "edit_problem",
      "organize_blocks",
      "insert_shape",
      "insert_graph",
      "insert_table",
      "insert_material",
      "list_materials",
      "get_material",
      "visual_insert_shape",
      "render_visual_edit_session",
      "propose_visual_edit_session",
      "render_block_context",
      "update_page_layout",
      "expectedRevision",
    ]) {
      expect(buildMcpEditInvariantGuidance(tJa)).toContain(name);
    }
    expect(buildMcpEditInvariantGuidance(tJa)).toContain("svg-fallback");
    expect(buildMcpEditInvariantGuidance(tJa)).toContain("verification");
  });
});

describe("content editing tool guidance", () => {
  it("shows concrete read, insert, update, and block-vs-overlay routes", () => {
    const guide = buildMcpContentToolGuidePrompt(tJa);
    const guidance = buildMcpEditInvariantGuidance(tJa);
    expect(guidance).toContain(guide);
    // 読み取りの入口と、本文ブロックとoverlay図形の使い分けは「MCP編集方針」の冒頭に1回だけ置く。
    expect(guidance).toContain("get_edit_context");
    expect(guidance).toContain("get_document_outline");
    expect(guidance).toContain("update_table / update_graph / update_graph3d / update_shape");
    expect(guide).toContain('op:"replace_text"');
    expect(guide).toContain('target:{type:"range",blockId:"p_1",from:3,to:6,quote:"変更前"}');
    expect(guide).toContain("元の書式と範囲外を保ち、曖昧な引用は拒否します");
    expect(guide).toContain('insert_content({fileId,runId,expectedRevision,targetId:"END_OF_DOCUMENT",content:{format:"markdown"');
    expect(guide).toContain('content:{format:"blocks",blocks:[...]}');
    expect(guide).toContain('edit_text({fileId,runId,expectedRevision,edit:{action:"patch",operations:[');
    expect(guide).toContain('edit:{action:"update",blockId,textまたはruns,pagination?}');
    expect(guide).toContain('edit:{action:"replace_structure",blockId,block}');
    expect(guide).toContain("完全置換はpatchではありません");
    expect(guide).toContain('edit_problem({fileId,runId,expectedRevision,edit:{action:"create",targetId,prompt:["次を解け。"]}})');
    expect(guide).toContain('既存問題はaction:"update"と対象ID');
    expect(guide).toContain('organize_blocks({fileId,runId,expectedRevision,edit:{action:"move",blockIds,targetId,position:"before"}})');
    expect(guide).toContain('edit:{action:"delete",blockIds}');
  });

  it("treats the selected block as an anchor and explains structural math/prose splitting", () => {
    // 毎ターンの規則なので厳守事項が持つ (内容ガイドでは繰り返さない)。
    const hardRules = buildMcpEditTurnHardRules(tJa);
    expect(hardRules).toContain("選択ブロックは編集位置の手掛かりであり編集境界ではない");
    expect(hardRules).toContain("分割・追加・削除・移動");
    expect(hardRules).toContain(String.raw`\text{...}/aligned行に残さずparagraphへ分ける`);
    expect(buildMcpContentToolGuidePrompt(tJa)).toContain("problem内の段落直後はそのIDをtargetIdにしてareaを省略");
  });
});

describe("page-layout tool guidance", () => {
  it("leaves update_page_layout usage to the tool description", () => {
    // 部分更新・mm単位・事前の読み取り・previewでの確認は update_page_layout の説明が持つ
    // (mcp/sigma-doc-mcp-guidance-placement.test.ts)。プロンプトには経路の一覧だけを残す。
    expect(buildMcpEditInvariantGuidance(tJa)).toContain("update_page_layout");
    expect(buildMcpEditInvariantGuidance(tJa)).not.toContain("ページ設定ツール方針");
    expect(buildMcpEditInvariantGuidance(tEn)).not.toContain("Page setup tool policy");
  });
});

describe("MCP edit execution boundaries", () => {
  it("limits local shell to skill reads and forbids direct teaching-material file access", () => {
    expect(buildMcpEditTurnHardRules(tJa)).toContain("シェルはスキル");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("SKILL.md");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("ファイルの直接読み書きは禁止");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("Web検索ポリシー");
  });

  it("points agents to task-relevant official skills without loading every body each turn", () => {
    expect(buildMcpEditTurnHardRules(tJa)).toContain(buildMcpOfficialSkillGuide(tJa));
    expect(buildMcpOfficialSkillGuide(tJa)).toContain("タスクに合うものだけ");
    expect(buildMcpOfficialSkillGuide(tJa)).toContain("毎ターン一括注入・全件読み込みしない");
    // 図・画像を入れるときは、最初にSVGのskillを見る。
    expect(buildMcpOfficialSkillGuide(tJa)).toContain("sigma-svg-figure");
  });
});

describe("table tool guidance", () => {
  it("explains general semantic variation-table arguments and visual styling", () => {
    expect(buildMcpEditInvariantGuidance(tJa)).toContain(buildMcpTableToolGuidePrompt(tJa));
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain('kind:"variation"');
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("criticalPoints");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("intervalSigns");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("leftEndpoint");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("一般形");
    expect(buildMcpTableToolGuidePrompt(tJa)).not.toContain("log x");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("borderStyle");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("borderColor");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("solid / dashed / dotted / double");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("defaultCellStyle");
    expect(buildMcpTableToolGuidePrompt(tJa)).toContain("本文のLaTeX array");
  });
});

describe("provider prompt parity", () => {
  const VISUAL_LOOP_TOOL_NAMES = [
    "begin_visual_edit_session",
    "visual_insert_shape",
    "render_visual_edit_session",
    "inspect_visual_edit_session",
    "review_visual_edit_session",
    "propose_visual_edit_session",
  ];

  it.each(["codex", "claude", "antigravity"] as const)(
    "%s prompt contains every visual-loop tool name and the expectedRevision rule",
    (provider) => {
      const prompt = buildMcpEditPrompt({ locale: "ja", provider, instruction: "三角形を追加して", fileId: "file_abc" });
      for (const name of VISUAL_LOOP_TOOL_NAMES) {
        expect(prompt).toContain(name);
      }
      expect(prompt).toContain("expectedRevision");
    },
  );

  it("uses the mcp__sigma-studio-local__ namespace line for claude", () => {
    const prompt = buildMcpEditPrompt({ locale: "ja", provider: "claude", instruction: "指示", fileId: "file_1" });
    expect(prompt).toContain("mcp__sigma-studio-local__");
  });

  it("uses no Gemini CLI-specific MCP namespace prefix for gemini", () => {
    const prompt = buildMcpEditPrompt({ locale: "ja", provider: "antigravity", instruction: "指示", fileId: "file_1" });
    expect(prompt).toContain("sigma-studio-local");
    expect(prompt).not.toContain("mcp_sigma-studio-local_");
    expect(prompt).not.toContain("mcp__");
  });

  it("uses no MCP namespace prefix for codex", () => {
    const prompt = buildMcpEditPrompt({ locale: "ja", provider: "codex", instruction: "指示", fileId: "file_1" });
    expect(prompt).toContain("sigma-studio-local");
    expect(prompt).not.toContain("mcp__");
    expect(prompt).not.toContain("mcp_sigma-studio-local_");
  });

  it("teaches the Codex/ChatGPT path to open previewFile and submit previewCode", () => {
    const codexPrompt = buildMcpEditTurnPrompt("codex", { instruction: "図形を確認して", fileId: "file_1" });
    expect(codexPrompt).toContain("previewFile");
    expect(codexPrompt).toContain("view_image");
    expect(codexPrompt).toContain("previewCode");
    expect(codexPrompt).toContain(buildMcpChatgptVisualPreviewPrompt(tJa));

    const claudePrompt = buildMcpEditTurnPrompt("claude", { instruction: "図形を確認して", fileId: "file_1" });
    expect(claudePrompt).not.toContain(buildMcpChatgptVisualPreviewPrompt(tJa));
  });
});

describe("buildMcpEditPrompt", () => {
  it("includes fileId, selectedId, instruction and the AI resource section for all providers", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const aiResources: AiResourceRunContext = {
        provider,
        always: [{ id: "r1", kind: "skill", title: "res title", loadMode: "always", description: "d", tags: [], content: "resource content" }],
        explicit: [],
      };
      const prompt = buildMcpEditPrompt({ locale: "ja",
        provider,
        instruction: "本文を追加して",
        fileId: "file_xyz",
        selectedId: "block_1",
        aiResources,
      });
      expect(prompt).toContain("file_xyz");
      expect(prompt).toContain("block_1");
      expect(prompt).toContain("本文を追加して");
      expect(prompt).toContain("resource content");
      expect(prompt).toContain("追加AIリソース");
    }
  });

  it("composition invariant: claude full prompt equals head + guidance + tail composed the same way as buildMcpEditPrompt", () => {
    const args = { instruction: "解説を追加して", fileId: "file_abc", selectedId: "block_9" };
    const turnPrompt = buildMcpEditTurnPrompt("claude", args);
    const fullPrompt = buildMcpEditPrompt({ locale: "ja", provider: "claude", ...args });

    for (const line of turnPrompt.split("\n")) {
      if (line.length > 0) {
        expect(fullPrompt).toContain(line);
      }
    }
    // 合成後は節として入る (出力言語ポリシーは全体の先頭に 1 度だけ)。
    expect(fullPrompt).toContain(buildMcpEditInvariantGuidanceSection(tJa));
    expect(fullPrompt.length).toBeGreaterThan(turnPrompt.length);
  });

  // 同じ turn でモデルに届く文面の中で、ツールをまたぐ規則は1回だけ書く。
  // Codex はスレッド開始時の developerInstructions と毎ターンの turn プロンプトを両方読む。
  it.each([
    ["ja", ["REVISION_MISMATCH", "writeMode:\"dryRun\"", "迷ったらSVG", "編集境界ではない", "途中経過を短く報告",
      "targetId:\"CANVAS\"", "overlay図形です", "先回りしてinsert_shapeを選ばない", "data.changeSummary"]],
    ["en", ["REVISION_MISMATCH", "writeMode:\"dryRun\"", "(when in doubt, SVG)", "not an edit boundary", "report progress briefly",
      "targetId:\"CANVAS\"", "overlay shapes, not body blocks", "do not pick insert_shape ahead of time", "data.changeSummary"]],
  ] as const)("states each cross-tool rule once per first %s turn for every provider", (locale, rules) => {
    const t = createTranslator(locale, "prompt");
    const base = { locale, instruction: "図を入れて", fileId: "file_1", runId: "run_1" };
    const firstTurns = {
      claude: buildMcpEditPrompt({ ...base, provider: "claude" }),
      antigravity: buildMcpEditPrompt({ ...base, provider: "antigravity" }),
      codex: `${buildMcpEditInvariantGuidance(t)}\n${buildMcpEditTurnPrompt("codex", base, locale)}`,
    };
    for (const [provider, prompt] of Object.entries(firstTurns)) {
      for (const rule of [...rules, buildMcpEditAppContextToolGuide(t)]) {
        expect(prompt.split(rule).length - 1, `${provider}: ${rule}`).toBe(1);
      }
    }
  });

  it("mentions get_active_reference in the app-context tool guide", () => {
    expect(buildMcpEditAppContextToolGuide(tJa)).toContain("get_active_reference");
  });

  it("instructs agents to fetch app-attached images through get_attached_media", () => {
    expect(buildMcpImageMaterialReconstructionPrompt(tJa)).toContain("get_attached_media");
    expect(buildMcpImageMaterialReconstructionPrompt(tJa)).toContain("Antigravityでは @ファイル参照だけに依存しない");
  });

  it("treats source-faithful image reconstruction as transcription instead of problem solving", () => {
    expect(buildMcpImageSourceFidelityRule(tJa)).toContain("問題を解くタスクではありません");
    expect(buildMcpImageSourceFidelityRule(tJa)).toContain("元資料に存在しない解答");
    expect(buildMcpImageSourceFidelityRule(tJa)).toContain("answer / solution / hintsを空または未指定");
    expect(buildMcpImageMaterialReconstructionPrompt(tJa)).toContain(buildMcpImageSourceFidelityRule(tJa));
    expect(buildMcpImageMaterialReconstructionPrompt(tJa)).toContain("内容追加禁止の忠実再現");
    expect(buildMcpImageMaterialReconstructionPrompt(tJa)).toContain("解答・解説・ヒントは画像内に存在する場合");
  });

  it("shows a prompt-only edit_problem example for source reconstruction", () => {
    expect(buildMcpContentToolGuidePrompt(tJa)).toContain('edit:{action:"create",targetId,prompt:["次を解け。"]}');
    expect(buildMcpContentToolGuidePrompt(tJa)).toContain("ユーザーが作成を明示した場合だけ");
  });

  it("repeats the source-fidelity rule on attachment turns for every provider", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, {
        instruction: "この画像のレイアウトをそのまま再現して",
        fileId: "file_1",
        runId: "run_1",
        attachments: [{ name: "problem.png", mimeType: "image/png" }],
      });
      expect(prompt).toContain(buildMcpImageSourceFidelityRule(tJa));
      expect(prompt.indexOf(buildMcpImageSourceFidelityRule(tJa))).toBeLessThan(prompt.indexOf("ユーザーの指示:"));
    }
  });

  it("prefers native shape kinds over polyline approximations for simple shapes", () => {
    expect(buildMcpShapeToolGuidePrompt(tJa)).toContain("ページ座標(y軸下向き)で0°=右");
    expect(buildMcpShapeToolGuidePrompt(tJa)).toContain("画面上の時計回り");
    expect(buildMcpShapeToolGuidePrompt(tJa)).toContain("上半円(上に膨らむ)は180→360");
    expect(buildMcpShapeToolGuidePrompt(tJa)).toContain("線分列であること自体が意味を持つ場合だけ");
    expect(buildMcpShapeToolGuidePrompt(tJa)).toContain("polylineで近似するとinspectionで不合格");
    // 標準kindを使う規則と、kind:text は幅だけを決めて高さは内容から決まる規則は insert_shape の
    // 説明が持つ (mcp/sigma-doc-mcp-guidance-placement.test.ts)。ガイドで繰り返さない。
    expect(buildMcpShapeToolGuidePrompt(tJa)).not.toContain("hは指定できません");
    expect(buildMcpShapeToolGuidePrompt(tJa)).not.toContain("maxWidth");
    expect(buildMcpShapeToolGuidePrompt(tJa)).not.toContain("autoSize");
    expect(buildMcpShapeToolGuidePrompt(tJa)).toContain("graph-ownedラベルはtool側が自動採寸");
  });

  it("makes SVG the first choice for figures and keeps native shapes for individual editing", () => {
    // 毎ターン届く厳守事項が既定 (迷ったらSVG) を、初回の方針がツールの使い分けを1回ずつ持つ。
    const hardRules = buildMcpEditTurnHardRules(tJa);
    expect(hardRules).toContain("insert_svg_imageでSVG1枚として入れ（迷ったらSVG）");
    expect(hardRules).toContain("sigma-svg-figure");
    // 部品ごとに編集したい図もSVGで描き、convert_svg_image で分解する。insert_shapeで作り直さない。
    expect(hardRules).toContain("部品ごとに編集したい図もSVGで描き、previewで確かめてからconvert_svg_imageで図形・文字に分解する");
    expect(hardRules).toContain("insert_shapeで部品を作り直さない");
    expect(hardRules).not.toContain("部品ごとの個別編集を求められた図だけinsert_shape");
    const guidance = buildMcpEditInvariantGuidance(tJa);
    expect(guidance).toContain("convert_svg_image（画面の「図形に変換」と同じ変換器）で線・図形・文字・数式に分解でき");
    // 頼まれていない図までは分解しない。
    expect(guidance).toContain("部品ごとの編集を求められていない図は分解せず");
    expect(guidance).toContain("insert_shapeで部品を作り直さないでください");
    expect(guidance).toContain("先回りしてinsert_shapeを選ばない");
    expect(guidance).toContain("編集可能なネイティブ図形");
    expect(guidance).toContain("insert_graph3d");
    expect(guidance).toContain("クライアントで仕上げ");
    expect(guidance).toContain("忠実な再現");
    expect(buildMcpShapeToolGuidePrompt(tJa)).not.toContain("insert_svg_image");
    expect(buildMcpContentToolGuidePrompt(tJa)).toContain("図形だけならoverlaySelection、単一図形ならshapeとshapeIdを使います");
  });

  it("sends the SVG-first rule on every turn, for every provider, and never the old shape-first line", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      for (const prompt of [
        buildMcpEditPrompt({ locale: "ja", provider, instruction: "三角形の図を入れて", fileId: "file_abc" }),
        buildMcpEditTurnPrompt(provider, { instruction: "三角形の図を入れて", fileId: "file_abc" }),
      ]) {
        expect(prompt, provider).toContain("insert_svg_image");
        expect(prompt, provider).not.toContain("編集可能な叩き台");
      }
    }
    const english = buildMcpEditTurnPrompt("codex", { instruction: "Add a triangle figure", fileId: "file_abc" }, "en");
    expect(english).toContain("insert_svg_image");
    expect(english).not.toContain("editable starting point");
  });

  it("leaves how to write and check an SVG to the insert_svg_image description", () => {
    // xmlns・viewBox・属性・TeX・preview・w:h・回り込みの規則は insert_svg_image の説明が持つ
    // (mcp/sigma-doc-mcp-guidance-placement.test.ts)。プロンプトはそこを指すだけにする。
    const guidance = buildMcpEditInvariantGuidance(tJa);
    expect(guidance).toContain("SVGの書き方・分解しやすい書き方・制約・確認は insert_svg_image の説明に従います");
    for (const phrase of ["xmlns", "fill/stroke", "w:hの比", "回り込"]) {
      expect(guidance).not.toContain(phrase);
    }
    // 英語のUIでも同じ方針が届く。
    expect(buildMcpEditTurnHardRules(tEn)).toContain("insert_svg_image (when in doubt, SVG)");
    expect(buildMcpEditTurnHardRules(tEn)).toContain("sigma-svg-figure");
    expect(buildMcpEditTurnHardRules(tEn)).toContain("split it into shapes and text with convert_svg_image");
    expect(buildMcpEditTurnHardRules(tEn)).not.toContain("only for figures the user asked to edit part by part");
    const english = buildMcpEditInvariantGuidance(tEn);
    expect(english).toContain("do not rebuild the parts with insert_shape");
    expect(english).toContain("do not pick insert_shape ahead of time");
    expect(english).toContain("Follow the insert_svg_image description");
  });
});

describe("runId prompt line (shared-MCP-server correlation)", () => {
  it("tells the agent its runId and to pass it as the runId tool argument, for every provider", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, {
        instruction: "指示",
        fileId: "file_1",
        runId: "run_abc123",
      });
      expect(prompt).toContain(tJa("turn.runId", { replace: { runId: "run_abc123" } }));
      // The run id goes to every read and every proposal-creating write as the root runId argument.
      expect(prompt).toContain("読み取りと、編集案を作る書き込みのすべてで、最上位のrunId引数に「run_abc123」をそのまま渡してください");
    }
  });

  it("omits the runId line when runId is not given", () => {
    const prompt = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1" });
    expect(prompt).not.toContain("あなたのrunId");
  });

  it("buildMcpEditPrompt also carries runId through to the composed prompt", () => {
    const prompt = buildMcpEditPrompt({ locale: "ja", provider: "codex", instruction: "指示", fileId: "file_1", runId: "run_xyz" });
    expect(prompt).toContain("run_xyz");
  });
});

describe("mentionedDocuments hint", () => {
  it("appends a hint line with the count and titles when mentionedDocuments is non-empty", () => {
    for (const provider of ["claude", "codex"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, {
        instruction: "指示",
        fileId: "file_1",
        mentionedDocuments: [{ title: "教材A" }, { title: "教材B" }],
      });
      expect(prompt).toContain("メンションされた教材が2件あります");
      expect(prompt).toContain("教材A");
      expect(prompt).toContain("教材B");
      expect(prompt).toContain("get_mentioned_sigma_docs");
    }
  });

  it("omits the hint line when mentionedDocuments is empty or absent", () => {
    const prompt = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1" });
    expect(prompt).not.toContain("メンションされた教材が");
  });
});

describe("attachment hint", () => {
  it("tells every provider to read arbitrary app attachments through get_attached_media", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, {
        instruction: "内容を教材に反映して",
        fileId: "file_1",
        runId: "run_files",
        attachments: [
          { name: "worksheet.pdf", mimeType: "application/pdf" },
          { name: "notes.txt", mimeType: "text/plain" },
        ],
      });
      expect(prompt).toContain("添付ファイルが2件あります");
      expect(prompt).toContain("worksheet.pdf");
      expect(prompt).toContain("resource content");
      expect(prompt).toContain("get_attached_media");
    }
  });

  it("tells every provider which place each numbered image comment points at", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, {
        instruction: "画像に付けたコメントに沿って対応して。",
        fileId: "file_1",
        runId: "run_notes",
        attachments: [{
          name: "screenshot.png",
          mimeType: "image/png",
          annotations: [
            { id: "a", x: 0.25, y: 0.5, comment: "この式の符号を直して" },
            { id: "b", x: 0.1, y: 0.1, width: 0.2, height: 0.3, comment: "この図を大きく" },
          ],
        }],
      });
      expect(prompt).toContain("画像「screenshot.png」へのコメント:");
      expect(prompt).toContain("1. 点（左から25%、上から50%）: この式の符号を直して");
      expect(prompt).toContain("2. 範囲（横10〜30%、縦10〜40%）: この図を大きく");
      // コメントは添付の案内の中にあり、ユーザーの指示より前に来る。
      expect(prompt.indexOf("screenshot.png」へのコメント")).toBeLessThan(prompt.indexOf("ユーザーの指示:"));
    }
  });

  it("ignores malformed comments from a raw IPC payload instead of failing the prompt", () => {
    const prompt = buildMcpEditTurnPrompt("codex", {
      instruction: "指示",
      fileId: "file_1",
      attachments: [{ name: "a.png", annotations: [{ id: "x", x: "left", y: 0, comment: "壊れた" }] as never }],
    });
    expect(prompt).toContain("添付ファイルが1件あります");
    expect(prompt).not.toContain("へのコメント");
  });

  it("omits the attachment line when no files are attached", () => {
    const prompt = buildMcpEditTurnPrompt("codex", { instruction: "指示", fileId: "file_1" });
    expect(prompt).not.toContain("添付ファイルが");
  });
});

describe("formatAiResourcePromptSection", () => {
  it("returns an empty string when there is no context or no content", () => {
    expect(formatAiResourcePromptSection(undefined, tJa)).toBe("");
    expect(formatAiResourcePromptSection({ provider: "claude", always: [], explicit: [] }, tJa)).toBe("");
  });

  it("includes always/explicit content items", () => {
    const context: AiResourceRunContext = {
      provider: "claude",
      always: [{ id: "r1", kind: "skill", title: "Title1", loadMode: "always", description: "d1", tags: [], content: "Content1" }],
      explicit: [{ id: "r2", kind: "skill", title: "Title2", loadMode: "manual", description: "d2", tags: [], content: "Content2" }],
    };
    const section = formatAiResourcePromptSection(context, tJa);
    expect(section).toContain("Content1");
    expect(section).toContain("Title1");
    expect(section).toContain("Content2");
    expect(section).toContain("Title2");
  });

  it("keeps canonical resource headers out of the UI-locale translation path", () => {
    const context: AiResourceRunContext = {
      provider: "codex",
      always: [],
      explicit: [{
        id: "official-image-material",
        kind: "skill",
        title: "画像からSigma Studio教材を作成",
        loadMode: "manual",
        description: "canonical",
        tags: ["画像"],
        content: "skill body",
      }],
    };
    const header = "--- skill: 画像からSigma Studio教材を作成 (official-image-material) ---";
    expect(formatAiResourcePromptSection(context, tJa)).toContain(header);
    expect(formatAiResourcePromptSection(context, createTranslator("en", "prompt"))).toContain(header);
    expect(formatAiResourcePromptSection(context, createTranslator("en", "prompt")))
      .not.toContain("Create Sigma Studio material from an image");
  });

  it("uses the same empty native-discovery context shape for every provider", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      expect(formatAiResourcePromptSection({ provider, always: [], explicit: [] }, tJa)).toBe("");
    }
  });
});

describe("selection reference inclusion", () => {
  it("includes a labeled selection-context section when referenceText is given", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, {
        instruction: "この文を書き直して",
        fileId: "file_1",
        referenceText: "参照対象: textSelection\n選択テキスト: 二次関数の最大値を求めよ",
      });
      expect(prompt).toContain("ユーザーの選択コンテキスト:");
      expect(prompt).toContain("二次関数の最大値を求めよ");
    }
  });

  it("omits the selection-context section when referenceText is absent or blank", () => {
    const withoutReference = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1" });
    expect(withoutReference).not.toContain("ユーザーの選択コンテキスト:");

    const blankReference = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1", referenceText: "   " });
    expect(blankReference).not.toContain("ユーザーの選択コンテキスト:");
  });

  it("keeps a multi-reference-scale referenceText (<=6000 chars) untruncated", () => {
    const reference = "あ".repeat(3000);
    const prompt = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1", referenceText: reference });
    expect(prompt).toContain(reference);
    expect(prompt).not.toContain("省略しました");
  });

  it("truncates an overlong referenceText and notes the truncation", () => {
    const longReference = "あ".repeat(7000);
    const prompt = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1", referenceText: longReference });
    const withoutReference = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1" });
    expect(prompt).toContain("省略しました");
    // Cut at 6000 characters; the label and the truncation note add little beyond that.
    expect(prompt).toContain("あ".repeat(6000));
    expect(prompt).not.toContain("あ".repeat(6001));
    expect(prompt.length - withoutReference.length).toBeLessThan(6000 + 100);
  });

  it("carries referenceText through buildMcpEditPrompt as well", () => {
    const prompt = buildMcpEditPrompt({ locale: "ja",
      provider: "claude",
      instruction: "指示",
      fileId: "file_1",
      referenceText: "参照対象: block\n抜粋: 選択中の段落",
    });
    expect(prompt).toContain("選択中の段落");
  });
});

describe("buildMcpEditTurnHardRules(tJa) per-turn block", () => {
  it("is short (at most 6 lines) and covers expectedRevision/writeMode/verification/decomposition", () => {
    const lines = buildMcpEditTurnHardRules(tJa).split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(buildMcpEditTurnHardRules(tJa)).toContain("expectedRevision");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("writeMode");
    expect(buildMcpEditTurnHardRules(tJa)).toMatch(/確認/);
    expect(buildMcpEditTurnHardRules(tJa)).toMatch(/列挙/);
    expect(buildMcpEditTurnHardRules(tJa)).toContain("選択ブロックは編集位置の手掛かりであり編集境界ではない");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("分割・追加・削除・移動");
    expect(buildMcpEditTurnHardRules(tJa)).toContain(String.raw`\text{...}/aligned行に残さずparagraphへ分ける`);
  });

  it("does not treat revision-only or unrelated nearby edits as conflicts", () => {
    expect(buildMcpEditTurnHardRules(tJa)).toContain("revision番号が進んだだけ");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("近傍ブロックが変わっただけ");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("REVISION_MISMATCH");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("conflictBlockIds");
    expect(buildMcpEditTurnHardRules(tJa)).toContain("提案の取り下げ");
    // 競合の扱いは毎ターンの厳守事項だけが持つ (初回の方針で繰り返さない)。
    expect(buildMcpEditInvariantGuidance(tJa)).not.toContain("REVISION_MISMATCH");
  });

  it("appears in the turn prompt for every provider", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, { instruction: "指示", fileId: "file_1" });
      expect(prompt).toContain("厳守事項:");
      expect(prompt).toContain("revision番号が進んだだけ");
      expect(prompt).toContain("conflictBlockIds");
    }
  });
});

describe("resumed-turn prompt slimming", () => {
  it("drops the static guidance blocks on a resumed turn but keeps turn head, hard rules, reference, and instruction", () => {
    const args = {
      instruction: "この段落を直して",
      fileId: "file_1",
      referenceText: "参照対象: block\n抜粋: 対象段落の抜粋",
    };

    const resumedPrompt = buildMcpEditPrompt({ locale: "ja", provider: "claude", ...args, isResumedTurn: true });
    const firstTurnPrompt = buildMcpEditPrompt({ locale: "ja", provider: "claude", ...args, isResumedTurn: false });

    // Turn-level content still present.
    expect(resumedPrompt).toContain("この段落を直して");
    expect(resumedPrompt).toContain("対象段落の抜粋");
    expect(resumedPrompt).toContain("厳守事項:");
    expect(resumedPrompt).toContain("file_1");

    // Static once-per-conversation guidance dropped.
    expect(resumedPrompt).not.toContain("MCP編集方針:");
    expect(resumedPrompt).not.toContain("SigmaDoc JSONは教材の正本です。");
    expect(resumedPrompt).not.toContain(buildMcpEditInvariantGuidanceSection(tJa));

    // The first turn of the same conversation still gets the full guidance.
    expect(firstTurnPrompt).toContain("MCP編集方針:");
    expect(firstTurnPrompt).toContain(buildMcpEditInvariantGuidanceSection(tJa));
    expect(resumedPrompt.length).toBeLessThan(firstTurnPrompt.length);
  });

  it("defaults to the full first-turn prompt when isResumedTurn is omitted", () => {
    const prompt = buildMcpEditPrompt({ locale: "ja", provider: "claude", instruction: "指示", fileId: "file_1" });
    expect(prompt).toContain(buildMcpEditInvariantGuidanceSection(tJa));
  });
});

describe("buildMcpWebSearchPrompt(tJa) gating", () => {
  it("is appended to the turn prompt for every provider when webSearchEnabled is true", () => {
    for (const provider of ["claude", "codex", "antigravity"] as const) {
      const prompt = buildMcpEditTurnPrompt(provider, {
        instruction: "指示",
        fileId: "file_1",
        webSearchEnabled: true,
      });
      expect(prompt).toContain(buildMcpWebSearchPrompt(tJa));
      expect(prompt).toContain('sourceReferences: [{ type: "web", url, title }]');
    }
  });

  it("is omitted when webSearchEnabled is false or absent", () => {
    const withoutFlag = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1" });
    expect(withoutFlag).not.toContain("Web検索ポリシー:");

    const disabled = buildMcpEditTurnPrompt("claude", { instruction: "指示", fileId: "file_1", webSearchEnabled: false });
    expect(disabled).not.toContain("Web検索ポリシー:");
  });

  it("is not baked into the static buildMcpEditInvariantGuidance(tJa)", () => {
    expect(buildMcpEditInvariantGuidance(tJa)).not.toContain("Web検索ポリシー:");
  });

  it("carries through buildMcpEditPrompt (one-shot and resumed) when enabled", () => {
    const oneShot = buildMcpEditPrompt({ locale: "ja", provider: "claude", instruction: "指示", fileId: "file_1", webSearchEnabled: true });
    expect(oneShot).toContain(buildMcpWebSearchPrompt(tJa));

    const resumed = buildMcpEditPrompt({ locale: "ja", provider: "claude", instruction: "指示", fileId: "file_1", webSearchEnabled: true, isResumedTurn: true });
    expect(resumed).toContain(buildMcpWebSearchPrompt(tJa));
  });
});

describe("buildMcpEditGraphExamples(tJa) gating", () => {
  it("is omitted from the turn prompt when the instruction has no graph keyword", () => {
    const prompt = buildMcpEditTurnPrompt("claude", { instruction: "本文の誤字を直して", fileId: "file_1" });
    expect(prompt).not.toContain(buildMcpEditGraphExamples(tJa));
  });

  it("is appended to the turn prompt when the instruction mentions a graph keyword", () => {
    for (const keyword of ["グラフ", "放物線", "関数", "座標"]) {
      const prompt = buildMcpEditTurnPrompt("claude", { instruction: `${keyword}を追加して`, fileId: "file_1" });
      expect(prompt).toContain(buildMcpEditGraphExamples(tJa));
    }
  });

  it("is appended when only the selection reference (not the instruction) mentions a graph", () => {
    const prompt = buildMcpEditTurnPrompt("claude", {
      instruction: "これを直して",
      fileId: "file_1",
      referenceText: "参照対象: block\n抜粋: 二次関数のグラフの概形",
    });
    expect(prompt).toContain(buildMcpEditGraphExamples(tJa));
  });

  it("buildMcpGraphToolGuidePrompt(tJa) (always-on short rules) no longer contains the long worked examples", () => {
    expect(buildMcpGraphToolGuidePrompt(tJa)).not.toContain("単純な二次関数の例");
    expect(buildMcpGraphToolGuidePrompt(tJa)).not.toContain("サンプル教材級の範囲図の例");
    expect(buildMcpEditGraphExamples(tJa)).toContain("単純な二次関数の例");
    expect(buildMcpEditGraphExamples(tJa)).toContain("サンプル教材級の範囲図の例");
  });
});

/** The four body tools the MCP server publishes, and the internal names behind them that it never publishes. */
const BODY_TOOL_NAMES = ["insert_content", "edit_text", "edit_problem", "organize_blocks"];
const INTERNAL_BODY_NAMES = [
  "insert_body_content", "apply_edits", "update_rich_content", "replace_block",
  "create_problem_content", "update_problem_content", "delete_blocks", "move_blocks",
];

describe("body tool names in prompts", () => {
  it.each(["ja", "en"] as const)("uses current tool names and schemas in first and resumed %s prompts", (locale) => {
    const t = createTranslator(locale, "prompt");
    for (const provider of ["codex", "claude", "antigravity"] as const) {
      for (const isResumedTurn of [false, true]) {
        const prompt = buildMcpEditPrompt({
          provider, locale, isResumedTurn, fileId: "file_1", runId: "run_1", instruction: "Fix the paragraph.",
        });
        for (const name of BODY_TOOL_NAMES) expect(prompt).toContain(name);
        for (const name of INTERNAL_BODY_NAMES) expect(prompt).not.toContain(name);
        expect(prompt).toContain("edit:{action,...}");
        expect(prompt).toContain(t("documentLanguagePolicy"));
        if (!isResumedTurn) {
          expect(prompt).toContain(t("mcp.contentToolGuide"));
          expect(prompt).toContain(t("mcp.markdownBoundary"));
          expect(prompt).toContain("replace_structure");
        }
      }
    }
    const invariants = buildMcpEditInvariantGuidance(t);
    expect(invariants).toContain("source");
    expect(invariants).toContain("verification");
    expect(invariants).toContain("expectedRevision");
    for (const name of INTERNAL_BODY_NAMES) expect(invariants).not.toContain(name);
  });

  it("preserves literal tool names inside user instructions and selected text", () => {
    const instruction = "Explain the literal string apply_edits and do not replace it.";
    const referenceText = "insert_body_content / update_rich_content";
    const prompt = buildMcpEditTurnPrompt("codex", { fileId: "file_1", instruction, referenceText });
    expect(prompt).toContain(instruction);
    expect(prompt).toContain(referenceText);
  });

  it("does not rewrite identifiers that happen to match internal tool names", () => {
    const t = createTranslator("ja", "prompt");
    const prompt = buildMcpEditTurnPrompt("codex", {
      fileId: "insert_body_content", runId: "apply_edits", instruction: "Fix the paragraph.",
    });
    expect(prompt).toContain(t("turn.runId", { replace: { runId: "apply_edits" } }));
    expect(prompt).toContain(t("turn.fileId", { replace: { fileId: "insert_body_content" } }));
  });
});
