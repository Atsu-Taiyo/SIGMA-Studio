import { describe, expect, it } from "vitest";

import { applySigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { getDefaultPageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

/**
 * AI から背景を変更する機能は今回のスコープ外だが、**既存の `updatePageLayout` を
 * 通しただけで背景が消えない**ことは固定しておく必要がある。
 *
 * `mergedLayout` は `...baseLayout` を展開しているので、`normalizePageLayout` の
 * 両分岐が `background` を保持している限り勝手に落ちない。逆に normalize 側で
 * 落とすと、AI がページ設定を触った瞬間にユーザーが選んだ背景が失われる。
 *
 * 別ファイルにしているのは `sigma-doc-edit-schema.test.ts` が別作業の WIP のため。
 */
function whiteboardDocument(background: "grid" | "dots" | "none"): SigmaDocument {
  return {
    ...sampleDocument,
    content: [],
    comments: [],
    pageLayout: { ...getDefaultPageLayout("whiteboard"), background },
  } as SigmaDocument;
}

describe("updatePageLayout keeps the whiteboard background", () => {
  it("survives an unrelated page-size patch", () => {
    const result = applySigmaDocMutationOp(whiteboardDocument("grid"), {
      operation: "updatePageLayout",
      summary: "ホワイトボードの幅を広げました。",
      patch: { pageSize: { widthMm: 320 } },
    });

    expect(result.nextDocument.pageLayout?.background).toBe("grid");
    expect(result.nextDocument.pageLayout?.pageSize.widthMm).toBe(320);
  });

  it("keeps an explicit 'none' instead of falling back to the default", () => {
    const result = applySigmaDocMutationOp(whiteboardDocument("none"), {
      operation: "updatePageLayout",
      summary: "ホワイトボードを横向きにしました。",
      patch: { orientation: "landscape" },
    });

    expect(result.nextDocument.pageLayout?.background).toBe("none");
  });
});
