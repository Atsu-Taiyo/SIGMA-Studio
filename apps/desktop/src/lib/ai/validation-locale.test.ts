import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { describe, expect, it } from "vitest";

import { createTranslator, SUPPORTED_LOCALES } from "@/lib/i18n";
import { prompt as jaPrompt } from "@/lib/i18n/dictionaries/ja/prompt";

import type { AiEditAgentItemType } from "./ai-edit-runtime";
import { parseAiEditDraft, parseSigmaDocMutationOp } from "./sigma-doc-edit-schema";
import { setValidationLocale, tv } from "./validation-locale";

const JAPANESE = /[　-〿぀-ヿ一-鿿！-｠]/u;

function flatten(node: unknown, prefix = "", out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    flatten(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const VALIDATION_KEYS = flatten(jaPrompt.validation).map((key) => `validation.${key}`);

describe("validation messages", () => {
  it("covers a meaningful number of keys", () => {
    expect(VALIDATION_KEYS.length).toBeGreaterThan(250);
  });

  it("resolves every key in both locales", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = createTranslator(locale, "prompt");
      const broken = VALIDATION_KEYS.filter((key) => {
        const value = t(key as never) as unknown;
        return typeof value !== "string" || value.length === 0 || value === key;
      });
      expect(broken, `${locale} で引けないキー`).toEqual([]);
    }
  });

  it("never falls back to Japanese in English", () => {
    // `fallbackLng: "ja"` があるので、英語のキーが抜けても「引ける」検査は緑のまま
    // 日本語が返る。返り値そのものを見るのが唯一の網。
    const t = createTranslator("en", "prompt");
    const leaked = VALIDATION_KEYS.filter((key) => JAPANESE.test(t(key as never) as unknown as string));
    expect(leaked, "英語で引くと日本語が返るキー").toEqual([]);
  });

  /**
   * 補間名は訳文の一部として書き写すので、片方だけ落ちても**例外にならず値が消えるだけ**。
   * 「ツール実行中... (search)」が英語では「Running tool...」になる、という壊れ方をする。
   * 上の 2 検査 (引けるか / 日本語が漏れないか) はどちらもこれを見逃す。
   */
  it("keeps the same interpolation placeholders in both locales", () => {
    const placeholders = (text: string): string =>
      [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1]).sort().join(",");
    const ja = createTranslator("ja", "prompt");
    const en = createTranslator("en", "prompt");

    const mismatched = VALIDATION_KEYS
      .map((key) => ({
        key,
        ja: placeholders(ja(key as never) as unknown as string),
        en: placeholders(en(key as never) as unknown as string),
      }))
      .filter((entry) => entry.ja !== entry.en);

    expect(mismatched, "ja と en で補間名が食い違うキー").toEqual([]);
  });

  /**
   * 同じ日本語に別々の英語を当てると、**1 回の実行の中で同じものが 2 通りの名前で
   * 呼ばれる** (「導入文」が "Intro text" と "lead text" の両方で出ていた)。
   * キーが分かれていること自体は構わないが、訳は揃っている必要がある。
   */
  it("renders the same Japanese string the same way in English", () => {
    const ja = createTranslator("ja", "prompt");
    const en = createTranslator("en", "prompt");
    const byJapanese = new Map<string, Map<string, string[]>>();

    for (const key of VALIDATION_KEYS) {
      const source = ja(key as never) as unknown as string;
      const target = en(key as never) as unknown as string;
      const renderings = byJapanese.get(source) ?? new Map<string, string[]>();
      renderings.set(target, [...(renderings.get(target) ?? []), key]);
      byJapanese.set(source, renderings);
    }

    const split = [...byJapanese.entries()]
      .filter(([, renderings]) => renderings.size > 1)
      .map(([source, renderings]) => ({ source, english: [...renderings.keys()].sort() }));

    expect(split, "同じ日本語に複数の英訳を当てているキー").toEqual([]);
  });
});

describe("zod schemas follow the locale at parse time", () => {
  /**
   * **これが WI-8b の肝。** zod のスキーマは module 直下で 1 度しか組まれないので、
   * `message:` に文字列を直接書くと読み込み時の言語で焼き付く。zod 4 の
   * `error: () => tv(…)` は検証が失敗した瞬間に評価されるため、**スキーマを作り直さず**
   * 言語が切り替わる。ここが緑なら、ロケール別ファクトリもメモ化も要らない。
   */
  // asset map のキーと `asset.id` の不一致は**自前の文言**を出す (zod 組み込みではない)。
  // 組み込みメッセージだけが出る fixture を選ぶと、両ロケールとも英語で同じになり
  // 「言語が切り替わっている」ことを何も証明できない。
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const invalidDraft = {
    operation: "insertOverlayShape",
    targetId: "block_1",
    overlayShape: { id: "shape_new", type: "image", x: 10, y: 10, props: { assetId: "asset_actual", w: 120, h: 80 } },
    assets: {
      asset_wrong_key: {
        id: "asset_actual",
        type: "image",
        props: { w: 120, h: 80, name: "asset_actual.png", isAnimated: false, mimeType: "image/png", src: PNG, fileSize: 4 },
      },
    },
  };

  function messageFor(locale: "ja" | "en"): string {
    setValidationLocale(locale);
    try {
      parseAiEditDraft(invalidDraft);
      return "";
    } catch (error) {
      return String(error);
    } finally {
      setValidationLocale(null);
    }
  }

  it("produces a different message per locale from the same schema instance", () => {
    const ja = messageFor("ja");
    const en = messageFor("en");
    expect(ja).not.toBe("");
    expect(ja).not.toBe(en);
  });

  it("keeps English validation output free of Japanese", () => {
    setValidationLocale("en");
    try {
      const bad = invalidDraft;
      expect(() => parseAiEditDraft(bad)).toThrow();
      let text = "";
      try { parseAiEditDraft(bad); } catch (error) { text = String(error); }
      // zod の組み込みメッセージは英語なので、日本語が出たら自前の文言の訳し漏れ。
      const leaked = [...text].filter((character) => JAPANESE.test(character));
      expect([...new Set(leaked)].join("")).toBe("");
    } finally {
      setValidationLocale(null);
    }
  });

  /**
   * 上の fixture は `superRefine` を踏むので、`error: () => tv(…)` 形式を
   * 一度も通らない (どちらの形も遅延なので緑になってしまう: code-review 指摘)。
   * **スキーマオプションの `error:` サンク**を実際に踏む入力を別に用意する。
   */
  it("resolves an error thunk on a schema option at parse time", () => {
    const negativeWidth = {
      operation: "updatePageLayout",
      summary: "用紙幅を負にする",
      patch: { pageSize: { widthMm: -1 } },
    };
    const messageFor = (locale: "ja" | "en"): string => {
      setValidationLocale(locale);
      try {
        parseSigmaDocMutationOp(negativeWidth);
        throw new Error("should not parse");
      } catch (error) {
        return String(error);
      } finally {
        setValidationLocale(null);
      }
    };

    const ja = messageFor("ja");
    const en = messageFor("en");
    expect(ja).toContain(createTranslator("ja", "prompt")("validation.schema.pageLayoutSizePatch1" as never) as unknown as string);
    expect(en).toContain(createTranslator("en", "prompt")("validation.schema.pageLayoutSizePatch1" as never) as unknown as string);
    expect(JAPANESE.test(en)).toBe(false);
  });

  it("resolves tv() at call time, not at module load", () => {
    setValidationLocale("ja");
    const ja = tv("tools.getDocumentOutline1");
    setValidationLocale("en");
    const en = tv("tools.getDocumentOutline1");
    setValidationLocale(null);
    expect(ja).not.toBe(en);
    expect(JAPANESE.test(en)).toBe(false);
  });
});

/**
 * `tv()` を関数の外で呼ぶと、**読み込み時の言語で焼き付く**。
 *
 * この罠は WI-8b で 4 度踏んだ (`VARIATION_TABLE_ARRAY_ERROR_MESSAGE` /
 * `REFUSED_OPERATION_WARNING` / `CODEX_ITEM_TYPE_LABELS` / `z.number().positive(tv(…))`)。
 * 最初は「波括弧の深さ 0 の行」で見ていたが、**オブジェクトリテラルや `z.object({…})`
 * の引数の中にいる呼び出しは深さ 1 以上なので素通り**した (レビュー指摘)。
 * 行ベースの近似ではなく構文木で「関数に囲まれていない `tv()`」を探す。
 */
describe("tv() is never evaluated at module load", () => {
  /**
   * 手で並べた一覧は必ず古くなる (`ai-edit-shared-runner.ts` を移行したとき、
   * ここに足し忘れて検査の外に落ちた)。`tv` を import しているファイルを毎回数え直す。
   */
  const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const FILES = ["src", "electron", "mcp"]
    .flatMap((dir) => readdirSync(path.join(desktopRoot, dir), { recursive: true, encoding: "utf8" })
      .map((entry) => path.join(dir, entry)))
    .filter((file) => (file.endsWith(".ts") || file.endsWith(".tsx"))
      && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
    .filter((file) => /from\s+"[^"]*validation-locale"/u.test(
      readFileSync(path.join(desktopRoot, file), "utf8"),
    ));

  it("has no tv() call outside a function body", () => {
    const offenders: string[] = [];

    // 自動走査は「0 件でも緑」になりうる。import の書き方が変わって正規表現が
    // 外れたら、この検査は**何も見ずに通る** (code-review 指摘)。
    expect(FILES.length, "tv を import するファイルが見つからない = 走査が壊れている")
      .toBeGreaterThan(5);

    for (const file of FILES) {
      const source = readFileSync(path.join(desktopRoot, file), "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

      const visit = (node: ts.Node, insideFunction: boolean): void => {
        const entersFunction = ts.isFunctionDeclaration(node)
          || ts.isFunctionExpression(node)
          || ts.isArrowFunction(node)
          || ts.isMethodDeclaration(node)
          || ts.isGetAccessorDeclaration(node)
          || ts.isSetAccessorDeclaration(node)
          || ts.isConstructorDeclaration(node);

        if (!insideFunction
          && ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === "tv") {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          offenders.push(`${file}:${line}`);
        }

        ts.forEachChild(node, (child) => visit(child, insideFunction || entersFunction));
      };

      ts.forEachChild(sourceFile, (node) => visit(node, false));
    }

    expect(offenders, "関数の外の tv() は読み込み時の言語で焼き付く").toEqual([]);
  });

  /**
   * `codexItemTypeLabel` はキーを `run.itemType_${itemType}` と組み立てる。
   * テンプレートで組む以上 TypeScript は綴りを検査できず、抜けても例外ではなく
   * キー文字列そのもの ("run.itemType_webSearch") が進捗表示に出るだけなので
   * 気付けない。ここで全 item type を両ロケール分だけ実際に引く。
   */
  it("resolves a progress label for every agent item type in both locales", () => {
    const itemTypes: readonly AiEditAgentItemType[] = [
      "reasoning",
      "agentMessage",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "webSearch",
      "todoList",
      "other",
    ];

    for (const locale of ["ja", "en"] as const) {
      const translate = createTranslator(locale, "prompt");
      for (const itemType of itemTypes) {
        const key = `validation.run.itemType_${itemType}`;
        const label = translate(key as never) as unknown as string;
        expect(label, `${locale}: ${key}`).not.toBe(key);
        expect(label.length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * `tv("...")` はキーを文字列で書くので、辞書側を整理したときに**参照だけ残る**。
   * 引けなかったキーは例外にならず、キー文字列そのものがモデルへ渡る
   * (辞書の節を書き直したとき "validation.visualLoop.buildCancelledVisualLoopResult1"
   * がそのまま実行の要約として出た)。辞書のキー一覧ではなく**ソース側の参照**から
   * 突き合わせるのが要点。
   */
  it("has a dictionary entry for every key referenced by tv()", () => {
    const ja = createTranslator("ja", "prompt");
    const referenced = new Set<string>();

    for (const file of FILES) {
      const source = readFileSync(path.join(desktopRoot, file), "utf8");
      for (const match of source.matchAll(/\btv(?:Stable)?\(\s*"([A-Za-z0-9_.]+)"/gu)) {
        referenced.add(match[1]!);
      }
    }

    expect(referenced.size, "tv() の参照が 1 つも取れない = 走査が壊れている").toBeGreaterThan(200);

    const missing = [...referenced].filter((key) => {
      const full = `validation.${key}`;
      const value = ja(full as never) as unknown;
      return typeof value !== "string" || value === full;
    }).sort();

    expect(missing, "参照されているのに辞書に無いキー").toEqual([]);
  });
});
