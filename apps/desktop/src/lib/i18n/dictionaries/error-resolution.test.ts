import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import { error as ja } from "./ja/error";

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
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/u;

describe("error namespace resolution", () => {
  it("resolves every key in both locales", () => {
    for (const locale of ["ja", "en"] as const) {
      const t = createTranslator(locale, "error");
      const broken = KEYS.filter((key) => {
        const value = t(key as never, {
          expected: 1,
          actual: 2,
          page: 3,
          targetId: "target",
          maxBytes: 1024,
          startBlockId: "start",
          endBlockId: "end",
          ids: "id-1",
          field: "nextDocument",
          assetId: "asset-1",
          detail: "detail",
          id: "proposal-1",
          pid: 123,
          path: "/tmp/lock",
          binPath: "/usr/local/bin/provider",
          permission: "mcp",
          code: 1,
          method: "account/read",
          keys: "unexpected",
          location: " (content)",
          boxId: "box-1",
          blockId: "block-1",
          sectionId: "section-1",
          threadId: "thread-1",
          messageId: "message-1",
          type: "paragraph",
          mathId: "math-1",
          nodeId: "node-1",
          command: "\\foo",
          count: 1,
          href: "https://example.test",
          source: "component",
          title: "Material",
          message: "message",
          value: "value",
          version: 1,
        } as never) as unknown as string;
        return !value || value === key || value.includes("{{");
      });
      expect(broken, `${locale} で引けないキー`).toEqual([]);
    }
  });

  it("does not fall back to Japanese in English", () => {
    const t = createTranslator("en", "error");
    expect(KEYS.filter((key) => JAPANESE.test(t(key as never)))).toEqual([]);
  });
});
