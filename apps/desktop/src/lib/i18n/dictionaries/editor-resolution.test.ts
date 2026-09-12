// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { createBlock, collectOutline } from "@/lib/document-tree";
import { createBoxBlock, resolveBoxStyles, BUILTIN_BOX_STYLES } from "@/lib/box-blocks";
import { getCommentAnchorLabel } from "@/lib/comments";
import { createTranslator } from "@/lib/i18n";
import type { SigmaDocument } from "@/features/document";

import { editor as ja } from "./ja/editor";

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
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/u;
/** 英語辞書に**意図的に**残してある日本語 (英語 UI でも `/問題` と打てるようにするため)。 */
const INTENTIONAL_JAPANESE_IN_EN = [
  "slash.block.quote.aliases",
  "slash.block.codeBlock.aliases",
  "slash.block.divider.aliases",
  "slash.problem.aliases",
];

describe("editor namespace resolution", () => {
  it("resolves the post-main block and whiteboard UI in English", () => {
    const t = createTranslator("en", "editor");
    expect(t("codeBlock.settings")).toBe("Code block settings");
    expect(t("block.quote")).toBe("Quote");
    expect(t("pageCanvas.resetView")).toBe("Reset view");
    expect(t("comment.dockPanel")).toBe("Comments panel");
    expect(t("status.whiteboardCreated")).toBe("Created a new whiteboard");
  });

  it("has a lot of keys (the scan is worthless if the dictionary is empty)", () => {
    expect(KEYS.length).toBeGreaterThan(300);
  });

  it("resolves every key through t() in both locales", () => {
    // **辞書オブジェクトを見るだけでは足りない。** i18next のキー解決は途中で
    // オブジェクトに当たると打ち切るので、「書いてあるのに引けない」キーが生まれる
    // (WI-4 でコマンド 11 件が実際にそうなった)。必ず `t()` を通す。
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "editor");
      const broken = KEYS.filter((key) => {
        const value = t(key as never, { name: "x", ids: "x" }) as unknown;
        return typeof value !== "string" || value.length === 0 || value === key;
      });
      expect(broken, `${locale} で引けないキー`).toEqual([]);
    }
  });

  it("never falls back to Japanese in English", () => {
    // `fallbackLng: "ja"` があるので、**英語のキーが抜けても「引ける」検査は緑のまま**
    // 日本語が返ってくる。ここはその穴を塞ぐ: 英語で引いた値に日本語が混じっていたら
    // 辞書の抜け (= フォールバック) を疑う。
    const t = createTranslator("en", "editor");
    const japanese = KEYS.filter((key) => JAPANESE.test(t(key as never) as unknown as string));
    expect(japanese, "英語で引くと日本語が返るキー").toEqual(INTENTIONAL_JAPANESE_IN_EN);
  });

  it("fills every placeholder the string declares", () => {
    // 値バッグを固定で持つと文言を足すたびに保守が要るので、**その文言自身が
    // 宣言している名前**から作る。補間名の日英一致は `parity.test.ts` が見ている。
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "editor");
      for (const key of KEYS) {
        const raw = t(key as never) as unknown as string;
        const names = [...raw.matchAll(/\{\{([^{}]+?)\}\}/gu)].map((m) => (m[1] ?? "").split(",")[0]?.trim() ?? "");
        if (names.length === 0) {
          continue;
        }
        const values = Object.fromEntries(names.map((name) => [name, "1"]));
        expect(t(key as never, values as never) as unknown as string, `${locale} / ${key}`).not.toMatch(/\{\{/u);
      }
    }
  });
});

describe("editor text that reaches the document or the outline", () => {
  it("bakes new blocks in the language they were created in", () => {
    const jaSection = createBlock("section", createTranslator("ja", "editor"));
    const enSection = createBlock("section", createTranslator("en", "editor"));
    expect(jaSection.type === "section" && jaSection.title).toBe("新しいセクション");
    expect(enSection.type === "section" && enSection.title).toBe("New section");
  });

  it("defaults to Japanese so existing callers and documents are untouched", () => {
    const block = createBlock("section");
    expect(block.type === "section" && block.title).toBe("新しいセクション");
  });

  it("creates an empty paragraph so the empty-document placeholder is not baked in", () => {
    const paragraph = createBlock("paragraph", createTranslator("ja", "editor"));
    const layout = createBlock("layoutSection", createTranslator("en", "editor"));
    expect(paragraph).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "" }] });
    expect(layout.type === "layoutSection" && layout.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "" }],
    });
  });

  it("bakes the default box title in the language it was created in", () => {
    expect(createBoxBlock("itembox", "", {}, createTranslator("ja", "editor")).title?.[0])
      .toMatchObject({ text: "ポイント" });
    expect(createBoxBlock("itembox", "", {}, createTranslator("en", "editor")).title?.[0])
      .toMatchObject({ text: "Key point" });
  });

  it("resolves a description and search aliases for every box style", () => {
    for (const locale of LOCALES) {
      const styles = resolveBoxStyles(createTranslator(locale, "editor"));
      expect(styles).toHaveLength(BUILTIN_BOX_STYLES.length);
      expect(styles.filter((style) => !style.description || style.description.startsWith("box."))).toEqual([]);
      expect(styles.filter((style) => style.aliases.length === 0)).toEqual([]);
    }
  });

  it("labels the outline in the requested language and keeps AI callers on Japanese", () => {
    const document = {
      docId: "doc_outline",
      schemaVersion: 1,
      metadata: { title: "t" },
      content: [
        { type: "section", id: "s1", title: "" },
        { type: "problem", id: "p1", tags: [], lead: [], prompt: [], solution: [], hints: [] },
      ],
    } as unknown as SigmaDocument;

    expect(collectOutline(document).map((entry) => entry.title)).toEqual(["セクション", "問題 1"]);
    expect(collectOutline(document, { t: createTranslator("en", "editor") }).map((entry) => entry.title))
      .toEqual(["Section", "Problem 1"]);
  });

  it("labels a comment anchor in the requested language", () => {
    const anchor = { type: "inlineMath", blockId: "b", mathId: "m" } as never;
    expect(getCommentAnchorLabel(anchor)).toBe("数式");
    expect(getCommentAnchorLabel(anchor, undefined, createTranslator("en", "editor"))).toBe("Math");
  });
});
