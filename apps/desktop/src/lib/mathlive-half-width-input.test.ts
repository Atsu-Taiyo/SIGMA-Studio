// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { installMathLiveHalfWidthInput } from "./mathlive-half-width-input";

/** MathLive の入力欄の代わり。sink に付く MathLive 自身の受け口 (`event.data` を読む) を真似る。 */
function mountMathField() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const sink = document.createElement("span");
  sink.className = "ML__keyboard-sink";
  const other = document.createElement("span");
  root.append(sink, other);
  const seen: string[] = [];
  const mathLive = (event: Event) => seen.push((event as InputEvent | CompositionEvent).data ?? "");
  sink.addEventListener("input", mathLive);
  sink.addEventListener("compositionend", mathLive, { capture: true });
  other.addEventListener("input", mathLive);
  other.addEventListener("compositionend", mathLive);
  return { other, root, seen, sink };
}

// happy-dom は InputEventInit / CompositionEventInit の一部を持たないので、足りない値を直接載せる。
function inputEvent(data: string, init: { inputType?: string; isComposing?: boolean } = {}) {
  const event = new InputEvent("input", { bubbles: true, composed: true, data });
  for (const [name, value] of Object.entries({ data, inputType: "insertText", ...init })) {
    if ((event as unknown as Record<string, unknown>)[name] !== value) Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

function compositionEnd(data: string) {
  const event = new CompositionEvent("compositionend", { bubbles: true, composed: true, data });
  if (event.data !== data) Object.defineProperty(event, "data", { configurable: true, value: data });
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("installMathLiveHalfWidthInput", () => {
  it("hands MathLive half-width text for a full-width direct input", () => {
    const { root, seen, sink } = mountMathField();
    installMathLiveHalfWidthInput(root);

    sink.dispatchEvent(inputEvent("ｘ＋１"));
    sink.dispatchEvent(inputEvent("　"));

    expect(seen).toEqual(["x+1", " "]);
  });

  it("hands MathLive half-width text for a committed composition", () => {
    const { root, seen, sink } = mountMathField();
    installMathLiveHalfWidthInput(root);

    sink.dispatchEvent(compositionEnd("（ａ－ｂ）＝０"));

    expect(seen).toEqual(["(a-b)=0"]);
  });

  it("keeps kana and kanji, and converts only the full-width ASCII around them", () => {
    const { root, seen, sink } = mountMathField();
    installMathLiveHalfWidthInput(root);

    sink.dispatchEvent(compositionEnd("漢字"));
    sink.dispatchEvent(compositionEnd("傾きｍ"));
    sink.dispatchEvent(inputEvent("あ"));

    expect(seen).toEqual(["漢字", "傾きm", "あ"]);
  });

  it("does not touch text while a composition is in progress", () => {
    const { root, seen, sink } = mountMathField();
    installMathLiveHalfWidthInput(root);

    sink.dispatchEvent(inputEvent("ｘ", { inputType: "insertCompositionText", isComposing: true }));
    sink.dispatchEvent(inputEvent("ｘ", { isComposing: true }));
    sink.dispatchEvent(inputEvent("ｘ", { inputType: "insertFromPaste" }));

    expect(seen).toEqual(["ｘ", "ｘ", "ｘ"]);
  });

  it("leaves half-width input and events outside the keyboard sink alone", () => {
    const { other, root, seen, sink } = mountMathField();
    installMathLiveHalfWidthInput(root);

    sink.dispatchEvent(inputEvent("x"));
    sink.dispatchEvent(compositionEnd("+"));
    other.dispatchEvent(inputEvent("ｘ"));
    other.dispatchEvent(compositionEnd("ｘ"));

    expect(seen).toEqual(["x", "+", "ｘ", "ｘ"]);
  });

  it("installs once per shadow root", () => {
    const { root, seen, sink } = mountMathField();
    installMathLiveHalfWidthInput(root);
    installMathLiveHalfWidthInput(root);

    sink.dispatchEvent(inputEvent("ｘ"));

    expect(seen).toEqual(["x"]);
  });
});
