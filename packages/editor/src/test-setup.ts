/**
 * happy-dom は `localStorage` を持たず、`navigator.language` は "en-US" を申告する。
 * エディタは保存値が無ければブラウザロケールに従うので、何もしないと SDK のテストが
 * 英語 UI を相手にしてしまう。デスクトップの既定と同じ日本語に固定する
 * (ロケール自体を検証するテストは、自前で localStorage を差し替える)。
 */
{
  const entries = new Map<string, string>([["sigma-studio:ui-locale", "ja"]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string): string | null => entries.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        entries.set(key, value);
      },
      removeItem: (key: string): void => {
        entries.delete(key);
      },
      clear: (): void => {
        entries.clear();
      },
    },
  });
}

if (!document.doctype) {
  document.insertBefore(
    document.implementation.createDocumentType("html", "", ""),
    document.documentElement,
  );
}

if (document.compatMode !== "CSS1Compat") {
  Object.defineProperty(document, "compatMode", { value: "CSS1Compat" });
}

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

Object.assign(globalThis, {
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: TestIntersectionObserver,
});

HTMLElement.prototype.scrollIntoView = () => undefined;
