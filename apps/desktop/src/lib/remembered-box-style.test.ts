import { afterEach, describe, expect, it, vi } from "vitest";

import { createBoxBlock } from "@/lib/box-blocks";
import {
  applyRememberedBoxFrame,
  forgetRememberedBoxFrame,
  readRememberedBoxFrame,
  rememberBoxFramePatch,
  resetRememberedBoxStylesForTest,
} from "@/lib/remembered-box-style";

/**
 * 「一度決めた見た目で次も挿さる」ための記憶。再起動をまたぐので `localStorage` に置く。
 * vitest には DOM が無いので `window` をテストごとに差し込む — 保存領域が使えない環境
 * (プライベートモード・埋め込み) もそのまま試せる。
 */

const STORAGE_KEY = "sigma-studio:box-style-defaults";

function installStorage(initial?: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (initial !== undefined) {
    entries.set(STORAGE_KEY, initial);
  }
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
    } as Storage,
  });
  return entries;
}

afterEach(() => {
  resetRememberedBoxStylesForTest();
  vi.unstubAllGlobals();
  resetRememberedBoxStylesForTest();
});

describe("覚えた箱スタイル", () => {
  it("folds patches per style and hands them to the next insertion", () => {
    installStorage();

    rememberBoxFramePatch("titlebox", { titleBackgroundColor: "#fde68a" });
    rememberBoxFramePatch("titlebox", { borderColor: "#7c2d12" });

    expect(readRememberedBoxFrame("titlebox")).toMatchObject({
      titleBackgroundColor: "#fde68a",
      borderColor: "#7c2d12",
    });

    const inserted = applyRememberedBoxFrame(createBoxBlock("titlebox"));
    expect(inserted.frame).toMatchObject({
      titleBackgroundColor: "#fde68a",
      borderColor: "#7c2d12",
      // 触っていない項目は組み込みの既定のまま。
      borderWidthPx: 1.2,
    });
    // 覚えているのは差分だけ。組み込みの既定が変わったらそれに付いていく。
    expect(readRememberedBoxFrame("titlebox")).not.toHaveProperty("borderWidthPx");
  });

  it("keeps the other decorations when one of them is remembered", () => {
    installStorage();
    const cornerbox = createBoxBlock("cornerbox");
    const decorations = [
      { type: "titleDoubleRule" as const, ruleWidthPx: 1, ruleColor: "#2563eb", guideColor: "#b8b8b8" },
      { type: "cornerSquares" as const, sizePx: 8, color: "#000000" },
    ];

    rememberBoxFramePatch("cornerbox", { decorations });

    expect(applyRememberedBoxFrame(cornerbox).frame?.decorations).toEqual(decorations);
  });

  it("only touches a box of that style", () => {
    installStorage();
    rememberBoxFramePatch("titlebox", { borderColor: "#7c2d12" });

    expect(applyRememberedBoxFrame(createBoxBlock("bandbox")).frame?.borderColor).toBe("#111111");
    expect(applyRememberedBoxFrame({ type: "paragraph", id: "p", children: [] }))
      .toEqual({ type: "paragraph", id: "p", children: [] });
  });

  it("survives a fresh page, which is what a restart looks like from here", () => {
    const entries = installStorage();
    rememberBoxFramePatch("tabbox", { titleBackgroundColor: "#166534" });
    const persisted = entries.get(STORAGE_KEY);

    // 新しいページ: モジュールの複製は消え、保存領域は残る。
    resetRememberedBoxStylesForTest();
    vi.unstubAllGlobals();
    installStorage(persisted);

    expect(readRememberedBoxFrame("tabbox")).toMatchObject({ titleBackgroundColor: "#166534" });
  });

  it("drops only the broken entry, and forgets on request", () => {
    installStorage(JSON.stringify({
      titlebox: { borderColor: "#7c2d12" },
      bandbox: { borderWidthPx: "太い" },
    }));

    expect(readRememberedBoxFrame("titlebox")).toMatchObject({ borderColor: "#7c2d12" });
    expect(readRememberedBoxFrame("bandbox")).toBeNull();

    forgetRememberedBoxFrame("titlebox");
    expect(readRememberedBoxFrame("titlebox")).toBeNull();
    expect(applyRememberedBoxFrame(createBoxBlock("titlebox")).frame?.borderColor).toBe("#111111");
  });

  it("still remembers within the session when storage is unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => undefined,
      } as unknown as Storage,
    });

    rememberBoxFramePatch("theorembox", { backgroundColor: "#fef2f2" });

    expect(readRememberedBoxFrame("theorembox")).toMatchObject({ backgroundColor: "#fef2f2" });
  });
});
