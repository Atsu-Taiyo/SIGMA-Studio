import { describe, expect, it } from "vitest";

import {
  filterTextFlowCommandDefinitions,
  parseTextFlowCommandTrigger,
  textFlowCommandNameMatchRank,
  type TextFlowCommandDefinition,
} from "./command-query";

const definitions: TextFlowCommandDefinition[] = [
  {
    id: "fancy",
    commandName: "fancybox",
    displayName: "囲み枠",
    description: "本文を枠で囲む",
    aliases: ["frame", "枠"],
  },
  {
    id: "note",
    commandName: "notebox",
    displayName: "ノート",
    description: "補足を書く",
    aliases: ["memo", "メモ"],
  },
  {
    id: "fullwidth",
    commandName: "ＦＵＬＬ",
    displayName: "全角",
    description: "全角英字の定義",
    aliases: ["ＷＩＤＥ"],
  },
  {
    id: "theorem",
    commandName: "theorem",
    displayName: "定理",
    description: "証明する命題",
    aliases: ["proof"],
  },
];

describe("parseTextFlowCommandTrigger", () => {
  it("accepts slash commands only at the start of a text block", () => {
    expect(parseTextFlowCommandTrigger("/")).toEqual({
      query: "",
      triggerLength: 1,
    });
    expect(parseTextFlowCommandTrigger("  /fancybox")).toEqual({
      query: "fancybox",
      triggerLength: 9,
    });
    expect(parseTextFlowCommandTrigger("／図形")).toEqual({
      query: "図形",
      triggerLength: 3,
    });
    expect(parseTextFlowCommandTrigger("本文/fancybox")).toBeNull();
    expect(parseTextFlowCommandTrigger("/fancybox test")).toBeNull();
    expect(parseTextFlowCommandTrigger("@公式")).toBeNull();
  });

  it("does not include accepted leading whitespace in the replacement length", () => {
    expect(parseTextFlowCommandTrigger("\t  ／abc")).toEqual({
      query: "abc",
      triggerLength: 4,
    });
  });
});

describe("filterTextFlowCommandDefinitions", () => {
  it("preserves definition order and applies the limit for an empty query", () => {
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "",
      limit: 2,
    }).map(({ id }) => id)).toEqual(["fancy", "note"]);
  });

  it("filters allowed ids without adopting allowed-id order", () => {
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "",
      allowedIds: ["theorem", "fancy"],
      limit: 6,
    }).map(({ id }) => id)).toEqual(["fancy", "theorem"]);
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "",
      allowedIds: [],
      limit: 6,
    })).toEqual([]);
  });

  it("matches every searchable field with NFKC and case normalization", () => {
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "ＦＡＮ",
      limit: 6,
    }).map(({ id }) => id)).toEqual(["fancy"]);
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "ノート",
      limit: 6,
    }).map(({ id }) => id)).toEqual(["note"]);
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "命題",
      limit: 6,
    }).map(({ id }) => id)).toEqual(["theorem"]);
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "wide",
      limit: 6,
    }).map(({ id }) => id)).toEqual(["fullwidth"]);
  });

  it("ranks a name that starts with the query above one matched by an alias", () => {
    // `/引用` は引用ブロック (名前そのもの) が先、「引用」を別名に持つ箱 (leftbar) が後。
    expect(textFlowCommandNameMatchRank("引用", "引用")).toBe(0);
    expect(textFlowCommandNameMatchRank("leftbar", "引用")).toBe(1);
    // 前方一致であって完全一致ではない (打ちかけでも先頭に来る)。
    expect(textFlowCommandNameMatchRank("fancybox", "fan")).toBe(0);
    expect(textFlowCommandNameMatchRank("tcolorbox", "box")).toBe(1);
    // 絞り込みと同じ正規化 (全角・大小文字・前後の空白) で比べる。
    expect(textFlowCommandNameMatchRank("ＦＵＬＬ", "  full  ")).toBe(0);
    // 空のクエリでは順番を動かさない (全部同じ順位)。
    expect(textFlowCommandNameMatchRank("leftbar", "")).toBe(0);
  });

  it("trims the normalized query before matching", () => {
    expect(filterTextFlowCommandDefinitions(definitions, {
      query: "  ＦＵＬＬ  ",
      limit: 6,
    }).map(({ id }) => id)).toEqual(["fullwidth"]);
  });
});
