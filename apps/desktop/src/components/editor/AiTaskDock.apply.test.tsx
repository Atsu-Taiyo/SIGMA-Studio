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

import { AiTaskDockRow, type TaskRow } from "./AiTaskDock";

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

describe("AiTaskDockRow apply failure", () => {
  beforeEach(() => {
    hookState.callIndex = 0;
    hookState.values = [];
  });

  it("renders the failed reason in the proposal row and leaves its apply affordance pending", async () => {
    const reason = "編集案を適用できませんでした";
    const row: TaskRow = {
      key: "proposal-1",
      roomId: "room-1",
      runId: null,
      provider: "chatgpt",
      status: "proposal",
      label: "本文を修正",
      anchorExcerpt: "元の本文",
      proposalIds: ["proposal-1"],
      revertibleProposalIds: [],
      restorableProposalId: null,
    };
    const onApplyGroup = vi.fn(async () => ({ ok: false as const, reason }));
    const props = {
      row,
      busy: false,
      onApplyGroup,
      onDismissGroup: vi.fn(),
      onRebaseGroup: vi.fn(async () => ({ ok: true as const })),
      onRevertProposal: vi.fn(),
    };

    const firstRender = AiTaskDockRow(props);
    const applyButton = findElement(
      firstRender,
      (element) => element.props.decision === "apply",
    );
    expect(applyButton).not.toBeNull();

    (applyButton?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onApplyGroup).toHaveBeenCalledWith(["proposal-1"]);
    expect(hookState.values[6]).toBe(reason);

    hookState.callIndex = 0;
    const failedRender = AiTaskDockRow(props);
    const error = findElement(
      failedRender,
      (element) => (
        element.type === "p"
        && element.props.className === "ai-chat-error ai-task-dock-error"
      ),
    );
    expect(error?.props.children).toBe(reason);
    expect(findElement(
      failedRender,
      (element) => element.props.decision === "apply",
    )).not.toBeNull();
  });
});
