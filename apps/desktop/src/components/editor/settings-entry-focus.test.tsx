// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CommandSettingsDialog } from "./CommandSettingsDialog";
import { PageSettingsDialog } from "./PageSettingsDialog";
import { SETTINGS_ENTRIES, findSettingsEntry } from "./settings-catalog";

/**
 * `settings-catalog.test.ts` はソースに `id="..."` が**書いてあるか**しか見られない。
 * 書いてあっても折りたたみやタブの裏に居れば実際には描かれず、パレットのスクロール先は
 * 静かに見つからないままになる (code-review で実際に指摘された穴)。
 *
 * ここでは **本当にマウントして DOM に anchor が出るか**を確かめる。ブリッジを必要としない
 * ダイアログ (ショートカット設定・ページ設定) だけを対象にし、`focusEntryId` を渡したときの
 * 到達性を固定する。
 */

let container: HTMLDivElement;
let root: Root;

function installLocalStorage(): void {
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

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  installLocalStorage();
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

function commandDialog(focusEntryId?: string): ReactElement {
  return (
    <CommandSettingsDialog
      overrides={{}}
      customCommands={[]}
      fontFamilyOptions={[{ label: "M PLUS 1p", value: "'M PLUS 1p', sans-serif" }]}
      platform="mac"
      onChange={() => {}}
      onCustomCommandsChange={() => {}}
      onClose={() => {}}
      focusEntryId={focusEntryId}
    />
  );
}

function anchorOf(entryId: string): string {
  const anchorId = findSettingsEntry(entryId)?.anchorId;
  expect(anchorId, `${entryId} に anchorId が無い`).toBeTruthy();
  return anchorId ?? "";
}

describe("settings entry anchors actually render", () => {
  it("renders the shortcut table anchor", async () => {
    await render(commandDialog("settings.commands.shortcuts"));
    expect(document.getElementById(anchorOf("settings.commands.shortcuts"))).not.toBeNull();
  });

  it("opens the custom command panel so its anchor exists", async () => {
    // 既定では畳まれている面。`focusEntryId` を渡したときだけ開くのが仕様。
    await render(commandDialog("settings.commands.custom"));
    expect(document.getElementById(anchorOf("settings.commands.custom"))).not.toBeNull();
  });

  it("keeps the custom command panel collapsed without a focus entry", async () => {
    await render(commandDialog());
    expect(document.getElementById(anchorOf("settings.commands.custom"))).toBeNull();
  });

  it("renders every page setup anchor", async () => {
    await render(<PageSettingsDialog onClose={() => {}} onChange={() => {}} />);
    const missing = SETTINGS_ENTRIES
      .filter((entry) => entry.surface === "page" && entry.anchorId !== undefined)
      .filter((entry) => document.getElementById(entry.anchorId ?? "") === null)
      .map((entry) => `${entry.id} -> ${entry.anchorId ?? ""}`);
    expect(missing).toEqual([]);
  });
});
