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
  it("separates each paste from adjacent typing and other pastes inside 500 ms", () => {
    let state = createState();
    let grouping = createTextFlowHistoryGroupingState();
    const groups: number[] = [];
    for (const [index, kind] of ["typing", "paste", "paste", "typing", "typing"].entries()) {
      const transaction = state.tr.insertText("x", state.doc.content.size - 1).setTime(1_000 + index * 10);
      if (kind === "paste") transaction.setMeta("uiEvent", "paste");
      const result = groupTextFlowTransaction(grouping, transaction);
      groups.push(result.group);
      grouping = result.state;
      state = state.apply(transaction);
    }
    expect(groups).toEqual([1, 2, 3, 4, 4]);
  });

  it("keeps appended paste normalization in the same step and closes it before typing", () => {
    const state = createState();
    const paste = state.tr.insertText("a", 1).setMeta("uiEvent", "paste").setTime(1_000);
    const pasted = groupTextFlowTransaction(createTextFlowHistoryGroupingState(), paste);
    const afterPaste = state.apply(paste);
    const normalize = afterPaste.tr.insertText("b", 2).setMeta("appendedTransaction", paste).setTime(1_010);
    const normalized = groupTextFlowTransaction(pasted.state, normalize);
    const typed = groupTextFlowTransaction(normalized.state, afterPaste.apply(normalize).tr.insertText("c", 3).setTime(1_020));

    expect(normalized.group).toBe(pasted.group);
    expect(typed.group).toBe(pasted.group + 1);
  });

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
