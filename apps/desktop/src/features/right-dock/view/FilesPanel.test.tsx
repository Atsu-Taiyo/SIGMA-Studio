// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import type { WorkspaceOverview } from "@/lib/runtime";
import type { DocumentMetadata } from "@/lib/storage";
import { FilesPanel } from "./FilesPanel";

const overview: WorkspaceOverview = {
  activeWorkspaceId: "w1",
  workspaces: [{ id: "w1", name: "マイ教材", createdAt: "", updatedAt: "" }],
  folders: [],
  files: [
    { fileId: "f1", folderId: null, title: "二次関数" },
    { fileId: "f2", folderId: null, title: "三角比" },
  ],
} as unknown as WorkspaceOverview;

vi.mock("@/lib/workspace-repository", () => ({
  listWorkspaceOverview: vi.fn(async () => ({ state: "ready", overview })),
}));
vi.mock("@/lib/runtime", () => ({
  getAppRuntime: () => ({ library: { onChange: () => () => {} } }),
}));

let root: Root;
let container: HTMLDivElement;

const documents = [
  { fileId: "f1", title: "二次関数", workspaceId: "w1" },
  { fileId: "f2", title: "三角比", workspaceId: "w1" },
] as unknown as DocumentMetadata[];

async function render() {
  await act(async () => {
    root.render(
      <FilesPanel documents={documents} activeFileId="f1" openFileIds={["f1"]} onOpenFile={vi.fn()} onOpenWorkspaces={vi.fn()} />,
    );
  });
}

const searchbox = () => container.querySelector<HTMLInputElement>('input[type="search"]');
const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label="教材を検索"]');
const closeButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="検索を閉じる"]');
const rows = () => [...container.querySelectorAll('[role="treeitem"]')].map((row) => row.getAttribute("aria-label"));

function type(input: HTMLInputElement, value: string) {
  act(() => {
    // React は value のネイティブ setter を経由した input イベントだけを onChange として扱う。
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function press(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FilesPanel search", () => {
  it("shows only a magnifier icon until it is pressed", async () => {
    await render();
    expect(searchbox()).toBeNull();
    expect(toggle()).not.toBeNull();
    expect(toggle()!.textContent).toBe("");
  });

  it("expands into a focused field and filters the list", async () => {
    await render();
    act(() => toggle()!.click());
    expect(searchbox()).not.toBeNull();
    expect(document.activeElement).toBe(searchbox());
    expect(closeButton()).not.toBeNull();

    type(searchbox()!, "三角");
    expect(rows()).toEqual(["「三角比」を開く"]);
  });

  it("clears the text on the first Escape, then folds back to the icon and returns focus to it", async () => {
    await render();
    act(() => toggle()!.click());
    type(searchbox()!, "三角");

    press(searchbox()!, "Escape");
    expect(searchbox()!.value).toBe("");
    expect(rows()).toHaveLength(2);

    press(searchbox()!, "Escape");
    expect(searchbox()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("stays open while a query is filtering, and folds back when it loses focus empty", async () => {
    await render();
    act(() => toggle()!.click());
    type(searchbox()!, "三角");
    act(() => searchbox()!.blur());
    expect(searchbox()).not.toBeNull();
    expect(rows()).toHaveLength(1);

    type(searchbox()!, "");
    act(() => searchbox()!.focus());
    act(() => searchbox()!.blur());
    expect(searchbox()).toBeNull();
  });

  it("clears the query and folds back from the close button", async () => {
    await render();
    act(() => toggle()!.click());
    type(searchbox()!, "三角");
    act(() => closeButton()!.click());
    expect(searchbox()).toBeNull();
    expect(rows()).toHaveLength(2);

    act(() => toggle()!.click());
    expect(searchbox()!.value).toBe("");
  });
});
