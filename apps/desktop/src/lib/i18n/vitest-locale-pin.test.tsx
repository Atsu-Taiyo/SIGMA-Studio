// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { getAppLocale } from "./locale-store";

/**
 * happy-dom は `navigator.language` に "en-US" を返すので、何もしないと
 * **happy-dom を使う UI テストだけが英語で描かれる**。`vitest.setup.ts` が
 * `sigma-studio:ui-locale` を日本語で仕込んでこれを塞いでいる。
 *
 * その仕込みが効いていることを実測で固定する。過去に「localStorage が無ければ用意する」
 * という条件付きで書いてしまい、happy-dom は localStorage を持つので一度も走らず、
 * 静かに英語のままだった (code-review で発覚)。
 */
describe("vitest locale pin", () => {
  it("resolves to Japanese even though happy-dom reports en-US", () => {
    expect(navigator.language).toBe("en-US");
    expect(window.localStorage.getItem("sigma-studio:ui-locale")).toBe("ja");
    expect(getAppLocale()).toBe("ja");
  });
});
