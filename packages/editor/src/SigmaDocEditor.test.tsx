import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SigmaDocument } from "@sigma-studio/viewer";

import {
  SigmaDocEditor,
  type SigmaDocEditorChange,
  type SigmaDocEditorHandle,
} from "./SigmaDocEditor";
import * as fontWarmup from "./embedded-font-warmup";

const mountedRoots: Array<{ container: HTMLDivElement; root: Root }> = [];

afterEach(async () => {
  await act(async () => {
    for (const { container, root } of mountedRoots.splice(0)) {
      root.unmount();
      container.remove();
    }
  });
  vi.restoreAllMocks();
});

describe("SigmaDocEditor", () => {
  it("uses the desktop editor UI and returns controlled SigmaDoc changes", async () => {
    const changes: SigmaDocEditorChange[] = [];
    const onSave = vi.fn<(document: SigmaDocument) => void>();

    function Host() {
      const [document, setDocument] = useState(createDocument());
      return (
        <SigmaDocEditor
          document={document}
          onChange={(next, change) => {
            changes.push(change);
            setDocument(next);
          }}
          onSave={onSave}
        />
      );
    }

    const { container } = await renderEditor(<Host />);
    expect(container.querySelector(".editor-menubar")).not.toBeNull();
    expect(container.querySelector("[aria-label='編集ツール']")).not.toBeNull();
    expect(container.querySelector(".sigma-studio-editor__mode-tabs")).toBeNull();
    expect(findButton(container, "AI")).toBeUndefined();
    expect(findButton(container, "サインイン")).toBeUndefined();
    expect(container.querySelector(".ai-sidebar-panel")).toBeNull();

    await changeValue(
      container.querySelector("input[aria-label='教材タイトル']"),
      "更新された微積分教材",
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: "$",
      source: "desktop-editor",
      document: { metadata: { title: "更新された微積分教材" } },
    });
    expect(container.querySelector(".save-state")?.classList.contains("saving")).toBe(false);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    });
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ title: "更新された微積分教材" }),
      }),
    );
  });

  it("exposes the latest complete desktop-editor document through the imperative handle", async () => {
    const editorRef: { current: SigmaDocEditorHandle | null } = {
      current: null,
    };
    const { container } = await renderEditor(
      <SigmaDocEditor
        editorRef={editorRef}
        document={createDocument()}
        onChange={() => undefined}
      />,
    );

    await changeValue(
      container.querySelector("input[aria-label='教材タイトル']"),
      "refで受け取る教材",
    );

    expect(editorRef.current?.getDocument().metadata.title).toBe(
      "refで受け取る教材",
    );
    expect(editorRef.current?.getDocument().version).toBe("2.0");
  });

  it("keeps comment editing and host saves available while AI mentions stay inert", async () => {
    const initial = createDocument();
    initial.comments = [{
      id: "thread-1",
      anchor: { type: "block", blockId: "paragraph_1" },
      messages: [{ id: "message-1", authorName: "あなた", body: [{ type: "text", text: "元のコメント" }], createdAt: "2026-09-09T00:00:00.000Z" }],
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    }];
    const changes: SigmaDocument[] = [];
    const onSave = vi.fn<(document: SigmaDocument) => void>();
    const editorRef: { current: SigmaDocEditorHandle | null } = { current: null };
    function Host() {
      const [document, setDocument] = useState(initial);
      return <SigmaDocEditor editorRef={editorRef} document={document} onSave={onSave} onChange={(next) => { changes.push(next); setDocument(next); }} />;
    }
    const { container } = await renderEditor(<Host />);
    const card = () => container.querySelector<HTMLElement>('[data-comment-card-key="thread-1"]')!;
    expect(card().textContent).toContain("元のコメント");
    await clickButton(card().querySelector<HTMLButtonElement>(".comment-reply-summary") ?? undefined);
    await setCommentText(card().querySelector(".comment-reply-composer .ProseMirror"), "@claude 返信を確認してください");
    await clickButton(findButton(card(), "返信"));
    expect(editorRef.current?.getDocument().comments?.[0].messages).toHaveLength(2);
    expect(editorRef.current?.getDocument().comments?.[0].messages[1]).toMatchObject({
      authorName: "ゲスト", body: [{ type: "text", text: "@claude 返信を確認してください" }],
    });
    expect(editorRef.current?.getDocument().comments?.[0].messages[1].agent).toBeUndefined();
    expect(container.querySelector(".ai-sidebar-panel")).toBeNull();
    expect(card().textContent).not.toContain("接続されていません");

    await clickButton(card().querySelector<HTMLButtonElement>(".comment-message.root .comment-thread-menu-button") ?? undefined);
    await clickButton(findButton(card(), "編集"));
    await setCommentText(card().querySelector(".comment-message-edit .ProseMirror"), "変更したコメント");
    await clickButton(findButton(card(), "保存"));
    expect(editorRef.current?.getDocument().comments?.[0].messages[0].body).toEqual([{ type: "text", text: "変更したコメント" }]);

    await clickButton(findButton(card(), "解決"));
    expect(editorRef.current?.getDocument().comments?.[0].resolved).toBe(true);
    await clickButton(card().querySelector<HTMLButtonElement>(".comment-message.root .comment-thread-menu-button") ?? undefined);
    await clickButton(findButton(card(), "削除"));
    expect(editorRef.current?.getDocument().comments).toEqual([]);
    expect(card()).toBeNull();
    expect(changes).toHaveLength(4);
    expect(changes.every((document) => JSON.stringify(document.content) === JSON.stringify(initial.content))).toBe(true);
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 500)); });
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ comments: [] }));
  });

  it("prints the current embedded preview without navigating to the desktop print route", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 1_100),
    );
    const { container } = await renderEditor(
      <SigmaDocEditor
        document={createDocument()}
        onChange={() => undefined}
      />,
    );

    await clickButton(findButton(container, "ファイル"));
    await clickButton(findButton(document, "PDFを書き出し"));

    expect(document.querySelector("[role='dialog'][aria-label='PDFプレビュー']")).not.toBeNull();
    expect(findButton(document, "別画面")).toBeUndefined();

    await clickButton(await waitForButtonEnabled(document, "PDF保存"));

    expect(print).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("ignores a stale echo of its own emitted document instead of resetting mid-edit", async () => {
    // 再現: host の onSave が await 後に、その時点で渡されたスナップショットを
    // setDocument で書き戻す(examples/editor-react18/src/App.tsx が過去にやって
    // いたパターン)。その間にユーザーがさらに編集していると、古い方の
    // documentHistoryKey は「エディタが過去に emit した文書」の記録に載っている
    // ので、host update として resetEditorDocument してはいけない。
    const emitted: SigmaDocument[] = [];

    function Host() {
      const [document, setDocument] = useState(createDocument());
      return (
        <>
          <SigmaDocEditor
            document={document}
            onChange={(next) => {
              emitted.push(next);
              setDocument(next);
            }}
          />
          <button
            type="button"
            aria-label="simulate-stale-echo"
            onClick={() => setDocument(emitted[0])}
          />
        </>
      );
    }

    const { container } = await renderEditor(<Host />);

    await changeValue(
      container.querySelector("input[aria-label='教材タイトル']"),
      "V1",
    );
    await changeValue(
      container.querySelector("input[aria-label='教材タイトル']"),
      "V1V2",
    );
    expect(emitted).toHaveLength(2);

    await clickButton(
      container.querySelector<HTMLButtonElement>("[aria-label='simulate-stale-echo']") ?? undefined,
    );

    expect(container.querySelector(".save-state span")?.textContent).not.toBe(
      "ホストから教材を更新しました",
    );
    expect(
      (container.querySelector("input[aria-label='教材タイトル']") as HTMLInputElement | null)
        ?.value,
    ).toBe("V1V2");
  });

  // NOTE: a matching "genuine document swap (different docId) still resets
  // and announces" test was attempted here but had to be dropped — mounting
  // a second full resetEditorDocument pass in this vitest+happy-dom harness
  // hits a pre-existing "Maximum update depth exceeded" in
  // PageCanvasEditor's structural recompute effect (apps/desktop/src/
  // components/editor/PageCanvasEditor.tsx around line 1136). Verified this
  // reproduces identically with EditorShell.tsx's echo-guard fix reverted,
  // so it predates this change and isn't specific to embeddedHost. Genuine
  // swap was instead verified against the real running example in Chromium
  // (see the task report): title/content/status all update correctly.

  it("covers the editor on mount and lifts the cover once fonts have warmed, without a Sigma Studio brand mark", async () => {
    let finishWarmup!: () => void;
    vi.spyOn(fontWarmup, "warmEmbeddedEditorFonts").mockReturnValue(new Promise<void>((resolve) => { finishWarmup = resolve; }));
    const { container } = await renderEditor(
      <SigmaDocEditor document={createDocument()} onChange={() => undefined} />,
    );

    const cover = () => container.querySelector(".sigma-studio-editor-loading-cover");
    expect(cover()).not.toBeNull();
    expect(cover()?.getAttribute("aria-hidden")).toBe("true");
    // Unbranded: an embedded editor must not paint a logo over a host site
    // (unlike apps/desktop's StartupSplash), just a neutral spinner.
    expect(cover()?.querySelector("img")).toBeNull();
    expect(cover()?.textContent).toBe("");

    // Hold the actual completion signal until the loading assertion is made;
    // host CPU load must not let the cover disappear during mounting.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(cover()).not.toBeNull();
    await act(async () => {
      finishWarmup();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    });

    expect(cover()).toBeNull();
  });
});

async function renderEditor(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ container, root });
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return { container, root };
}

async function changeValue(element: Element | null | undefined, value: string) {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("editable element not found");
  }
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function setCommentText(element: Element | null, value: string) {
  // Tiptap deliberately exposes its editor instance on the editing DOM element.
  const editor = (element as (HTMLElement & { editor?: { commands: { setContent: (content: unknown) => void } } }) | null)?.editor;
  if (!editor) throw new Error("comment editor not found");
  await act(async () => {
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
  });
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
}

async function waitForButtonEnabled(root: ParentNode, label: string) {
  const timeoutAt = Date.now() + 3_000;
  while (Date.now() < timeoutAt) {
    const button = findButton(root, label);
    if (button && !button.disabled) {
      return button;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
  }
  throw new Error(`enabled button not found: ${label}`);
}

async function clickButton(button: HTMLButtonElement | undefined) {
  if (!button) {
    throw new Error("button not found");
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "sdk_editor_test",
    metadata: { title: "微積分教材" },
    content: [
      {
        type: "paragraph",
        id: "paragraph_1",
        children: [
          { type: "text", text: "次の積分を計算しなさい。" },
          {
            type: "mathInline",
            id: "math_1",
            tex: "\\int_0^1 x^2\\,dx",
            display: "inline",
          },
        ],
      },
    ],
    outputProfiles: {
      student: {
        showSolutions: false,
        showHints: false,
        includeAnswers: false,
      },
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
