import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import type { AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import { AiAppliedDocumentDiffView, buildAppliedDiffStats } from "./AiAppliedDocumentDiff";

describe("AiAppliedDocumentDiffView", () => {
  it("shows an unchanged context line plainly and wraps only the changed word in <mark>", () => {
    const diff: AiAppliedDocumentDiff = {
      body: [
        {
          change: "removed",
          block: { id: "p1", type: "paragraph", children: [{ type: "text", text: "変更前" }] },
        },
        {
          change: "added",
          block: { id: "p1", type: "paragraph", children: [{ type: "text", text: "変更後" }] },
        },
      ],
      shapes: [{
        change: "added",
        shape: {
          id: "shape_1",
          type: "geo",
          x: 0,
          y: 0,
          rotation: 0,
          props: {
            w: 120,
            h: 80,
            geo: "rectangle",
            fill: "none",
            color: "#111111",
            fillColor: "#ffffff",
            labelColor: "#111111",
            dash: "solid",
            size: "m",
          },
        },
      }],
    };
    const html = renderToStaticMarkup(<AiAppliedDocumentDiffView diff={diff} />);

    // 変更前/変更後は"変更"を共有する単語("変更"+"前"/"後")なので、共通の"変更"はcontextの
    // まま強調されず、"前"→"後"だけが<mark>で強調される。
    const markBlocks = [...html.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map((match) => match[1]);
    expect(markBlocks.length).toBeGreaterThan(0);
    expect(markBlocks.some((block) => block.includes("前"))).toBe(true);
    expect(markBlocks.some((block) => block.includes("後"))).toBe(true);
    expect(markBlocks.some((block) => block.includes("変更"))).toBe(false);
    expect(html).toContain("変更");
    expect(html).toContain("+1行");
    expect(html).toContain("−1行");
    expect(html).toContain("+1図形");
    expect(html).toContain('data-change="removed"');
    expect(html).toContain('data-change="added"');
  });

  it("returns null when the diff is empty", () => {
    const html = renderToStaticMarkup(<AiAppliedDocumentDiffView diff={{ body: [], shapes: [] }} />);
    expect(html).toBe("");
  });

  it("renders a quiet collapsed-row control for long unchanged runs", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: `item_${i}`,
      type: "listItem" as const,
      children: [{ type: "text" as const, text: i === 0 ? "変更前の行" : `共通行${i}` }],
    }));
    const changedItems = items.map((item, i) => (
      i === 0 ? { ...item, children: [{ type: "text" as const, text: "変更後の行" }] } : item
    ));
    const diff: AiAppliedDocumentDiff = {
      body: [
        { change: "removed", block: { id: "list_1", type: "list", listType: "bullet", items } },
        { change: "added", block: { id: "list_1", type: "list", listType: "bullet", items: changedItems } },
      ],
      shapes: [],
    };

    const html = renderToStaticMarkup(<AiAppliedDocumentDiffView diff={diff} />);
    expect(html).toContain("他4行は変更なし");
  });

  it("counts graph shapes separately from generic shapes", () => {
    const stats = buildAppliedDiffStats({
      body: [],
      shapes: [
        { change: "added", shape: { id: "graph_1", type: "graph2dShape" } as never },
        { change: "added", shape: { id: "shape_1", type: "geo" } as never },
      ],
    });

    // `noun` は**識別子**。集計キーと並び順に使うので、訳語ではなく id で固定する。
    expect(stats).toEqual([
      { change: "added", count: 1, noun: "graph" },
      { change: "added", count: 1, noun: "shape" },
    ]);
    // 画面に出る語は辞書側が持つ。id と表示の対応もここで一度押さえておく。
    const t = createTranslator("ja", "ai");
    expect(t("diff.noun.graph", { count: 1 })).toBe("グラフ");
    expect(t("diff.noun.shape", { count: 1 })).toBe("図形");
  });

  it("counts one line per leaf inline run, regardless of embedded line breaks", () => {
    // ネストしたリスト項目は「行」単位(親項目1行+子項目1行=2行)で数える。子項目のテキスト内の
    // 改行は同じ1行の中の折り返しであって、別の行としては数えない(GitHub風の構造的な行数)。
    const stats = buildAppliedDiffStats({
      body: [{
        change: "added",
        block: {
          id: "list_1",
          type: "list",
          listType: "bullet",
          items: [{
            id: "item_1",
            type: "listItem",
            children: [{ type: "text", text: "親項目" }],
            nested: [{
              id: "nested_list_1",
              type: "list",
              listType: "bullet",
              items: [{
                id: "nested_item_1",
                type: "listItem",
                children: [{ type: "text", text: "子項目1\n子項目2" }],
              }],
            }],
          }],
        },
      }],
      shapes: [],
    });

    expect(stats).toEqual([
      { change: "added", count: 2, noun: "line" },
    ]);
  });
});
