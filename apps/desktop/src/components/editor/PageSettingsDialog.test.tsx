// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageSettingsDialog } from "@/components/editor/PageSettingsDialog";
import { setAppLocale } from "@/lib/i18n/react";
import { getDefaultPageLayout } from "@/lib/page-layout";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setAppLocale("ja");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  setAppLocale("ja");
  container.remove();
});

describe("PageSettingsDialog", () => {
  it("英語UIではホワイトボードの説明と操作を英語で表示する", async () => {
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={getDefaultPageLayout("whiteboard")}
          onClose={vi.fn()}
          onChange={vi.fn()}
        />,
      );
    });
    await act(async () => setAppLocale("en"));

    expect(container.textContent).toContain("Infinite canvas");
    expect(container.textContent).toContain("A body-free canvas that expands in every direction.");
    expect(container.textContent).not.toContain("無限キャンバス");
  });

  it("ホワイトボードを内容に合わせて1枚で印刷することを案内する", () => {
    const html = renderToStaticMarkup(
      <PageSettingsDialog
        layout={getDefaultPageLayout("whiteboard")}
        onClose={vi.fn()}
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("すべてのオブジェクトが収まる1枚に切り出します。");
    expect(html).not.toContain("利用できません");
    expect(html).not.toContain("印刷タイルサイズ");
    expect(html).not.toContain("幅 mm");
    expect(html).not.toContain("高さ mm");
    expect(html).not.toContain('<option value="A4"');
  });

  it("確認ボタンで本文コメント削除を明示し、その場で切り替えを適用する", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={getDefaultPageLayout("A4")}
          hasContent
          onClose={onClose}
          onChange={onChange}
        />,
      );
    });

    const preset = container.querySelector<HTMLButtonElement>('[role="combobox"]#page-size-preset')!;
    await act(async () => preset.click());
    const whiteboard = document.querySelector<HTMLDivElement>('[role="option"][data-value="whiteboard"]');
    expect(whiteboard).not.toBeNull();
    await act(async () => whiteboard!.click());

    expect(container.textContent).toContain("本文ブロックと、本文・本文中の数式に紐づくコメントは削除");
    expect(onChange).not.toHaveBeenCalled();
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("本文とコメントを削除して切り替える"));
    expect(confirm).toBeDefined();

    await act(async () => confirm!.click());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({
      preset: "whiteboard",
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { columnCount: 1, columnGapMm: 0 },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("用紙設定を適用しても選んだ背景を落とさない", async () => {
    // nextLayout はフィールドを列挙して PageLayout を組み直す。ここに background を
    // 足し忘れると、ダイアログを開いて「適用」を押した瞬間に背景が既定へ戻る。
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={{ ...getDefaultPageLayout("whiteboard"), background: "grid" }}
          onClose={vi.fn()}
          onChange={onChange}
        />,
      );
    });

    const apply = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "適用");
    expect(apply).toBeDefined();
    await act(async () => apply!.click());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ preset: "whiteboard", background: "grid" });
  });
});
