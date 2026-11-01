import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createRichFragment, patchRichFragment, readRichFragment } from "./rich-text";
import type { ObjectValue } from "./value";

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "あいうえおかきくけこ一二三abc ";

function randomRun(next: () => number, length: number): ObjectValue[] {
  const nodes: ObjectValue[] = [];
  for (let index = 0; index < length; index++) {
    if (next() < 0.08) {
      nodes.push({ type: "mathInline", id: `m_${Math.floor(next() * 4)}`, tex: next() < 0.5 ? "x^2" : "\\frac{1}{2}" });
      continue;
    }
    const text = ALPHABET[Math.floor(next() * ALPHABET.length)]!;
    const marks: ObjectValue = next() < 0.2 ? { marks: ["bold"] } : {};
    const previous = nodes.at(-1);
    if (previous?.type === "text" && JSON.stringify(previous.marks ?? null) === JSON.stringify(marks.marks ?? null)) {
      previous.text = `${previous.text}${text}`;
    } else nodes.push({ type: "text", text, ...marks });
  }
  return nodes;
}

/** `nodes` with a few random replacements, insertions and deletions. */
function edited(next: () => number, nodes: ObjectValue[]): ObjectValue[] {
  const result = structuredClone(nodes);
  const edits = 1 + Math.floor(next() * 4);
  for (let count = 0; count < edits; count++) {
    const at = Math.floor(next() * (result.length + 1));
    const kind = next();
    if (kind < 0.4) result.splice(at, 0, ...randomRun(next, 1 + Math.floor(next() * 3)));
    else if (kind < 0.7) result.splice(at, 1);
    else if (result[at]?.type === "text") result[at] = { ...result[at], marks: ["italic"] };
  }
  return result;
}

function patch(before: ObjectValue[], after: ObjectValue[]): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = createRichFragment(before);
  doc.getMap("root").set("fragment", fragment);
  patchRichFragment(fragment, after);
  return { doc, fragment };
}

function normalized(nodes: ObjectValue[]): ObjectValue[] {
  // Adjacent text with the same formatting is one run once read back.
  const result: ObjectValue[] = [];
  for (const node of nodes) {
    const previous = result.at(-1);
    if (node.type === "text" && previous?.type === "text") {
      const { text: _text, ...format } = node;
      const { text: _previousText, ...previousFormat } = previous;
      void _text;
      void _previousText;
      if (JSON.stringify(format) === JSON.stringify(previousFormat)) {
        previous.text = `${previous.text}${node.text}`;
        continue;
      }
    }
    if (node.type === "text" && node.text === "") continue;
    result.push(structuredClone(node));
  }
  return result;
}

describe("patchRichFragment", () => {
  it("reads back exactly the patched run for random edits (formulas, formatting, insertions and deletions)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const before = randomRun(next, 5 + Math.floor(next() * 40));
      const after = edited(next, before);
      const { doc, fragment } = patch(before, after);
      // Compared per character and format: Yjs may keep one formatted run as two parts.
      expect(normalized(readRichFragment(fragment)), `seed ${seed}`).toEqual(normalized(after));
      doc.destroy();
    }
  });

  it("falls back to one replaced interval when the runs differ too much, and still reads back the target", () => {
    const next = random(7);
    const before = randomRun(next, 900);
    const after = randomRun(next, 900);
    const { doc, fragment } = patch(before, after);
    expect(normalized(readRichFragment(fragment))).toEqual(normalized(after));
    doc.destroy();
  });

  it("keeps the characters between two edits as the same CRDT items", () => {
    const doc = new Y.Doc();
    const fragment = createRichFragment([{ type: "text", text: "一二三四五六七八九十" }]);
    doc.getMap("root").set("fragment", fragment);
    const text = fragment.get(0) as Y.XmlText;
    const middle = Y.createRelativePositionFromTypeIndex(text, 5);
    patchRichFragment(fragment, [{ type: "text", text: "壱二三四五六七八九拾" }]);
    expect(readRichFragment(fragment)).toEqual([{ type: "text", text: "壱二三四五六七八九拾" }]);
    expect(Y.createAbsolutePositionFromRelativePosition(middle, doc)?.index).toBe(5);
    doc.destroy();
  });
});

it("preserves an empty formatted run through encoding, remote patching and undo", () => {
  const a = new Y.Doc(), b = new Y.Doc();
  const nodes: ObjectValue[] = [{ type: "text", text: "", fontSize: 18, fontFamily: "monospace" }];
  const fragment = createRichFragment(nodes);
  a.getMap().set("body", fragment);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const remote = b.getMap().get("body") as Y.XmlFragment;
  expect(readRichFragment(remote)).toEqual(nodes);
  const undo = new Y.UndoManager(fragment);
  patchRichFragment(fragment, [{ ...nodes[0], fontSize: 10 }]);
  expect(readRichFragment(fragment)).toEqual([{ ...nodes[0], fontSize: 10 }]);
  undo.undo();
  expect(readRichFragment(fragment)).toEqual(nodes);
  undo.redo();
  expect(readRichFragment(fragment)).toEqual([{ ...nodes[0], fontSize: 10 }]);
  patchRichFragment(fragment, [{ type: "text", text: "入力", fontSize: 10 }]);
  expect(readRichFragment(fragment)).toEqual([{ type: "text", text: "入力", fontSize: 10 }]);
  patchRichFragment(fragment, []);
  expect(readRichFragment(fragment)).toEqual([]);
  a.destroy(); b.destroy();
});
