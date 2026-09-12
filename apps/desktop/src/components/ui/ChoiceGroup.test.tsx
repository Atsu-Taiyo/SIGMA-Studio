// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartColumn, ChartLine, ChartPie, ChartScatter } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChoiceGroup } from "./ChoiceGroup";

const OPTIONS = [
  { value: "bar", label: "棒グラフ", icon: ChartColumn },
  { value: "line", label: "折れ線グラフ", icon: ChartLine },
  { value: "pie", label: "円グラフ", icon: ChartPie },
  { value: "scatter", label: "散布図", icon: ChartScatter },
] as const;

let container: HTMLDivElement;
let root: Root;
let changes: string[];

// createRoot + act をテスト環境として使うことを React に伝える (React 18 以降の要求)。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(value: string) {
  act(() => {
    root.render(
      <ChoiceGroup
        aria-label="種類"
        columns={4}
        onChange={(next) => changes.push(next)}
        options={OPTIONS}
        value={value}
      />,
    );
  });
}

function radios(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
}

/**
 * `cancelable: true` matters: a non-cancelable event makes `preventDefault()` a no-op, so every
 * assertion about it would hold even with the calls deleted. The event is returned so callers can
 * check whether the component consumed the key.
 */
function press(key: string, from = document.activeElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    from?.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  changes = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ChoiceGroup semantics", () => {
  it("exposes the group as a radiogroup with its accessible name", () => {
    render("bar");
    const group = container.querySelector('[role="radiogroup"]');

    expect(group?.getAttribute("aria-label")).toBe("種類");
  });

  it("renders one radio per option", () => {
    render("bar");

    expect(radios()).toHaveLength(4);
  });

  it("names each radio by its label", () => {
    render("bar");

    expect(radios().map((radio) => radio.textContent)).toEqual([
      "棒グラフ",
      "折れ線グラフ",
      "円グラフ",
      "散布図",
    ]);
  });

  it("keeps the icon out of the accessible name", () => {
    // Without `aria-hidden` the SVG's own content joins the radio's name, and `textContent`
    // assertions would never notice.
    render("bar");

    expect(radios().map((radio) => radio.querySelector("svg")?.getAttribute("aria-hidden")))
      .toEqual(["true", "true", "true", "true"]);
  });

  it("checks only the selected option", () => {
    render("pie");

    expect(radios().map((radio) => radio.getAttribute("aria-checked")))
      .toEqual(["false", "false", "true", "false"]);
  });

  it("marks the selected option for the stylesheet without relying on colour alone", () => {
    render("pie");

    expect(radios().map((radio) => radio.getAttribute("data-selected")))
      .toEqual([null, null, "true", null]);
  });

  it("keeps every option out of the tab order except the selected one", () => {
    render("line");

    expect(radios().map((radio) => radio.getAttribute("tabindex")))
      .toEqual(["-1", "0", "-1", "-1"]);
  });

  it("puts the first option in the tab order when the value matches nothing", () => {
    // An empty group would be a keyboard trap: tabbing in has to land somewhere.
    render("unknown");

    expect(radios().map((radio) => radio.getAttribute("tabindex")))
      .toEqual(["0", "-1", "-1", "-1"]);
  });
});

describe("ChoiceGroup pointer selection", () => {
  it("reports the option that was clicked", () => {
    render("bar");
    act(() => radios()[2].click());

    expect(changes).toEqual(["pie"]);
  });

  it("does not report a change when the selected option is clicked again", () => {
    render("bar");
    act(() => radios()[0].click());

    expect(changes).toEqual([]);
  });
});

describe("ChoiceGroup keyboard selection", () => {
  it("moves to the next option and selects it immediately", () => {
    render("bar");
    act(() => radios()[0].focus());
    press("ArrowRight");

    expect(changes).toEqual(["line"]);
  });

  it("moves to the previous option", () => {
    render("line");
    act(() => radios()[1].focus());
    press("ArrowLeft");

    expect(changes).toEqual(["bar"]);
  });

  it("treats down as forward", () => {
    render("bar");
    act(() => radios()[0].focus());
    press("ArrowDown");

    expect(changes).toEqual(["line"]);
  });

  it("treats up as backward", () => {
    render("line");
    act(() => radios()[1].focus());
    press("ArrowUp");

    expect(changes).toEqual(["bar"]);
  });

  it("wraps forward from the last option", () => {
    render("scatter");
    act(() => radios()[3].focus());
    press("ArrowRight");

    expect(changes).toEqual(["bar"]);
  });

  it("wraps backward from the first option", () => {
    render("bar");
    act(() => radios()[0].focus());
    press("ArrowLeft");

    expect(changes).toEqual(["scatter"]);
  });

  it("jumps to the first option with Home", () => {
    render("pie");
    act(() => radios()[2].focus());
    press("Home");

    expect(changes).toEqual(["bar"]);
  });

  it("jumps to the last option with End", () => {
    render("bar");
    act(() => radios()[0].focus());
    press("End");

    expect(changes).toEqual(["scatter"]);
  });

  it("moves focus with the selection", () => {
    render("bar");
    act(() => radios()[0].focus());
    press("ArrowRight");

    expect(document.activeElement).toBe(radios()[1]);
  });

  it("selects the focused option with Space", () => {
    render("bar");
    act(() => radios()[2].focus());
    press(" ");

    expect(changes).toEqual(["pie"]);
  });

  it("selects the focused option with Enter", () => {
    render("bar");
    act(() => radios()[3].focus());
    press("Enter");

    expect(changes).toEqual(["scatter"]);
  });

  it("ignores keys it does not handle", () => {
    render("bar");
    act(() => radios()[0].focus());

    expect(press("Tab").defaultPrevented).toBe(false);
  });

  it("consumes the keys it handles, so the panel underneath does not scroll", () => {
    render("bar");
    act(() => radios()[0].focus());

    expect(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End", " ", "Enter"]
      .map((key) => press(key, radios()[0]).defaultPrevented))
      .toEqual([true, true, true, true, true, true, true, true]);
  });

  it("does nothing when there is nothing to choose between", () => {
    // `% options.length` on an empty list is NaN, which would focus nothing and select undefined.
    act(() => {
      root.render(
        <ChoiceGroup aria-label="種類" onChange={(next) => changes.push(next)} options={[]} value="" />,
      );
    });
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]');
    act(() => {
      group?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });

    expect([radios().length, changes]).toEqual([0, []]);
  });
});

describe("ChoiceGroup naming and layout contract", () => {
  it("can take its accessible name from a caption elsewhere in the panel", () => {
    act(() => {
      root.render(
        <>
          <span id="kind-caption">種類</span>
          <ChoiceGroup
            aria-labelledby="kind-caption"
            onChange={() => {}}
            options={OPTIONS}
            value="bar"
          />
        </>,
      );
    });
    const group = container.querySelector('[role="radiogroup"]');

    expect(group?.getAttribute("aria-labelledby")).toBe("kind-caption");
  });

  it("announces the orientation its arrow keys read as", () => {
    render("bar");

    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-orientation"))
      .toBe("horizontal");
  });

  it("does not collapse on viewport width, since it lives on fixed-width panels", () => {
    render("bar");

    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("data-responsive"))
      .toBe("false");
  });
});
