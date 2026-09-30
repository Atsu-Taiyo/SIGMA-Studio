// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 本物の `<math-field>` は接続されるまで `.macros` が throw する ("Mathfield not mounted")。
 * その性質だけを持つ最小の偽物で、「画面外に立てて読み、すぐ外す」読み方を固定する。
 * MathLive の本物の標準マクロで描けることは `tests/e2e/editing-display-parity.spec.ts` が見る。
 */
const DEFAULTS = { iff: { args: 0, def: "\\;\\Longleftrightarrow\\;" }, pmod: { args: 1, def: "\\mod{#1}" } };
let constructed = 0;

class FakeMathField extends HTMLElement {
  constructor() {
    super();
    constructed += 1;
  }

  get macros() {
    if (!this.isConnected) throw new Error("Mathfield not mounted");
    return DEFAULTS;
  }
}

async function loadModule() {
  vi.resetModules();
  return import("@/lib/mathlive-default-macros");
}

describe("MathLive default macros for static rendering", () => {
  beforeEach(() => {
    constructed = 0;
    if (!customElements.get("math-field")) customElements.define("math-field", FakeMathField);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("layers Sigma/preamble macros over MathLive's defaults, custom winning on a name clash", async () => {
    const { withMathLiveDefaultMacros } = await loadModule();
    const custom = { doubleboxed: { args: 1, def: "\\boxed{#1}" }, pmod: { args: 1, def: "\\text{custom}" } };

    const merged = withMathLiveDefaultMacros(custom);

    expect(merged.iff).toEqual(DEFAULTS.iff);
    expect(merged.doubleboxed).toEqual(custom.doubleboxed);
    expect(merged.pmod).toEqual(custom.pmod);
  });

  it("mounts a field only once, off screen, and leaves nothing behind", async () => {
    const { withMathLiveDefaultMacros } = await loadModule();

    withMathLiveDefaultMacros({});
    withMathLiveDefaultMacros({ a: "b" });
    withMathLiveDefaultMacros({ c: "d" });

    expect(constructed).toBe(1);
    expect(document.body.children).toHaveLength(0);
  });

  it("returns the same merged dictionary for the same custom macros", async () => {
    const { withMathLiveDefaultMacros } = await loadModule();
    const custom = { a: "b" };

    expect(withMathLiveDefaultMacros(custom)).toBe(withMathLiveDefaultMacros(custom));
  });

  it("falls back to the custom macros alone when the field cannot be read", async () => {
    const original = Object.getOwnPropertyDescriptor(FakeMathField.prototype, "macros")!;
    Object.defineProperty(FakeMathField.prototype, "macros", { configurable: true, get() { throw new Error("Mathfield not mounted"); } });
    try {
      const { withMathLiveDefaultMacros } = await loadModule();
      const custom = { a: "b" };

      expect(withMathLiveDefaultMacros(custom)).toEqual(custom);
      expect(document.body.children).toHaveLength(0);
    } finally {
      Object.defineProperty(FakeMathField.prototype, "macros", original);
    }
  });
});

describe("without a DOM (Node tests, SSR, Electron main)", () => {
  it("passes the custom macros through untouched and does not settle on an empty table", async () => {
    vi.stubGlobal("document", undefined);
    try {
      const { readMathLiveDefaultMacros, withMathLiveDefaultMacros } = await loadModule();
      const custom = { a: "b" };

      expect(readMathLiveDefaultMacros()).toBeNull();
      expect(withMathLiveDefaultMacros(custom)).toBe(custom);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
