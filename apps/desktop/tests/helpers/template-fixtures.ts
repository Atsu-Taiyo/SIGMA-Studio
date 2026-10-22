import { createBlankDocument } from "@/lib/blank-document";
import type { SigmaDocument } from "@/features/document";

/** B5 横・狭い余白・2 段・学校名のヘッダー・本文の図形を持つ教材。保存したテンプレートの中身を想定する。 */
export function customPageSetupDocument(): SigmaDocument {
  const blank = createBlankDocument("B5横の教材");
  return {
    ...blank,
    content: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "テンプレの本文" }] }],
    pageLayout: {
      ...blank.pageLayout!,
      preset: "B5",
      orientation: "landscape",
      pageSize: { widthMm: 257, heightMm: 182 },
      marginsMm: { top: 16, right: 10, bottom: 15, left: 10 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 6 },
      header: {
        enabled: true, heightMm: 8, offsetMm: 5, showOnFirstPage: true,
        blocks: [{ type: "paragraph", id: "school", children: [{ type: "text", text: "○○高校 数学科" }] }],
      },
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: [{
        id: "note", type: "text", x: 80, y: 200, rotation: 0,
        props: { w: 200, h: 40, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: "note_p", children: [{ type: "text", text: "図形" }] }] },
      }] } },
    },
  };
}
