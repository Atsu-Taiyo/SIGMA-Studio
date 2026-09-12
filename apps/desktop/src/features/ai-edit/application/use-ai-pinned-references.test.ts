import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import type { AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import type { SigmaDocument } from "@/types/sigma-doc";

const reactRuntime = vi.hoisted(() => ({
  stateIndex: 0,
  refIndex: 0,
  states: [] as Array<{ value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
}));

vi.mock("react", () => ({
  useCallback: <Value,>(value: Value) => value,
  useRef: <Value,>(initialValue: Value) => {
    const index = reactRuntime.refIndex++;
    if (!reactRuntime.refs[index]) {
      reactRuntime.refs[index] = { current: initialValue };
    }
    return reactRuntime.refs[index];
  },
  useState: <Value,>(initialValue: Value | (() => Value)) => {
    const index = reactRuntime.stateIndex++;
    if (!reactRuntime.states[index]) {
      reactRuntime.states[index] = {
        value: typeof initialValue === "function"
          ? (initialValue as () => Value)()
          : initialValue,
      };
    }
    const setValue = (nextValue: Value | ((current: Value) => Value)) => {
      const current = reactRuntime.states[index].value as Value;
      reactRuntime.states[index].value = typeof nextValue === "function"
        ? (nextValue as (value: Value) => Value)(current)
        : nextValue;
    };
    return [reactRuntime.states[index].value as Value, setValue] as const;
  },
}));

import { useAiPinnedReferences } from "./use-ai-pinned-references";

function blockReference(targetId: string): AiEditReference {
  return {
    kind: "block",
    targetId,
    targetType: "paragraph",
    excerpt: targetId,
  };
}

function textSelectionReference(): AiEditReference {
  return {
    kind: "textSelection",
    targetId: "paragraph-1",
    targetType: "paragraph",
    excerpt: "固定した本文",
    selectedText: "固定した本文",
    mathTex: [],
    textRange: {
      type: "textRange",
      start: { blockId: "paragraph-1", offset: 0 },
      end: { blockId: "paragraph-1", offset: 6 },
      quote: "固定した本文",
    },
  };
}

function documentWithParagraphText(text: string): SigmaDocument {
  return {
    version: "2.0",
    docId: "pinned-reference-hook-test",
    metadata: { title: "pin参照" },
    content: [{
      id: "paragraph-1",
      type: "paragraph",
      children: [{ type: "text", text }],
    }],
    outputProfiles: {},
  } as SigmaDocument;
}

function renderController() {
  reactRuntime.stateIndex = 0;
  reactRuntime.refIndex = 0;
  // The mocked hook runtime deliberately renders the hook without a DOM component.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAiPinnedReferences();
}

describe("useAiPinnedReferences", () => {
  beforeEach(() => {
    reactRuntime.stateIndex = 0;
    reactRuntime.refIndex = 0;
    reactRuntime.states.length = 0;
    reactRuntime.refs.length = 0;
  });

  it("uses its synchronous reference source for consecutive pins in one render", () => {
    const controller = renderController();
    const first = blockReference("paragraph-1");
    const second = blockReference("paragraph-2");

    expect(controller.pin(first).outcome).toBe("added");
    expect(controller.pin(second).outcome).toBe("added");

    expect(renderController().references).toEqual([first, second]);
  });

  it("does not replace the first preview when the same reference is pinned again", () => {
    const controller = renderController();
    const reference = blockReference("paragraph-1");
    const firstPreview: AiEditShapeOnlyPreview = { svg: "<svg>first</svg>", width: 100, height: 80 };
    const laterPreview: AiEditShapeOnlyPreview = { svg: "<svg>later</svg>", width: 200, height: 160 };

    expect(controller.pin(reference, firstPreview).outcome).toBe("added");
    expect(controller.pin(reference, laterPreview).outcome).toBe("duplicate");

    const rerendered = renderController();
    expect([...rerendered.previews.values()]).toEqual([firstPreview]);
  });

  it("invalidates only the stale text range when the referenced block changes", () => {
    const controller = renderController();
    const reference = textSelectionReference();
    controller.pin(reference);

    const pinned = renderController();
    pinned.reconcileTextRanges(
      documentWithParagraphText("固定した本文"),
      pinned.references,
    );
    pinned.reconcileTextRanges(
      documentWithParagraphText("編集された本文"),
      pinned.references,
    );

    expect(renderController().references).toEqual([{
      ...reference,
      textRange: undefined,
    }]);
  });
});
