// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { SNAPSHOT_PDF_FLOW_SOURCE } from "./pdf-flow-snapshot";

const snapshot = new Function(`return ${SNAPSHOT_PDF_FLOW_SOURCE};`)() as (doc: Document) => void;
afterEach(() => document.body.replaceChildren());

describe("settled PDF flow coordinates", () => {
  it.each([1, 3])("preserves outer number frames and inner text with %i page columns", columns => {
    const flow = document.createElement("div");
    flow.className = "page-flow";
    document.body.append(flow);
    const units = Array.from({ length: 4 }, (_, index) => {
      const unit = document.createElement("section");
      // Off-page clones deliberately have no data-flow-unit-id. They still
      // participate in natural flow before the paper window clips them.
      if (index === 3) unit.dataset.flowUnitId = "next-problem";
      unit.innerHTML = '<span class="problem-number-marker">2</span><div class="ProseMirror"><p>本文</p></div>';
      unit.style.top = `${Math.floor(index / columns) * 1158.515625}px`;
      unit.style.left = `${(index % columns) * 220.125}px`;
      flow.append(unit);
      return unit;
    });
    const number = (value: string) => Number.parseFloat(value) || 0;
    units.forEach((unit, index) => {
      const root = unit.querySelector<HTMLElement>(".ProseMirror")!;
      const paragraph = root.firstElementChild as HTMLElement;
      const marker = unit.querySelector<HTMLElement>(".problem-number-marker")!;
      const frozen = () => paragraph.style.position === "absolute";
      // Model the two browser effects of removing in-flow paragraphs: a unit's
      // intrinsic height shrinks, and successive collapsed margins change.
      unit.getBoundingClientRect = () => {
        const previousLoss = units.slice(0, index).reduce((loss, previous) => {
          const p = previous.querySelector<HTMLElement>("p")!;
          return loss + (p.style.position === "absolute" && !previous.style.height ? 12 : 0);
        }, 0);
        const collapsedMarginLoss = units.slice(0, index).filter(previous => previous.querySelector<HTMLElement>("p")!.style.position === "absolute").length * 2;
        return new DOMRect(20 + number(unit.style.left), 10 + index * 80 + number(unit.style.top) - previousLoss - collapsedMarginLoss,
          200.25, unit.style.height ? number(unit.style.height) : 60.375 - (frozen() ? 12 : 0));
      };
      marker.getBoundingClientRect = () => {
        const rect = unit.getBoundingClientRect();
        return new DOMRect(rect.left, rect.top + 8.125, 30, 30);
      };
      root.getBoundingClientRect = () => {
        const rect = unit.getBoundingClientRect();
        return new DOMRect(rect.left + 40 + number(root.style.left), rect.top + 8.125 + number(root.style.top) + (frozen() ? 4 : 0), 160.25, 28.375);
      };
      paragraph.getBoundingClientRect = () => {
        const rect = root.getBoundingClientRect();
        return new DOMRect(rect.left, rect.top, 160.25, 28.375);
      };
    });
    const targets = Array.from(flow.querySelectorAll<HTMLElement>("section, .problem-number-marker, .ProseMirror, p"));
    const bounds = () => targets.map(element => {
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height];
    });
    const before = bounds();
    snapshot(document);
    expect(bounds()).toEqual(before);
    // A second snapshot of the same inert output also preserves its coordinates.
    snapshot(document);
    expect(bounds()).toEqual(before);
  });

  it("does not assign boxes to undrawn flow children", () => {
    document.body.innerHTML = '<div class="page-flow"><section style="display: none"></section></div>';
    const unit = document.querySelector<HTMLElement>("section")!;
    snapshot(document);
    expect(unit.style.cssText).toBe("display: none;");
  });
});
