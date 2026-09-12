// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let AppDocumentLanguage: typeof import("./AppDocumentLanguage").AppDocumentLanguage;
let store: typeof import("@/lib/i18n/locale-store");
let container: HTMLDivElement;
let root: Root;

/** happy-dom は localStorage を持たないので、ロケールストアが読む最小限だけを置く。 */
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

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  installLocalStorage();
  // `app/layout.tsx` が焼く初期値を再現する。
  document.documentElement.lang = "ja";
  vi.resetModules();
  ({ AppDocumentLanguage } = await import("./AppDocumentLanguage"));
  store = await import("@/lib/i18n/locale-store");
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

describe("AppDocumentLanguage", () => {
  it("adopts the resolved locale on mount", async () => {
    // happy-dom は en-US を申告するので、保存値が無ければ英語に解決される。
    expect(store.getAppLocale()).toBe("en");
    await render(<AppDocumentLanguage />);
    expect(document.documentElement.lang).toBe("en");
  });

  it("follows a language change without a reload", async () => {
    await render(<AppDocumentLanguage />);
    await act(async () => {
      store.setAppLocale("ja");
    });
    expect(document.documentElement.lang).toBe("ja");
  });

  it("renders nothing", async () => {
    await render(<AppDocumentLanguage />);
    expect(container.innerHTML).toBe("");
  });

  it("leaves the document alone until it is mounted", async () => {
    // SDK 組み込みはこの layout を通らないので、ホストページの <html lang> は
    // モジュールを読み込んだだけでは変わらない。
    store.setAppLocale("ja");
    expect(document.documentElement.lang).toBe("ja");
    store.setAppLocale("en");
    expect(document.documentElement.lang).toBe("ja");
  });
});
