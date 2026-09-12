import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import {
  createTextFlowHistoryGroupingState,
  groupTextFlowTransaction,
  TEXT_FLOW_HISTORY_GROUP_DELAY_MS,
} from "./history-grouping";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
});

function createState(text = ""): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, text ? [schema.text(text)] : []),
    ]),
  });
}

describe("text-flow history grouping", () => {
  it("groups adjacent typing within the standard 500 ms window", () => {
    const firstState = createState();
    const firstTransaction = firstState.tr.insertText("a", 1).setTime(1_000);
    const first = groupTextFlowTransaction(
      createTextFlowHistoryGroupingState(),
      firstTransaction,
    );
    const secondState = firstState.apply(firstTransaction);
    const secondTransaction = secondState.tr.insertText("b", 2).setTime(
      1_000 + TEXT_FLOW_HISTORY_GROUP_DELAY_MS,
    );
    const second = groupTextFlowTransaction(first.state, secondTransaction);

    expect(first.group).toBe(1);
    expect(second.group).toBe(first.group);
  });

  it("starts a new group after the standard typing pause", () => {
    const firstState = createState();
    const firstTransaction = firstState.tr.insertText("a", 1).setTime(1_000);
    const first = groupTextFlowTransaction(
      createTextFlowHistoryGroupingState(),
      firstTransaction,
    );
    const secondState = firstState.apply(firstTransaction);
    const secondTransaction = secondState.tr.insertText("b", 2).setTime(
      1_001 + TEXT_FLOW_HISTORY_GROUP_DELAY_MS,
    );
    const second = groupTextFlowTransaction(first.state, secondTransaction);

    expect(second.group).toBe(first.group + 1);
  });

  it("starts a new group for a non-adjacent edit without waiting", () => {
    const firstState = createState("abcd");
    const firstTransaction = firstState.tr.insertText("x", 2).setTime(1_000);
    const first = groupTextFlowTransaction(
      createTextFlowHistoryGroupingState(),
      firstTransaction,
    );
    const secondState = firstState.apply(firstTransaction);
    const secondTransaction = secondState.tr.insertText("y", 6).setTime(1_100);
    const second = groupTextFlowTransaction(first.state, secondTransaction);

    expect(second.group).toBe(first.group + 1);
  });

  it("keeps one IME composition together across the delay", () => {
    const firstState = createState();
    const firstTransaction = firstState.tr
      .insertText("あ", 1)
      .setMeta("composition", 7)
      .setTime(1_000);
    const first = groupTextFlowTransaction(
      createTextFlowHistoryGroupingState(),
      firstTransaction,
    );
    const secondState = firstState.apply(firstTransaction);
    const secondTransaction = secondState.tr
      .insertText("い", 2)
      .setMeta("composition", 7)
      .setTime(2_000);
    const second = groupTextFlowTransaction(first.state, secondTransaction);

    expect(second.group).toBe(first.group);
  });
});
