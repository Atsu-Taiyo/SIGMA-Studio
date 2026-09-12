import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookState = vi.hoisted(() => ({
  callIndex: 0,
  values: [] as unknown[],
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useMemo: <Value,>(factory: () => Value) => factory(),
    useState: <Value,>(initialValue: Value) => {
      const index = hookState.callIndex++;
      if (hookState.values[index] === undefined) {
        hookState.values[index] = initialValue;
      }
      const setValue = (next: Value | ((current: Value) => Value)) => {
        const current = hookState.values[index] as Value;
        hookState.values[index] = typeof next === "function"
          ? (next as (value: Value) => Value)(current)
          : next;
      };
      return [hookState.values[index] as Value, setValue] as const;
    },
  };
});

// この spec はコンポーネントを関数として直接呼び、react の hook を差し替えて
// 適用失敗時の描画だけを見る。`useT` は `useSyncExternalStore` を使うので、実物のままだと
// レンダラの外で dispatcher が null になって落ちる。翻訳はこの spec の関心ではない。
vi.mock("@/lib/i18n/react", async () => {
  const { createTranslator } = await vi.importActual<typeof import("@/lib/i18n")>("@/lib/i18n");
  return { useT: (namespace: string) => createTranslator("ja", namespace as "ai") };
});

import {
  AiEditInlinePreviewCard,
  type AiEditInlinePreviewEntry,
} from "./AiEditInlinePreviewCard";

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement<Record<string, unknown>>(node)) {
    return null;
  }
  if (predicate(node)) {
    return node;
  }
  for (const child of Children.toArray(node.props.children as ReactNode)) {
    const found = findElement(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

describe("AiEditInlinePreviewCard apply failure", () => {
  beforeEach(() => {
    hookState.callIndex = 0;
    hookState.values = [];
  });

  it("closes the preview without applying or discarding the proposal", () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const props = {
      entries: [{
        kind: "operation" as const,
        draft: {
          operation: "replace" as const,
          summary: "本文を書き換え",
          targetId: "p1",
          replacementBlock: { id: "p1", type: "paragraph" as const, children: [] },
        },
        operationIndex: 0,
        operationCount: 1,
        sessionSummary: "本文を書き換えます",
      }],
      providers: ["chatgpt" as const],
      applying: false,
      onApply,
      onDismiss,
    };
    const card = AiEditInlinePreviewCard(props);
    const close = findElement(card, (element) => element.props["aria-label"] === "閉じる");
    expect(close).not.toBeNull();
    (close!.props.onClick as () => void)();
    hookState.callIndex = 0;
    expect(AiEditInlinePreviewCard(props)).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("renders the failed reason beside the actions and keeps the inline card pending", async () => {
    const reason = "別の操作が完了してから、もう一度お試しください";
    const entries: AiEditInlinePreviewEntry[] = [{
      kind: "operation",
      draft: {
        operation: "replace",
        summary: "本文を書き換え",
        targetId: "p1",
        replacementBlock: {
          id: "p1",
          type: "paragraph",
          children: [{ type: "text", text: "書き換え後" }],
        },
      },
      operationIndex: 0,
      operationCount: 1,
      sessionSummary: "本文を書き換えます",
    }];
    const onApply = vi.fn(async () => ({ ok: false as const, reason }));
    const props = {
      entries,
      providers: ["chatgpt" as const],
      applying: false,
      onApply,
    };

    const firstRender = AiEditInlinePreviewCard(props);
    const applyActions = findElement(
      firstRender,
      (element) => element.props.className === "ai-inline-preview-actions",
    );
    expect(applyActions).not.toBeNull();

    (applyActions?.props.onApply as (() => void) | undefined)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onApply).toHaveBeenCalledOnce();
    expect(hookState.values[0]).toBe(reason);

    hookState.callIndex = 0;
    const failedRender = AiEditInlinePreviewCard(props);
    const error = findElement(
      failedRender,
      (element) => element.type === "p" && element.props.className === "ai-chat-error",
    );
    expect(error?.props.children).toBe(reason);
    expect(findElement(
      failedRender,
      (element) => element.type === "section" && element.props.className === "ai-inline-preview-dialog",
    )).not.toBeNull();
    expect(findElement(
      failedRender,
      (element) => element.props.className === "ai-inline-preview-actions",
    )).not.toBeNull();
  });
});
