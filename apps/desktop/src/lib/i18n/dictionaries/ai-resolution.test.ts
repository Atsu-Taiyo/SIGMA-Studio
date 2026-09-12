import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";
import { ACTIVITY_LABEL_TOOL_NAMES } from "@/lib/ai/ai-agent-activity-label";
import { AI_EDIT_CHANGE_NOUN_IDS } from "@/features/ai-edit/model/preview";
import { AI_PREVIEW_TITLE_IDS } from "@/features/ai-edit/view/AiEditInlinePreviewCard";
import { AI_APPLIED_DIFF_NOUN_IDS } from "@/features/ai-edit/view/AiAppliedDocumentDiff";
import { ACTIVITY_PHASE_IDS } from "@/lib/ai/ai-agent-activity-label";
import { REASONING_EFFORT_IDS } from "@/lib/ai/ai-model-catalog";
import { DOCK_STATUS_KEYS } from "@/components/editor/AiTaskDock";
import { CHANGE_VERB_IDS } from "@/features/ai-edit/model/preview";
import { AI_ACTION_PRESET_IDS } from "@/components/editor/AiEditPanel";

import { ai as ja } from "./ja/ai";

type DictionaryValue = string | { readonly [key: string]: DictionaryValue };

function flatten(node: DictionaryValue, prefix = "", out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flatten(value as DictionaryValue, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const KEYS = flatten(ja as unknown as DictionaryValue);
const LOCALES = ["ja", "en"] as const;
const JAPANESE = /[぀-ヿ一-鿿]/u;

/**
 * 英語辞書に**意図的に**日本語を残しているキー。
 *
 * `prompt.*` はモデルへ届く文で、UI 文言とは別の判断がいる (教材の言語と UI の言語の
 * 関係は WI-8 の D2 が決める)。現時点では英訳を置いてあるので空だが、将来
 * 「日本語のまま送る」と決まったらここに載せて意図を明示すること。
 */
const INTENTIONAL_JAPANESE_IN_EN: string[] = [];

describe("ai namespace resolution", () => {
  it("has a lot of keys (the scan is worthless if the dictionary is empty)", () => {
    expect(KEYS.length).toBeGreaterThan(250);
  });

  it("resolves every key through t() in both locales", () => {
    // **辞書オブジェクトを見るだけでは足りない。** i18next のキー解決はオブジェクトに
    // 当たると打ち切るので、「書いてあるのに引けない」キーが生まれる (WI-4 で実測)。
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "ai");
      const broken = KEYS.filter((key) => {
        const value = t(key as never) as unknown;
        return typeof value !== "string" || value.length === 0 || value === key;
      });
      expect(broken, `${locale} で引けないキー`).toEqual([]);
    }
  });

  it("never falls back to Japanese in English", () => {
    // `fallbackLng: "ja"` があるので、**英語のキーが抜けても「引ける」検査は緑のまま**
    // 日本語が返ってくる。型の `satisfies TranslationsOf` はキーの有無しか見ない。
    const t = createTranslator("en", "ai");
    const japanese = KEYS.filter((key) => JAPANESE.test(t(key as never) as unknown as string));
    expect(japanese, "英語で引くと日本語が返るキー").toEqual(INTENTIONAL_JAPANESE_IN_EN);
  });

  it("fills every placeholder the string declares", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "ai");
      for (const key of KEYS) {
        const raw = t(key as never) as unknown as string;
        const names = [...raw.matchAll(/\{\{([^{}]+?)\}\}/gu)].map((m) => (m[1] ?? "").split(",")[0]?.trim() ?? "");
        if (names.length === 0) {
          continue;
        }
        const values = Object.fromEntries(names.map((name) => [name, "1"]));
        expect(t(key as never, { replace: values }) as unknown as string, `${locale} / ${key}`).not.toMatch(/\{\{/u);
      }
    }
  });
});

describe("descriptors the ai namespace has to answer for", () => {
  // 記述子は「id を足して辞書を忘れる」と画面に生キーが出る。**宣言の全件**を回す。
  const cases: Array<[string, readonly string[], string]> = [
    ["MCP tool activity labels", ACTIVITY_LABEL_TOOL_NAMES, "activity.tool"],
    ["preview card titles", AI_PREVIEW_TITLE_IDS, "card.title"],
    // ここから下はテンプレートリテラルでキーを組む面。**面のキーを数える検査からは
    // 見えない** (あちらは `"…"` の literal しか拾えない) ので、id の一覧をここで回す。
    ["run phases", ACTIVITY_PHASE_IDS, "activity.phase"],
    ["reasoning efforts", REASONING_EFFORT_IDS, "model.effort"],
    ["task dock statuses", DOCK_STATUS_KEYS, "dock.status"],
    ["change verbs", CHANGE_VERB_IDS, "change.verb"],
    ["quick action labels", AI_ACTION_PRESET_IDS, "quickAction.label"],
  ];

  for (const [name, ids, prefix] of cases) {
    it(`names every id behind ${name}`, () => {
      expect(ids.length).toBeGreaterThan(2);
      for (const locale of LOCALES) {
        const t = createTranslator(locale, "ai");
        for (const id of ids) {
          const text = t(`${prefix}.${id}` as never) as unknown as string;
          expect(text, `${locale} / ${prefix}.${id}`).not.toBe(`${prefix}.${id}`);
          expect(text.length, `${locale} / ${prefix}.${id}`).toBeGreaterThan(0);
        }
      }
    });
  }

  it("names every applied-diff noun in both plural forms", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "ai");
      for (const id of AI_APPLIED_DIFF_NOUN_IDS) {
        for (const count of [1, 2]) {
          const text = t(`diff.noun.${id}` as never, { count } as never) as unknown as string;
          expect(text, `${locale} / diff.noun.${id} (${count})`).not.toContain("diff.noun");
          expect(text.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("names every change-summary noun in both plural forms", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "ai");
      for (const id of AI_EDIT_CHANGE_NOUN_IDS) {
        for (const count of [1, 2]) {
          const text = t(`change.noun.${id}` as never, { count } as never) as unknown as string;
          expect(text, `${locale} / change.noun.${id} (${count})`).not.toContain("change.noun");
          expect(text.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
