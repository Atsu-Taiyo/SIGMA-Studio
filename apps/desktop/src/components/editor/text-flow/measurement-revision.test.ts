// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { acknowledgeTextFlowContent, expectTextFlowContent, isTextFlowMeasurementReady, TEXT_FLOW_MEASUREMENT_READY } from "./measurement-revision";

describe("measurement revision acknowledgement", () => {
  it("rejects old content indefinitely and announces the applied revision without polling", () => {
    const flow = document.createElement("div");
    flow.innerHTML = '<div class="ProseMirror"></div>';
    const root = flow.firstElementChild as HTMLElement;
    const ready = vi.fn();
    flow.addEventListener(TEXT_FLOW_MEASUREMENT_READY, ready);
    expectTextFlowContent(root, "before");
    acknowledgeTextFlowContent(root, "before");
    expect(isTextFlowMeasurementReady(flow)).toBe(true);
    expectTextFlowContent(root, "after");
    for (let attempt = 0; attempt < 100; attempt++) expect(isTextFlowMeasurementReady(flow)).toBe(false);
    acknowledgeTextFlowContent(root, "after");
    expect(isTextFlowMeasurementReady(flow)).toBe(true);
    acknowledgeTextFlowContent(root, "after");
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("waits for the matching React commit when input updates the source DOM first", () => {
    const flow = document.createElement("div");
    flow.innerHTML = '<div class="ProseMirror"></div><div class="ProseMirror"></div>';
    const [first, second] = Array.from(flow.children) as HTMLElement[];
    for (const root of [first, second]) {
      expectTextFlowContent(root, "old"); acknowledgeTextFlowContent(root, "old");
    }
    acknowledgeTextFlowContent(first, "input");
    expect(isTextFlowMeasurementReady(flow)).toBe(false);
    expectTextFlowContent(first, "input");
    expect(isTextFlowMeasurementReady(flow)).toBe(true);
    // A detached editor cannot block its successor's layout.
    expectTextFlowContent(second, "unapplied");
    second.remove();
    expect(isTextFlowMeasurementReady(flow)).toBe(true);
  });
});
