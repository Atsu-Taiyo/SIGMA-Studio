// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n/react";
import { WhiteboardBackgroundControl } from "./WhiteboardBackgroundControl";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setAppLocale("ja");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  setAppLocale("ja");
  container.remove();
});

function radios(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

async function press(key: string): Promise<void> {
  await act(async () => {
    (document.activeElement ?? radios()[0]).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}

function markup(background: "grid" | "dots" | "none") {
  return renderToStaticMarkup(
    <WhiteboardBackgroundControl value={background} onChange={vi.fn()} />,
  );
}

describe("WhiteboardBackgroundControl", () => {
  it("offers the three grounds as one labelled radio group", () => {
    const html = markup("dots");

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="キャンバスの背景"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
  });

  it("labels every choice in Japanese", () => {
    const html = markup("dots");

    expect(html).toContain('aria-label="方眼"');
    expect(html).toContain('aria-label="点"');
    expect(html).toContain('aria-label="背景なし"');
  });

  it("switches every accessible label with the app locale", async () => {
    await act(async () => {
      root.render(<WhiteboardBackgroundControl value="dots" onChange={vi.fn()} />);
    });
    await act(async () => setAppLocale("en"));

    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Canvas background");
    expect(radios().map((radio) => radio.getAttribute("aria-label"))).toEqual(["Grid", "Dots", "No background"]);
  });

  it("checks exactly the current ground", () => {
    for (const value of ["grid", "dots", "none"] as const) {
      const html = markup(value);
      expect(html.match(/aria-checked="true"/g), value).toHaveLength(1);
      expect(html.match(/aria-checked="false"/g), value).toHaveLength(2);
    }
  });

  it("reuses the floating zoom-pill styling instead of inventing a new one", () => {
    // 視覚言語はズームピルと共有する (globals.css で両クラスを並べている)。
    // ただし識別クラスは分ける — 同じクラスにすると `.whiteboard-zoom-controls` を
    // 指している既存のテストやスタイルが、どちらのピルか区別できなくなる。
    expect(markup("grid")).toContain('class="whiteboard-background-controls"');
    expect(markup("grid")).not.toContain("whiteboard-zoom-controls");
  });

  it("keeps exactly one stop in the tab order", () => {
    // radiogroup は「Tab で 1 回、あとは矢印」が約束。3 つとも Tab で拾えてはいけない。
    const html = markup("dots");

    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it("moves the selection with the arrow keys and wraps around", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<WhiteboardBackgroundControl value="dots" onChange={onChange} />);
    });

    radios()[1].focus();
    await press("ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("none");

    await press("ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("grid");
  });

  it("jumps to the ends with Home and End", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<WhiteboardBackgroundControl value="dots" onChange={onChange} />);
    });

    radios()[1].focus();
    await press("End");
    expect(onChange).toHaveBeenLastCalledWith("none");

    await press("Home");
    expect(onChange).toHaveBeenLastCalledWith("grid");
  });

  it("wraps from the last choice back to the first", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<WhiteboardBackgroundControl value="none" onChange={onChange} />);
    });

    radios()[2].focus();
    await press("ArrowRight");

    expect(onChange).toHaveBeenLastCalledWith("grid");
  });
});
