import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

describe("post-main block and whiteboard UI translations", () => {
  it("resolves block controls in both locales", () => {
    const ja = createTranslator("ja", "chrome");
    const en = createTranslator("en", "chrome");

    expect(ja("format.blockStructure.more")).toBe("その他のブロック");
    expect(en("format.blockStructure.more")).toBe("More blocks");
    expect(ja("tabs.newWhiteboard")).toBe("ホワイトボード");
    expect(en("tabs.newWhiteboard")).toBe("Whiteboard");
  });

  it("resolves whiteboard settings and background controls in both locales", () => {
    const jaSettings = createTranslator("ja", "settings");
    const enSettings = createTranslator("en", "settings");
    const jaShape = createTranslator("ja", "shape");
    const enShape = createTranslator("en", "shape");

    expect(jaSettings("page.whiteboard")).toBe("無限キャンバス");
    expect(enSettings("page.whiteboard")).toBe("Infinite canvas");
    expect(jaShape("whiteboardBackground.none")).toBe("背景なし");
    expect(enShape("whiteboardBackground.none")).toBe("No background");
  });
});
