import { describe, expect, it } from "vitest";

import { EXTENSION_MENU_LIMITS, getExtensionBridge, normalizeExtensionMenu } from "./extension-contracts";

const group = (overrides: Record<string, unknown> = {}) => ({
  extensionId: "sample-tool",
  name: "サンプル",
  sections: [{ title: "取り込み", entries: [{ type: "button", id: "import-sample", label: "取り込む", icon: "file-input" }] }],
  ...overrides,
});

describe("normalizeExtensionMenu", () => {
  it("keeps a well-formed menu as it is", () => {
    const menu = [group({
      sections: [{ title: "見出し", entries: [
        { type: "text", text: "説明" },
        { type: "button", id: "a-b", label: "ボタン", description: "補足", icon: "sparkles" },
        { type: "separator" },
      ] }],
    })];
    expect(normalizeExtensionMenu(menu)).toEqual(menu);
  });

  it.each([null, undefined, "menu", 1, {}])("returns nothing for %s", (value) => {
    expect(normalizeExtensionMenu(value)).toEqual([]);
  });

  it("drops what cannot be drawn safely and keeps the rest", () => {
    const result = normalizeExtensionMenu([
      group({ extensionId: "Bad Id" }),
      group({ name: "" }),
      group({ name: "x\u0007" }),
      group({ sections: "none" }),
      group({ sections: [{ entries: [{ type: "separator" }] }] }),
      group({ extensionId: "kept", sections: [{ entries: [
        { type: "iframe", src: "https://example.test" },
        { type: "button", id: "Bad Id", label: "x" },
        { type: "button", id: "no-label", label: "  " },
        { type: "button", id: "unknown-icon", label: "ok", icon: "https://example.test/x.png" },
        { type: "text", text: "" },
        null,
        "string",
      ] }] }),
    ]);
    expect(result).toEqual([{ extensionId: "kept", name: "サンプル", sections: [{ entries: [{ type: "button", id: "unknown-icon", label: "ok" }] }] }]);
  });

  it("bounds the number of sections and items", () => {
    const sections = Array.from({ length: EXTENSION_MENU_LIMITS.sections + 3 }, (_, section) => ({
      entries: Array.from({ length: 10 }, (_, entry) => ({ type: "button", id: `item-${section}-${entry}`, label: "x" })),
    }));
    const result = normalizeExtensionMenu([group({ sections })]);
    expect(result[0].sections.length).toBeLessThanOrEqual(EXTENSION_MENU_LIMITS.sections);
    const items = result[0].sections.flatMap((section) => section.entries).length;
    expect(items).toBeLessThanOrEqual(EXTENSION_MENU_LIMITS.items);
  });

  it("never carries an action through to the renderer", () => {
    const result = normalizeExtensionMenu([group({ sections: [{ entries: [
      { type: "button", id: "a", label: "x", action: { type: "import-file", command: "convert", extensions: [".smp"] }, onClick: "alert(1)" },
    ] }] })]);
    expect(JSON.stringify(result)).not.toMatch(/action|import-file|onClick|alert/);
  });
});

describe("getExtensionBridge", () => {
  it("is absent without the desktop bridge", () => {
    expect(getExtensionBridge()).toBeNull();
  });
});
