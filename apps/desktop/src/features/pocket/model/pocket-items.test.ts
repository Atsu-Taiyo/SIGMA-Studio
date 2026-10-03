import { describe, expect, it } from "vitest";

import type { ParagraphNode } from "@/features/document";
import {
  createTextFlowClipboardPayload,
  EDITOR_CLIPBOARD_MIME,
  getEditorClipboardPlainText,
  serializeEditorClipboardPayload,
} from "@/lib/editor-clipboard";

import {
  addPocketItem,
  createPocketItem,
  normalizePocketClipboardBag,
  POCKET_MAX_ITEMS,
  POCKET_MAX_ITEM_SIZE,
  POCKET_MAX_TOTAL_SIZE,
  pocketTotalSize,
  removePocketItems,
  restorePocketItems,
  type PocketItem,
} from "./pocket-items";

function textBag(text: string): Record<string, string> {
  return { "text/plain": text };
}

function blocksBag(text: string): Record<string, string> {
  const block: ParagraphNode = { type: "paragraph", id: `p_${text}`, children: [{ type: "text", text }] };
  const payload = createTextFlowClipboardPayload([block]);
  return {
    [EDITOR_CLIPBOARD_MIME]: serializeEditorClipboardPayload(payload),
    "text/plain": getEditorClipboardPlainText(payload),
  };
}

function fill(count: number): PocketItem[] {
  let items: readonly PocketItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const outcome = addPocketItem(items, textBag(`item ${index}`), { id: `i${index}`, addedAt: index });
    if (!outcome.ok) throw new Error(`could not add item ${index}: ${outcome.reason}`);
    items = outcome.items;
  }
  return [...items];
}

describe("normalizePocketClipboardBag", () => {
  it("keeps only the types a copy writes and drops empty values", () => {
    expect(normalizePocketClipboardBag({
      "text/plain": "文字",
      "text/html": "",
      "text/uri-list": "https://example.com",
      "application/x-sigma-studio": "{}",
    })).toEqual({ "text/plain": "文字", "application/x-sigma-studio": "{}" });
  });
});

describe("createPocketItem", () => {
  it("builds a previewed item that keeps the clip verbatim", () => {
    const bag = blocksBag("本文");
    const item = createPocketItem(bag, { id: "i1", addedAt: 5 });

    expect(item).toMatchObject({ id: "i1", addedAt: 5, preview: { kind: "blocks", blockCount: 1 }, clip: bag });
    expect(item?.size).toBe(Object.values(bag).reduce((total, value) => total + value.length, 0));
  });

  it("returns null when the copy produced nothing to show", () => {
    expect(createPocketItem({}, { id: "i1", addedAt: 0 })).toBeNull();
  });
});

describe("addPocketItem", () => {
  it("appends to the end so existing cards keep their places", () => {
    const first = addPocketItem([], textBag("一"), { id: "i1", addedAt: 1 });
    if (!first.ok) throw new Error("add failed");
    const second = addPocketItem(first.items, textBag("二"), { id: "i2", addedAt: 2 });
    if (!second.ok) throw new Error("add failed");

    expect(second.items.map((item) => item.id)).toEqual(["i1", "i2"]);
  });

  it("refuses an empty copy", () => {
    expect(addPocketItem([], {}, { id: "i1", addedAt: 0 })).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses the 31st item instead of dropping an older one", () => {
    const items = fill(POCKET_MAX_ITEMS);

    expect(addPocketItem(items, textBag("あふれる"), { id: "extra", addedAt: 99 })).toEqual({ ok: false, reason: "full" });
    expect(items).toHaveLength(POCKET_MAX_ITEMS);
  });

  it("refuses one item that is larger than a single card may be", () => {
    const outcome = addPocketItem([], textBag("あ".repeat(POCKET_MAX_ITEM_SIZE + 1)), { id: "big", addedAt: 0 });

    expect(outcome).toEqual({ ok: false, reason: "tooLarge" });
  });

  it("refuses an item that would push the pocket past its memory budget", () => {
    const chunk = POCKET_MAX_ITEM_SIZE - 10;
    let items: readonly PocketItem[] = [];
    let index = 0;
    while (pocketTotalSize(items) + chunk <= POCKET_MAX_TOTAL_SIZE) {
      const outcome = addPocketItem(items, textBag("あ".repeat(chunk)), { id: `big${index}`, addedAt: index });
      if (!outcome.ok) throw new Error(`unexpected refusal: ${outcome.reason}`);
      items = outcome.items;
      index += 1;
    }

    expect(addPocketItem(items, textBag("あ".repeat(chunk)), { id: "over", addedAt: 99 })).toEqual({ ok: false, reason: "full" });
  });
});

describe("removePocketItems / restorePocketItems", () => {
  it("removes by id and remembers where each item was", () => {
    const items = fill(4);
    const { items: kept, removed } = removePocketItems(items, new Set(["i1", "i3"]));

    expect(kept.map((item) => item.id)).toEqual(["i0", "i2"]);
    expect(removed.map(({ item, index }) => [item.id, index])).toEqual([["i1", 1], ["i3", 3]]);
  });

  it("returns the same list when nothing matched", () => {
    const items = fill(2);

    expect(removePocketItems(items, new Set(["missing"])).items).toBe(items);
  });

  it("restores removed items to their original positions", () => {
    const items = fill(5);
    const { items: kept, removed } = removePocketItems(items, new Set(["i0", "i2", "i4"]));

    expect(restorePocketItems(kept, removed).map((item) => item.id)).toEqual(["i0", "i1", "i2", "i3", "i4"]);
  });

  it("restores into a pocket that changed meanwhile without duplicating", () => {
    const items = fill(3);
    const { items: kept, removed } = removePocketItems(items, new Set(["i1"]));
    const added = addPocketItem(kept, textBag("あとから"), { id: "late", addedAt: 9 });
    if (!added.ok) throw new Error("add failed");

    const restored = restorePocketItems(added.items, removed);
    expect(restored.map((item) => item.id)).toEqual(["i0", "i1", "i2", "late"]);
    // 取り消しを 2 回押しても増えない。
    expect(restorePocketItems(restored, removed)).toBe(restored);
  });

  it("never restores past the item limit", () => {
    const items = fill(POCKET_MAX_ITEMS);
    const { items: kept, removed } = removePocketItems(items, new Set(["i0"]));
    const added = addPocketItem(kept, textBag("埋める"), { id: "late", addedAt: 9 });
    if (!added.ok) throw new Error("add failed");

    expect(restorePocketItems(added.items, removed)).toBe(added.items);
  });
});
