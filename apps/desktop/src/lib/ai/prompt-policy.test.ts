import { describe, expect, it } from "vitest";

import { createTranslator, SUPPORTED_LOCALES } from "@/lib/i18n";
import { prompt as jaPrompt } from "@/lib/i18n/dictionaries/ja/prompt";

import { buildMathliveContextPrompt, buildSigmaDocContextPrompt } from "./ai-edit-runtime";
import {
  buildMcpEditInvariantGuidance,
  buildMcpEditTurnHardRules,
  buildMcpImageSourceFidelityRule,
  buildMcpWebSearchPrompt,
  buildMcpEditPrompt,
  buildMcpEditTurnPrompt,
  buildMcpRefusedOperationContinuationPrompt,
} from "./mcp-edit-prompt";

/**
 * D2: **プロンプト自体は UI の表示言語に連動する**が、教材の中身の言語は文書に従う。
 * 英語 UI で日本語の教材を編集しても教材が英語に化けないよう、モデルへ実際に送られる
 * プロンプトには必ず `documentLanguagePolicy` が入っていなければならない。
 */
const TURN_ARGS = { instruction: "test instruction", fileId: "file_1" };

/** **モデルへ実際に送られる入口。** 節ビルダーはここへ合成されるだけで単体では送らない。 */
const ENTRY_POINTS: Array<[string, (locale: "ja" | "en") => string]> = [
  ["buildMcpEditPrompt", (locale) => buildMcpEditPrompt({ provider: "claude", ...TURN_ARGS, locale })],
  ["buildMcpEditPrompt (codex)", (locale) => buildMcpEditPrompt({ provider: "codex", ...TURN_ARGS, locale })],
  ["buildMcpEditPrompt (resumed)", (locale) => buildMcpEditPrompt({ provider: "claude", ...TURN_ARGS, locale, isResumedTurn: true })],
  ["buildMcpEditTurnPrompt", (locale) => buildMcpEditTurnPrompt("claude", TURN_ARGS, locale)],
  ["buildMcpEditInvariantGuidance", (locale) => buildMcpEditInvariantGuidance(createTranslator(locale, "prompt"))],
  ["buildMcpRefusedOperationContinuationPrompt", (locale) => buildMcpRefusedOperationContinuationPrompt(
    ["commandExecution"], "run_1", createTranslator(locale, "prompt"),
  )],
];

describe("document language policy reaches every prompt", () => {
  for (const [name, build] of ENTRY_POINTS) {
    for (const locale of SUPPORTED_LOCALES) {
      it(`${name} carries the policy in ${locale}`, () => {
        const policy = createTranslator(locale, "prompt")("documentLanguagePolicy");
        const text = build(locale);
        expect(text).toContain(policy);
        // 節ごとに足すと同じ一文が何度も並ぶ。先頭に 1 度だけであることまで見る。
        expect(text.split(policy).length - 1, `${name} / ${locale}`).toBe(1);
        expect(text.startsWith(policy), `${name} / ${locale} starts with the policy`).toBe(true);
      });
    }
  }

  it("never tells the agent to write in a specific language", () => {
    // 旧 `MCP_EDIT_TURN_HARD_RULES` は「自然な日本語で書く」と指示していた。D2 では
    // 教材の言語は**文書**が決めるので、この手の決め打ちが復活したらここで落とす。
    for (const locale of SUPPORTED_LOCALES) {
      const text = buildMcpEditPrompt({ provider: "claude", ...TURN_ARGS, locale });
      const policy = createTranslator(locale, "prompt")("documentLanguagePolicy");
      const withoutPolicy = text.replace(policy, "");
      expect(withoutPolicy).not.toMatch(/自然な日本語|in natural Japanese|in Japanese/u);
    }
  });
});

describe("the English prompt is actually English", () => {
  // **`・` と CJK 約物まで含める。** 狭いクラスだと「日本語なし」と言いながら全角記号が残る (code-review 指摘)。
  const JAPANESE = /[\u3000-\u303F\u3040-\u30FF\u4E00-\u9FFF\uFF01-\uFF60]/u;

  for (const [name, build] of ENTRY_POINTS) {
    it(`${name} contains no Japanese characters`, () => {
      const text = build("en");
      const found = [...text].filter((character) => JAPANESE.test(character));
      expect([...new Set(found)].join(""), `${name} leaked Japanese`).toBe("");
    });
  }

  it("keeps the schema and MathLive guidance English too", () => {
    for (const build of [buildSigmaDocContextPrompt, buildMathliveContextPrompt]) {
      const text = build(createTranslator("en", "prompt"));
      expect([...text].filter((character) => JAPANESE.test(character)).join("")).toBe("");
    }
  });

  it("never falls back to Japanese for any prompt key", () => {
    // `fallbackLng: "ja"` があるので、英語のキーが抜けても「引ける」検査は緑のまま
    // 日本語が返る。返り値そのものを見るのが唯一の網。
    const flatten = (node: unknown, prefix = "", out: string[] = []): string[] => {
      if (typeof node === "string") {
        out.push(prefix);
        return out;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        flatten(value, prefix ? `${prefix}.${key}` : key, out);
      }
      return out;
    };
    const t = createTranslator("en", "prompt");
    const leaked = flatten(jaPrompt).filter((key) => JAPANESE.test(t(key as never) as unknown as string));
    expect(leaked, "英語で引くと日本語が返るキー").toEqual([]);
  });
});

/**
 * **英語のプロンプトが「日本語を含まない」だけでは不十分。**
 *
 * これらの一文はモデルの振る舞いを縛る安全規則で、訳が緩むと (「禁止」→「なるべく避ける」、
 * 条件節の反転など) 英語 UI でだけ agent が広く動けるようになる。日本語側は
 * `mcp-edit-prompt.test.ts` が押さえているので、ここは英語側の実体を押さえる
 * (security-review 指摘)。
 */
describe("the English prompt keeps its guardrails", () => {
  const tEn = createTranslator("en", "prompt");

  it("keeps the hard rules prohibitive", () => {
    const rules = buildMcpEditTurnHardRules(tEn);
    expect(rules).toMatch(/forbidden/iu);
    expect(rules).toMatch(/only through the Sigma Studio MCP/iu);
    expect(rules).toMatch(/only when .*Web search policy/iu);
    expect(rules).toMatch(/expectedRevision/u);
    // 「なるべく避ける」系に緩められていないこと。
    expect(rules).not.toMatch(/\b(avoid|prefer not to|try not to|should not usually)\b/iu);
  });

  it("keeps the refusal prompt absolute", () => {
    const refusal = buildMcpRefusedOperationContinuationPrompt(["commandExecution"], undefined, tEn);
    expect(refusal).toMatch(/never available/iu);
    expect(refusal).toMatch(/Do not retry the same operation/iu);
  });

  it("keeps the source-fidelity rule prohibitive", () => {
    expect(buildMcpImageSourceFidelityRule(tEn)).toMatch(/do not (infer|generate)/iu);
  });

  it("resolves the web-search conditional it references", () => {
    // `editTurnHardRules` は「"Web search policy" がある turn だけ」と書いている。
    // その見出しが実際に `webSearch` 節の文言と一致していないと、条件が永久に成立しない。
    for (const locale of SUPPORTED_LOCALES) {
      const t = createTranslator(locale, "prompt");
      const heading = buildMcpWebSearchPrompt(t).split("\n")[0].replace(/[:：]\s*$/u, "");
      expect(buildMcpEditTurnHardRules(t), `${locale} hard rules must name the web-search section`)
        .toContain(heading);
    }
  });
});

/**
 * グラフ例 (900 字超) を差し込むかどうかは利用者の指示語から判定する。
 * **英語側を語境界で囲まないと `paragraph` が `graph` に当たり**、段落を直すだけの
 * 指示で毎回グラフ例が載る (code-review 指摘)。日英どちらの言い方でも判定が
 * 期待どおりであることを固定する。
 */
describe("graph example injection", () => {
  const contains = (instruction: string, locale: "ja" | "en", marker: string) =>
    buildMcpEditTurnPrompt("claude", { instruction, fileId: "f" }, locale).includes(marker);
  const JA_MARKER = "Graph2Specの例:";
  const EN_MARKER = "Graph2Spec examples:";

  it("stays out of plain body edits", () => {
    expect(contains("Rewrite this paragraph", "en", EN_MARKER)).toBe(false);
    expect(contains("Fix the paragraphs above", "en", EN_MARKER)).toBe(false);
    expect(contains("この段落を直して", "ja", JA_MARKER)).toBe(false);
  });

  it("fires for graph work in either language", () => {
    expect(contains("Add a graph of y=x^2", "en", EN_MARKER)).toBe(true);
    expect(contains("Plot the function", "en", EN_MARKER)).toBe(true);
    expect(contains("Draw the parabola", "en", EN_MARKER)).toBe(true);
    expect(contains("グラフを追加して", "ja", JA_MARKER)).toBe(true);
    expect(contains("放物線を描いて", "ja", JA_MARKER)).toBe(true);
  });
});
