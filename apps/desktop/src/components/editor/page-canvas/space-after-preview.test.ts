import { describe, expect, it } from "vitest";

import {
  resolveSpaceAfterDragPx,
  resolveSpaceAfterPreviewCohort,
  type SpaceAfterPreviewBlockRect,
  type SpaceAfterPreviewUnit,
} from "./space-after-preview";

const PAGE_STRIDE = 1000;

function rects(
  entries: Record<string, SpaceAfterPreviewBlockRect>,
): ReadonlyMap<string, SpaceAfterPreviewBlockRect> {
  return new Map(Object.entries(entries));
}

/** 1 段の紙面。同じ左端・同じ幅で縦に 100px ずつ並ぶ。 */
function singleColumnRects(ids: readonly string[]): ReadonlyMap<string, SpaceAfterPreviewBlockRect> {
  return rects(Object.fromEntries(ids.map((id, index) => [
    id,
    { top: index * 100, left: 40, width: 400, height: 80 },
  ])));
}

function unit(id: string, blockIds: readonly string[]): SpaceAfterPreviewUnit {
  return { id, blockIds };
}

describe("resolveSpaceAfterDragPx", () => {
  it("converts the pointer's screen travel into logical px at the drag's zoom", () => {
    expect(resolveSpaceAfterDragPx({
      startPx: 0,
      startClientY: 200,
      clientY: 245,
      zoomFactor: 1.5,
    })).toBe(30);
  });

  it("adds the travel to the value the block already had", () => {
    expect(resolveSpaceAfterDragPx({
      startPx: 24,
      startClientY: 100,
      clientY: 110,
      zoomFactor: 1,
    })).toBe(34);
  });

  it("rounds to whole px so the committed value matches the preview", () => {
    expect(resolveSpaceAfterDragPx({
      startPx: 0,
      startClientY: 0,
      clientY: 10.4,
      zoomFactor: 1,
    })).toBe(10);
  });

  it("clamps at 0 when dragged above the block's own edge", () => {
    expect(resolveSpaceAfterDragPx({
      startPx: 10,
      startClientY: 300,
      clientY: 0,
      zoomFactor: 1,
    })).toBe(0);
  });

  it("clamps at the maximum the document can store", () => {
    expect(resolveSpaceAfterDragPx({
      startPx: 0,
      startClientY: 0,
      clientY: 100_000,
      zoomFactor: 1,
    })).toBe(400);
  });

  it("treats a missing or absurd zoom as 1 rather than dividing by zero", () => {
    expect(resolveSpaceAfterDragPx({
      startPx: 0,
      startClientY: 0,
      clientY: 30,
      zoomFactor: 0,
    })).toBe(30);
  });
});

describe("resolveSpaceAfterPreviewCohort", () => {
  it("moves only the blocks below the dragged one, inside its own unit", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1", "p2", "p3", "p4"])],
      blockRects: singleColumnRects(["p1", "p2", "p3", "p4"]),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "p2",
    });

    expect(cohort.followerBlockIds).toEqual(["p3", "p4"]);
    expect(cohort.followerUnitIds).toEqual([]);
  });

  it("never includes the dragged block itself", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1", "p2", "p3"])],
      blockRects: singleColumnRects(["p1", "p2", "p3"]),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "p2",
    });

    expect(cohort.followerBlockIds).not.toContain("p2");
  });

  it("never includes a block nested inside the dragged one", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["list", "li_a", "li_b", "after"])],
      blockRects: rects({
        list: { top: 0, left: 40, width: 400, height: 100 },
        li_a: { top: 10, left: 60, width: 380, height: 40, containerId: "list" },
        li_b: { top: 55, left: 60, width: 380, height: 40, containerId: "list" },
        after: { top: 120, left: 40, width: 400, height: 40 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "list",
    });

    expect(cohort.followerBlockIds).toEqual(["after"]);
  });

  it("leaves the next page alone: pagination is frozen while dragging", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1", "p2", "p3"])],
      blockRects: rects({
        p1: { top: 800, left: 40, width: 400, height: 80 },
        p2: { top: 890, left: 40, width: 400, height: 80 },
        p3: { top: 1010, left: 40, width: 400, height: 80 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "p1",
    });

    expect(cohort.followerBlockIds).toEqual(["p2"]);
  });

  it("follows the page the dragged block ENDS on, not the one it starts on", () => {
    // ページを跨いで分割されたブロックを掴んだとき。下余白が描かれるのは最後の行の下 =
    // 次のページ側なので、追従するのもそちら。掴んだ側のページで判定すると候補が 0 件になり、
    // ドラッグ中は何も動かず離した瞬間に一気に飛ぶ (直したかった症状そのもの)。
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["split", "next_page", "same_page_as_top"])],
      blockRects: rects({
        split: { top: 900, left: 40, width: 400, height: 250 },
        next_page: { top: 1180, left: 40, width: 400, height: 80 },
        same_page_as_top: { top: 950, left: 40, width: 400, height: 80 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "split",
    });

    expect(cohort.followerBlockIds).toEqual(["next_page"]);
  });

  it("keeps the neighbouring column still — it is not below anything that moved", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["c1_a", "c1_b", "c2_a", "c2_b"])],
      blockRects: rects({
        c1_a: { top: 0, left: 40, width: 200, height: 80 },
        c1_b: { top: 100, left: 40, width: 200, height: 80 },
        // 2 段目は同じページの下の方にも来るが、掴んだ段とは横に重ならない。
        c2_a: { top: 0, left: 280, width: 200, height: 80 },
        c2_b: { top: 100, left: 280, width: 200, height: 80 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "c1_a",
    });

    expect(cohort.followerBlockIds).toEqual(["c1_b"]);
  });

  it("follows a block whose horizontal extent is unknown rather than freezing it", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1", "p2"])],
      blockRects: rects({
        p1: { top: 0, left: 40, width: 400, height: 80 },
        // 実測に幅が無い (計測を取り逃した) ときは、追従する側に倒す。
        p2: { top: 100 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "p1",
    });

    expect(cohort.followerBlockIds).toEqual(["p2"]);
  });

  it("moves a whole unit when every block in it follows, and then not its blocks", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1", "p2"]), unit("u2", ["q1", "q2"])],
      blockRects: rects({
        p1: { top: 0, left: 40, width: 400, height: 80 },
        p2: { top: 100, left: 40, width: 400, height: 80 },
        q1: { top: 200, left: 40, width: 400, height: 80 },
        q2: { top: 300, left: 40, width: 400, height: 80 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "p1",
    });

    // 問題枠・サイドノート・問題番号はユニットの殻が持つので、殻ごと動かす。
    expect(cohort.followerUnitIds).toEqual(["u2"]);
    // 殻が動くぶん、中身を二重に動かしてはいけない。
    expect(cohort.followerBlockIds).toEqual(["p2"]);
  });

  it("marks blocks individually when its unit only partly follows", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1"]), unit("u2", ["q1", "q2", "q3"])],
      blockRects: rects({
        p1: { top: 0, left: 40, width: 400, height: 80 },
        q1: { top: 100, left: 40, width: 400, height: 80 },
        q2: { top: 200, left: 40, width: 400, height: 80 },
        q3: { top: 300, left: 40, width: 400, height: 80 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "q1",
    });

    expect(cohort.followerUnitIds).toEqual([]);
    expect(cohort.followerBlockIds).toEqual(["q2", "q3"]);
  });

  it("returns nothing when the dragged block was never measured", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1", "p2"])],
      blockRects: singleColumnRects(["p1", "p2"]),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "ghost",
    });

    expect(cohort.followerUnitIds).toEqual([]);
    expect(cohort.followerBlockIds).toEqual([]);
  });

  it("follows an indented block below it (a quote is not another column)", () => {
    const cohort = resolveSpaceAfterPreviewCohort({
      units: [unit("u1", ["p1", "quote"])],
      blockRects: rects({
        p1: { top: 0, left: 40, width: 400, height: 80 },
        quote: { top: 100, left: 72, width: 336, height: 80 },
      }),
      pageStride: PAGE_STRIDE,
      draggedBlockId: "p1",
    });

    expect(cohort.followerBlockIds).toEqual(["quote"]);
  });
});
