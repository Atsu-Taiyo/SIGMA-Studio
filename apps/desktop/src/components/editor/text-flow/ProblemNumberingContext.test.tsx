// @vitest-environment happy-dom
import { act, memo } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProblemNumberingProvider, useProblemNumbers } from "./ProblemNumberingContext";

it("refreshes text surfaces only when their document numbering changes", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onRender = vi.fn();
  const Consumer = memo(function Consumer() {
    onRender();
    const numbers = useProblemNumbers();
    return <span>{numbers.get("problem")}</span>;
  });
  const view = (number: number) => <ProblemNumberingProvider numbers={new Map([["problem", number]])}><Consumer /></ProblemNumberingProvider>;
  try {
    act(() => root.render(view(1)));
    act(() => root.render(view(1)));
    expect(onRender).toHaveBeenCalledTimes(1);
    act(() => root.render(view(2)));
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("2");
  } finally {
    act(() => root.unmount());
  }
});
