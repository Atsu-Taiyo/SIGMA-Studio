import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { SharedDocument } from "./shared-document";
import {
  decodeSyncMessage,
  syncStepOne,
  syncStepTwo,
  syncUpdate,
} from "./protocol";
import type { ObjectValue } from "./value";

function initial(): ObjectValue {
  return {
    version: "2.0",
    docId: "doc-1",
    metadata: { title: "教材" },
    content: [
      {
        id: "p1",
        type: "paragraph",
        children: [{ type: "text", text: "日本語の問題" }],
      },
      {
        id: "p2",
        type: "paragraph",
        children: [{ type: "text", text: "解説" }],
      },
    ],
    pageLayout: {
      overlay: {
        overlaySnapshot: {
          shapes: [
            {
              id: "shape1",
              type: "geo",
              x: 0,
              y: 0,
              rotation: 0,
              props: { color: "black", w: 100, h: 100 },
            },
          ],
          assets: {},
        },
      },
    },
  };
}
function replicas() {
  const a = new SharedDocument();
  a.initialize(initial(), { sharedDocumentId: "shared-1", epoch: 1 });
  return [a, new SharedDocument(a.snapshot())] as const;
}
function edit(
  doc: SharedDocument,
  change: (value: ReturnType<typeof initial>) => void,
) {
  const before = doc.project();
  const after = structuredClone(before);
  change(after);
  doc.change(before, after);
}
function paragraph(doc: ObjectValue, index = 0): ObjectValue {
  return (doc.content as ObjectValue[])[index];
}
function setText(doc: ObjectValue, text: string, index = 0) {
  paragraph(doc, index).children = [{ type: "text", text }];
}
function shapes(doc: ObjectValue): ObjectValue[] {
  return (
    ((doc.pageLayout as ObjectValue).overlay as ObjectValue)
      .overlaySnapshot as ObjectValue
  ).shapes as ObjectValue[];
}
function merge(a: SharedDocument, b: SharedDocument) {
  const first = a.snapshot(),
    second = b.snapshot();
  a.applyUpdate(second);
  b.applyUpdate(first);
  a.applyUpdate(second);
  b.applyUpdate(first);
  expect(a.project()).toEqual(b.project());
}

describe("shared document CRDT", () => {
  it("syncs comment recipient identities, preserves them on reply, and removes them on edit", () => {
    const [a, b] = replicas();
    const body: ObjectValue[] = [{ type: "text", text: "@共同編集者", mentionUserId: "recipient" }, { type: "text", text: " 確認をお願いします" }];
    edit(a, (value) => {
      value.comments = [{ id: "thread", anchor: { type: "block", blockId: "p1" }, messages: [{ id: "message", body }] }];
    });
    merge(a, b);
    const messages = (value: ObjectValue) => (value.comments as ObjectValue[])[0].messages as ObjectValue[];
    edit(b, (value) => { messages(value).push({ id: "reply", body: [{ type: "text", text: "確認しました" }] }); });
    edit(a, (value) => { setText(value, "更新した本文"); });
    merge(a, b);
    const reloaded = new SharedDocument(b.snapshot());
    expect(messages(reloaded.project())[0].body).toEqual(body);
    expect(messages(reloaded.project())).toHaveLength(2);
    edit(reloaded, (value) => { messages(value)[0].body = [{ type: "text", text: "宛先なし" }]; });
    merge(a, reloaded);
    expect(messages(new SharedDocument(a.snapshot()).project())[0].body).toEqual([{ type: "text", text: "宛先なし" }]);
  });
  it("merges table-cell text, problem solution, graph labels, and page settings independently after reload", () => {
    const value = initial();
    (value.content as ObjectValue[]).push({
      id: "problem1",
      type: "problem",
      prompt: [],
      solution: [
        {
          id: "solution1",
          type: "paragraph",
          children: [{ type: "text", text: "解説" }],
        },
      ],
    });
    shapes(value).push({
      id: "table1",
      type: "tableShape",
      x: 0,
      y: 0,
      props: {
        table: {
          cells: [
            {
              id: "cell1",
              rowId: "row1",
              columnId: "col1",
              content: [
                {
                  id: "cellP1",
                  type: "paragraph",
                  children: [{ type: "text", text: "cell" }],
                },
              ],
            },
          ],
        },
      },
    });
    shapes(value).push({
      id: "graph1",
      type: "graph2dShape",
      x: 10,
      y: 20,
      props: {
        labels: [{ id: "label1", text: "A" }],
        expressions: [{ id: "expr1", tex: "x^2" }],
      },
    });
    const a = new SharedDocument();
    a.initialize(value, { sharedDocumentId: "all-kinds", epoch: 1 });
    const b = new SharedDocument(a.snapshot());
    const cell = (doc: ObjectValue) =>
      (
        (
          ((shapes(doc)[1].props as ObjectValue).table as ObjectValue)
            .cells as ObjectValue[]
        )[0].content as ObjectValue[]
      )[0];
    edit(a, (doc) => {
      cell(doc).children = [{ type: "text", text: "Acell" }];
      (doc.pageLayout as ObjectValue).columns = 2;
    });
    edit(b, (doc) => {
      cell(doc).children = [{ type: "text", text: "cellB" }];
      (
        (doc.content as ObjectValue[])[2].solution as ObjectValue[]
      )[0].children = [{ type: "text", text: "新しい解説" }];
      ((shapes(doc)[2].props as ObjectValue).labels as ObjectValue[])[0].text =
        "B";
    });
    merge(a, b);
    const restored = new SharedDocument(a.snapshot()).project();
    expect(cell(restored).children).toEqual([{ type: "text", text: "AcellB" }]);
    expect((restored.pageLayout as ObjectValue).columns).toBe(2);
    expect(JSON.stringify(restored)).toContain("新しい解説");
    expect(
      ((shapes(restored)[2].props as ObjectValue).labels as ObjectValue[])[0]
        .text,
    ).toBe("B");
  });
  it("keeps resize dimensions together with position when transforms compete", () => {
    const [a, b] = replicas();
    edit(a, (doc) => {
      shapes(doc)[0].x = 100;
      (shapes(doc)[0].props as ObjectValue).w = 200;
    });
    edit(b, (doc) => {
      shapes(doc)[0].x = 20;
      (shapes(doc)[0].props as ObjectValue).w = 80;
    });
    merge(a, b);
    const shape = shapes(a.project())[0];
    expect([
      [100, 200],
      [20, 80],
    ]).toContainEqual([shape.x, (shape.props as ObjectValue).w]);
  });
  it("resolves edits of the same formula as one whole expression, without duplicate math ids", () => {
    const [a, b] = replicas();
    edit(a, (value) => {
      paragraph(value).children = [
        { type: "mathInline", id: "m1", tex: "x^2" },
      ];
    });
    merge(a, b);
    edit(a, (value) => {
      (paragraph(value).children as ObjectValue[])[0].tex = "x^3";
    });
    edit(b, (value) => {
      (paragraph(value).children as ObjectValue[])[0].tex = "\\\\frac{1}{x}";
    });
    merge(a, b);
    const nodes = paragraph(a.project()).children as ObjectValue[];
    expect(nodes).toHaveLength(1);
    expect(["x^3", "\\\\frac{1}{x}"]).toContain(nodes[0].tex);
    expect(new SharedDocument(a.snapshot()).project()).toEqual(a.project());
  });
  it("keeps range comments attached through remote insertion and reload", () => {
    const [a, b] = replicas();
    edit(a, (value) => {
      value.comments = [
        {
          id: "comment1",
          anchor: {
            type: "textRange",
            start: { blockId: "p1", offset: 1 },
            end: { blockId: "p1", offset: 3 },
            quote: "本語",
          },
          messages: [],
        },
      ];
    });
    merge(a, b);
    edit(b, (value) => setText(value, "追加日本語の問題"));
    merge(a, b);
    const comments = new SharedDocument(a.snapshot()).project()
      .comments as ObjectValue[];
    expect((comments[0].anchor as ObjectValue).start).toEqual({
      blockId: "p1",
      offset: 3,
    });
    expect((comments[0].anchor as ObjectValue).end).toEqual({
      blockId: "p1",
      offset: 5,
    });
  });
  it("has one initialized text fragment even when both users begin in an empty paragraph", () => {
    const a = new SharedDocument();
    const value = initial();
    (value.content as ObjectValue[])[0].children = [];
    a.initialize(value, { sharedDocumentId: "empty", epoch: 1 });
    const b = new SharedDocument(a.snapshot());
    edit(a, (doc) => setText(doc, "A"));
    edit(b, (doc) => setText(doc, "B"));
    merge(a, b);
    const text = (
      (a.project().content as ObjectValue[])[0].children as ObjectValue[]
    )
      .map((node) => node.text)
      .join("");
    expect([...text].sort().join("")).toBe("AB");
  });
  it("resolves cycles from concurrent nested moves with the same existing ids", () => {
    const value = initial();
    value.content = [
      { id: "a", type: "boxBlock", content: [] },
      { id: "b", type: "boxBlock", content: [] },
    ];
    const a = new SharedDocument();
    a.initialize(value, { sharedDocumentId: "tree", epoch: 1 });
    const b = new SharedDocument(a.snapshot());
    edit(a, (doc) => {
      const [first, second] = doc.content as ObjectValue[];
      second.content = [first];
      doc.content = [second];
    });
    edit(b, (doc) => {
      const [first, second] = doc.content as ObjectValue[];
      first.content = [second];
      doc.content = [first];
    });
    merge(a, b);
    const json = JSON.stringify(a.project());
    expect(json.match(/"id":"a"/g)).toHaveLength(1);
    expect(json.match(/"id":"b"/g)).toHaveLength(1);
  });
  it("roundtrips SigmaDoc and initializes once", () => {
    const [a] = replicas();
    expect(a.project()).toEqual(initial());
    expect(() =>
      a.initialize(initial(), { sharedDocumentId: "other", epoch: 1 }),
    ).toThrow("ALREADY_INITIALIZED");
    expect(new SharedDocument(a.snapshot()).project()).toEqual(initial());
    expect(a.getRichFragment("p1", "children")).toBeInstanceOf(Y.XmlFragment);
  });
  it("converges same-paragraph insertions with duplicate and reordered delivery", () => {
    const [a, b] = replicas();
    edit(a, (value) => setText(value, "新しい日本語の問題"));
    edit(b, (value) => setText(value, "日本語の問題です"));
    merge(a, b);
    expect(paragraph(a.project()).children).toEqual([
      { type: "text", text: "新しい日本語の問題です" },
    ]);
  });
  it("retains concurrent independent shape attributes and atomic position pairs", () => {
    const [a, b] = replicas();
    edit(a, (value) => {
      (shapes(value)[0].props as ObjectValue).color = "red";
    });
    edit(b, (value) => {
      shapes(value)[0].x = 10;
      shapes(value)[0].y = 20;
    });
    merge(a, b);
    expect(shapes(a.project())[0]).toMatchObject({
      x: 10,
      y: 20,
      props: { color: "red" },
    });
    edit(a, (value) => {
      shapes(value)[0].x = 30;
      shapes(value)[0].y = 40;
    });
    edit(b, (value) => {
      shapes(value)[0].x = 50;
      shapes(value)[0].y = 60;
    });
    merge(a, b);
    const shape = shapes(a.project())[0];
    expect([
      [30, 40],
      [50, 60],
    ]).toContainEqual([shape.x, shape.y]);
  });
  it("does not resurrect deleted entities when delayed edits arrive", () => {
    const [a, b] = replicas();
    edit(a, (value) => {
      (value.content as ObjectValue[]).shift();
    });
    edit(b, (value) => setText(value, "遅れて届く修正"));
    merge(a, b);
    expect(
      (a.project().content as ObjectValue[]).map((node) => node.id),
    ).toEqual(["p2"]);
  });
  it("resolves concurrent moves to one placement per ID", () => {
    const [a, b] = replicas();
    edit(a, (value) => {
      (value.content as ObjectValue[]).reverse();
    });
    edit(b, (value) => {
      (value.content as ObjectValue[]).push({
        id: "p3",
        type: "paragraph",
        children: [{ type: "text", text: "追加" }],
      });
    });
    merge(a, b);
    const ids = (a.project().content as ObjectValue[]).map((node) => node.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.sort()).toEqual(["p1", "p2", "p3"]);
  });
  it("preserves unicode, formatting, and atomic inline formulas", () => {
    const [a, b] = replicas();
    edit(a, (value) => {
      paragraph(value).children = [
        { type: "text", text: "😀問題", bold: true },
        { type: "mathInline", id: "m1", tex: "x^2" },
      ];
    });
    b.applyUpdate(a.snapshot());
    const before = a.project();
    edit(a, (value) => {
      (paragraph(value).children as ObjectValue[])[0].bold = false;
    });
    edit(b, (value) => {
      (paragraph(value).children as ObjectValue[])[1].tex = "x^3";
    });
    merge(a, b);
    expect(paragraph(a.project()).children).toEqual([
      { type: "text", text: "😀問題", bold: false },
      { type: "mathInline", id: "m1", tex: "x^3" },
    ]);
    expect(paragraph(before).children).not.toEqual(
      paragraph(a.project()).children,
    );
  });
  it("undoes only local edits while retaining received edits", () => {
    const [a, b] = replicas();
    const history = a.createUndoManager();
    edit(a, (value) => setText(value, "日本語の問題A"));
    edit(b, (value) => setText(value, "B日本語の問題"));
    merge(a, b);
    history.undo();
    merge(a, b);
    expect(paragraph(a.project()).children).toEqual([
      { type: "text", text: "B日本語の問題" },
    ]);
  });
  it("rejects an invalid update without poisoning the authoritative replica", () => {
    const [a, b] = replicas();
    b.doc.getMap("header").set("epoch", 99);
    expect(() => a.prepareUpdate(b.snapshot(), () => {})).toThrow(
      "DOCUMENT_IDENTITY_CHANGED",
    );
    expect(a.identity().epoch).toBe(1);
    expect(a.project()).toEqual(initial());
  });
  it("uses the standard Yjs sync protocol", () => {
    const [a, b] = replicas();
    edit(a, (value) => setText(value, "更新"));
    const vector = decodeSyncMessage(syncStepOne(b.doc));
    expect(vector.kind).toBe("vector");
    const response = decodeSyncMessage(syncStepTwo(a.doc, vector.bytes));
    b.applyUpdate(response.bytes);
    expect(b.project()).toEqual(a.project());
    expect(decodeSyncMessage(syncUpdate(response.bytes)).bytes).toEqual(
      response.bytes,
    );
  });
});
