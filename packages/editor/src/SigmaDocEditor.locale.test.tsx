import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SigmaDocument } from "@sigma-studio/viewer";

import { getAppLocale, setAppLocale } from "@sigma-studio/editor-internal/i18n";

import { SigmaDocEditor } from "./SigmaDocEditor";

/** エディタが実際に使っている表示言語。 */
function currentLocale(): string {
  return getAppLocale();
}

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

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

beforeEach(() => {
  installLocalStorage();
  setAppLocale("ja");
});

afterEach(async () => {
  await act(async () => {
    for (const { container, root } of mountedRoots.splice(0)) {
      root.unmount();
      container.remove();
    }
  });
});

async function renderEditor(node: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  await act(async () => {
    root.render(node);
  });
  return container;
}

function editorWith(locale?: "ja" | "en"): ReactElement {
  return <SigmaDocEditor document={createDocument()} onChange={() => {}} locale={locale} />;
}

describe("SigmaDocEditor locale", () => {
  it("switches the editor UI language when the host passes a locale", async () => {
    await renderEditor(editorWith("en"));
    expect(currentLocale()).toBe("en");
  });

  it("switches again when the host changes the prop", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ container, root });
    await act(async () => {
      root.render(editorWith("en"));
    });
    expect(currentLocale()).toBe("en");
    await act(async () => {
      root.render(editorWith("ja"));
    });
    expect(currentLocale()).toBe("ja");
  });

  it("leaves the host locale alone when no locale prop is given", async () => {
    // 未指定は「エディタ内部の検出・永続化に任せる」の意味。既に決まっている
    // ロケールを日本語へ押し戻してはいけない。
    setAppLocale("en");
    await renderEditor(editorWith());
    expect(currentLocale()).toBe("en");
  });

  it("never rewrites the host page's document language", async () => {
    // ホストページの <html lang> はホストのもの。エディタを埋め込んだだけで
    // ページ全体の言語指定が変わるのは越権。
    document.documentElement.lang = "fr";
    await renderEditor(editorWith("en"));
    expect(document.documentElement.lang).toBe("fr");
  });
});

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "sdk_editor_locale_test",
    metadata: { title: "微積分教材" },
    content: [
      {
        type: "paragraph",
        id: "paragraph_1",
        children: [{ type: "text", text: "次の積分を計算しなさい。" }],
      },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true },
      answerBook: {
        onlySolutions: true,
        showSolutions: true,
        showHints: false,
        includeAnswers: true,
      },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}
