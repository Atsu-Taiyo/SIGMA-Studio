// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLocale } from "./locale";

const STORAGE_KEY = "sigma-studio:ui-locale";

let mod: typeof import("./react");
let store: typeof import("./locale-store");
let container: HTMLDivElement;
let root: Root;

/** happy-dom は localStorage を持たないので、ストアが読む最小限だけを置く。 */
function installLocalStorage(): void {
  const entries = new Map<string, string>();
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

/**
 * ロケールを確定させてからモジュールを読み込む。boot はモジュール副作用なので、
 * import より前に localStorage を仕込まないと検出結果 (happy-dom は en-US) が勝つ。
 */
async function load(stored?: AppLocale): Promise<void> {
  if (stored) {
    window.localStorage.setItem(STORAGE_KEY, stored);
  }
  vi.resetModules();
  mod = await import("./react");
  store = await import("./locale-store");
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  installLocalStorage();
  document.documentElement.lang = "ja";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(node: ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
}

function textOf(testId: string): string | undefined {
  return container.querySelector(`[data-testid='${testId}']`)?.textContent ?? undefined;
}

describe("useT", () => {
  it("renders the Japanese string when Japanese is selected", async () => {
    await load("ja");
    function Probe() {
      const t = mod.useT("common");
      return <span data-testid="label">{t("actions.cancel")}</span>;
    }
    await render(<Probe />);
    expect(textOf("label")).toBe("キャンセル");
  });

  it("follows the browser locale when nothing is stored", async () => {
    // happy-dom reports en-US, which is exactly the CI/Linux situation the
    // Playwright locale pin exists to neutralise.
    await load();
    function Probe() {
      const t = mod.useT("common");
      return <span data-testid="label">{t("actions.cancel")}</span>;
    }
    await render(<Probe />);
    expect(textOf("label")).toBe("Cancel");
  });

  it("re-renders exactly once when the locale changes", async () => {
    await load("ja");
    const renders: string[] = [];
    function Probe() {
      const t = mod.useT("common");
      renders.push(t("actions.cancel"));
      return <span data-testid="label">{t("actions.cancel")}</span>;
    }
    await render(<Probe />);
    expect(renders).toEqual(["キャンセル"]);

    await act(async () => {
      store.setAppLocale("en");
    });
    expect(renders).toEqual(["キャンセル", "Cancel"]);
    expect(textOf("label")).toBe("Cancel");
  });

  it("keeps the same t reference across re-renders within one locale", async () => {
    await load("ja");
    const seen: unknown[] = [];
    function Probe({ tick }: { tick: number }) {
      const t = mod.useT("common");
      seen.push(t);
      return <span data-testid="label">{tick}</span>;
    }
    await render(<Probe tick={0} />);
    await render(<Probe tick={1} />);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("resolves a non-default namespace", async () => {
    await load("ja");
    function Probe() {
      const t = mod.useT("settings");
      return <span data-testid="label">{t("language.title")}</span>;
    }
    await render(<Probe />);
    expect(textOf("label")).toBe("言語");
  });

  it("defaults to the common namespace", async () => {
    await load("ja");
    function Probe() {
      const t = mod.useT();
      return <span data-testid="label">{t("actions.save")}</span>;
    }
    await render(<Probe />);
    expect(textOf("label")).toBe("保存");
  });
});

describe("hydration", () => {
  it("renders Japanese first so the static export markup matches, then switches", async () => {
    // `output: "export"` の HTML はビルド時に日本語で焼かれる。英語環境でも最初の
    // クライアント描画が日本語でなければハイドレーション不一致になり、React が
    // console.error を出してサブツリーを描き直す。
    await load();
    expect(store.getAppLocale()).toBe("en");

    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");

    function Probe() {
      const t = mod.useT("common");
      return <span data-testid="label">{t("actions.cancel")}</span>;
    }

    const serverHtml = renderToString(<Probe />);
    expect(serverHtml).toContain("キャンセル");

    const hydrationContainer = window.document.createElement("div");
    hydrationContainer.innerHTML = serverHtml;
    window.document.body.append(hydrationContainer);

    const errors: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    let hydrated: Root | undefined;
    await act(async () => {
      hydrated = hydrateRoot(hydrationContainer, <Probe />);
    });

    expect(errors).toEqual([]);
    expect(hydrationContainer.querySelector("[data-testid='label']")?.textContent).toBe("Cancel");

    consoleError.mockRestore();
    await act(async () => {
      hydrated?.unmount();
    });
    hydrationContainer.remove();
  });
});

describe("useAppLocale", () => {
  it("reports the current locale and follows changes", async () => {
    await load("ja");
    function Probe() {
      return <span data-testid="locale">{mod.useAppLocale()}</span>;
    }
    await render(<Probe />);
    expect(textOf("locale")).toBe("ja");

    await act(async () => {
      store.setAppLocale("en");
    });
    expect(textOf("locale")).toBe("en");
  });
});

describe("setAppLocale", () => {
  it("does not touch the document language (that is AppDocumentLanguage's job)", async () => {
    // SDK 組み込みではホストページの <html> を共有しているので、ここで書き換えると
    // エディタを埋め込んだだけでホストの言語指定を塗り替えることになる。
    await load("ja");
    document.documentElement.lang = "en";
    await act(async () => {
      store.setAppLocale("ja");
    });
    expect(document.documentElement.lang).toBe("en");
  });

  it("is re-exported from the React entry point for UI callers", async () => {
    await load("ja");
    expect(mod.setAppLocale).toBe(store.setAppLocale);
  });
});
