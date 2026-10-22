// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  it("does not offer the retired fraction sizing setting", async () => {
    await act(async () => {
      root.render(<PageSettingsDialog onClose={vi.fn()} onChange={vi.fn()} />);
    });
    expect(document.body.innerHTML).toContain("page-settings-dialog");
    expect(document.body.innerHTML).not.toContain("分数を常に同じ大きさで表示");
    expect(document.body.innerHTML).not.toContain("page-settings-math");
  });

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

    expect(document.body.textContent).toContain("Infinite canvas");
    expect(document.body.textContent).toContain("A body-free canvas that expands in every direction.");
    expect(document.body.textContent).not.toContain("無限キャンバス");
  });

  it("ホワイトボードを内容に合わせて1枚で印刷することを案内する", async () => {
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={getDefaultPageLayout("whiteboard")}
          onClose={vi.fn()}
          onChange={vi.fn()}
        />,
      );
    });
    const html = document.body.innerHTML;

    expect(html).toContain("すべてのオブジェクトが収まる1枚に切り出します。");
    expect(html).not.toContain("利用できません");
    expect(html).not.toContain("印刷タイルサイズ");
    expect(html).not.toContain('id="page-custom-width"');
    expect(html).not.toContain('id="margin-top"');
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

    const preset = document.querySelector<HTMLButtonElement>('[role="combobox"]#page-size-preset')!;
    await act(async () => preset.click());
    const whiteboard = document.querySelector<HTMLDivElement>('[role="option"][data-value="whiteboard"]');
    expect(whiteboard).not.toBeNull();
    await act(async () => whiteboard!.click());

    expect(document.body.textContent).toContain("本文ブロックと、本文・本文中の数式に紐づくコメントは削除");
    expect(onChange).not.toHaveBeenCalled();
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
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

    await act(async () => findButton("適用").click());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ preset: "whiteboard", background: "grid" });
  });

  it("上余白を 10mm にすると、ヘッダーをその中に縮めてそのまま適用する", async () => {
    // 以前は余白に 10 を入れても、適用でヘッダーの下端 (オフセット + 高さ) まで押し戻されていた。
    const onChange = vi.fn();
    const base = getDefaultPageLayout("A4");
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={{
            ...base,
            marginsMm: { ...base.marginsMm, top: 19.5 },
            header: { ...base.header!, enabled: true, offsetMm: 5, heightMm: 14.5 },
          }}
          onClose={vi.fn()}
          onChange={onChange}
        />,
      );
    });

    await typeNumber("#margin-top", "10");
    expect(document.querySelector<HTMLInputElement>("#page-header-height")?.value).toBe("5");
    await act(async () => findButton("適用").click());

    expect(onChange.mock.calls[0]?.[0]).toMatchObject({
      marginsMm: { top: 10 },
      header: { enabled: true, offsetMm: 5, heightMm: 5 },
    });
  });

  it("ヘッダーの高さは 0mm にでき、揃っていた上余白も付いてくる", async () => {
    const onChange = vi.fn();
    const base = getDefaultPageLayout("A4");
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={{
            ...base,
            marginsMm: { ...base.marginsMm, top: 13 },
            header: { ...base.header!, enabled: true, offsetMm: 5, heightMm: 8 },
          }}
          onClose={vi.fn()}
          onChange={onChange}
        />,
      );
    });

    await typeNumber("#page-header-height", "0");
    expect(document.querySelector<HTMLInputElement>("#margin-top")?.value).toBe("5");
    await act(async () => findButton("適用").click());

    expect(onChange.mock.calls[0]?.[0]).toMatchObject({
      marginsMm: { top: 5 },
      header: { enabled: true, offsetMm: 5, heightMm: 0 },
    });
  });

  it("ヘッダーを「先頭ページのみ」にでき、選び直すと「すべて」に戻る", async () => {
    const onChange = vi.fn();
    const base = getDefaultPageLayout("A4");
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={{ ...base, header: { ...base.header!, enabled: true } }}
          onClose={vi.fn()}
          onChange={onChange}
        />,
      );
    });
    const group = () => document.querySelector<HTMLElement>('#page-settings-header [role="radiogroup"]')!;
    const radio = (label: string) => Array.from(group().querySelectorAll<HTMLElement>('[role="radio"]'))
      .find((candidate) => candidate.textContent?.trim() === label)!;

    expect(group().getAttribute("aria-label")).toBe("表示するページ");
    expect(radio("すべて").getAttribute("aria-checked")).toBe("true");

    await act(async () => radio("先頭ページのみ").click());
    expect(radio("先頭ページのみ").getAttribute("aria-checked")).toBe("true");
    await act(async () => findButton("適用").click());
    expect(onChange.mock.calls[0]?.[0].header).toMatchObject({ showOnFirstPage: true, showOnLaterPages: false });
    expect(onChange.mock.calls[0]?.[0].header).not.toHaveProperty("hiddenPages");
  });

  it("ページごとの例外があるときは、どれも選ばず、その状態を説明する", async () => {
    const base = getDefaultPageLayout("A4");
    await act(async () => {
      root.render(
        <PageSettingsDialog
          layout={{ ...base, header: { ...base.header!, enabled: true, hiddenPages: [3] } }}
          onClose={vi.fn()}
          onChange={vi.fn()}
        />,
      );
    });
    const radios = Array.from(document.querySelectorAll<HTMLElement>('#page-settings-header [role="radio"]'));

    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(document.querySelector("#page-settings-header")?.textContent).toContain("ページごとに表示を変えています");
  });

  it("ヘッダーを切っている間は位置と高さの欄を出さない", async () => {
    await act(async () => {
      root.render(<PageSettingsDialog layout={getDefaultPageLayout("A4")} onClose={vi.fn()} onChange={vi.fn()} />);
    });
    expect(document.querySelector("#page-header-height")).toBeNull();

    const toggle = document.querySelector<HTMLButtonElement>('#page-settings-header [role="switch"]')!;
    await act(async () => toggle.click());

    expect(document.querySelector<HTMLInputElement>("#page-header-height")?.value).toBe("8");
    expect(document.querySelector<HTMLInputElement>("#page-header-offset")?.value).toBe("5");
  });

  describe("ページ番号の開始", () => {
    const renderDialog = async (layout = getDefaultPageLayout("A4"), onChange = vi.fn()) => {
      await act(async () => {
        root.render(<PageSettingsDialog layout={layout} onClose={vi.fn()} onChange={onChange} />);
      });
      return onChange;
    };

    it("既定は 1 で、触らずに適用しても値を書かない", async () => {
      const onChange = await renderDialog();

      expect(document.querySelector<HTMLInputElement>("#page-number-start")?.value).toBe("1");
      expect(document.querySelector("#page-settings-numbering")?.textContent).toContain("表紙を0ページにするときは0");
      await act(async () => findButton("適用").click());

      expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("pageNumberStart");
    });

    it("0 を入れて適用すると、表紙を 0 ページにする値が渡る", async () => {
      const onChange = await renderDialog();

      await typeNumber("#page-number-start", "0");
      expect(document.querySelector<HTMLInputElement>("#page-number-start")?.value).toBe("0");
      await act(async () => findButton("適用").click());

      expect(onChange.mock.calls[0]?.[0]).toMatchObject({ pageNumberStart: 0 });
    });

    it("保存されている値を欄に出し、1 に戻して適用すると持たなくなる", async () => {
      const onChange = await renderDialog({ ...getDefaultPageLayout("A4"), pageNumberStart: 0 });

      expect(document.querySelector<HTMLInputElement>("#page-number-start")?.value).toBe("0");
      await typeNumber("#page-number-start", "1");
      await act(async () => findButton("適用").click());

      expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty("pageNumberStart");
    });

    it("整数の 0〜9999 に収め、0 で減らすボタンを止める", async () => {
      const onChange = await renderDialog({ ...getDefaultPageLayout("A4"), pageNumberStart: 0 });
      const decrease = document.querySelector<HTMLButtonElement>('button[aria-label="ページ番号の開始を減らす"]')!;
      const increase = document.querySelector<HTMLButtonElement>('button[aria-label="ページ番号の開始を増やす"]')!;

      expect(decrease.disabled).toBe(true);
      expect(increase.disabled).toBe(false);
      await typeNumber("#page-number-start", "12345");
      expect(document.querySelector<HTMLInputElement>("#page-number-start")?.value).toBe("9999");
      expect(document.querySelector<HTMLButtonElement>('button[aria-label="ページ番号の開始を増やす"]')?.disabled).toBe(true);
      await typeNumber("#page-number-start", "-3");
      expect(document.querySelector<HTMLInputElement>("#page-number-start")?.value).toBe("0");
      await act(async () => findButton("適用").click());

      expect(onChange.mock.calls[0]?.[0]).toMatchObject({ pageNumberStart: 0 });
    });

    it("英語UIでも名前とヒントが英語で出る", async () => {
      await renderDialog();
      await act(async () => setAppLocale("en"));

      expect(document.querySelector("#page-settings-numbering")?.textContent).toContain("Start page numbering at");
      expect(document.querySelector("#page-settings-numbering")?.textContent).toContain("Use 0 to number a cover page 0.");
    });

    it("ヘッダー/フッターの無いホワイトボードには出さない", async () => {
      await renderDialog(getDefaultPageLayout("whiteboard"));

      expect(document.querySelector("#page-settings-numbering")).toBeNull();
    });
  });
});

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  expect(button).toBeDefined();
  return button!;
}

async function typeNumber(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  expect(input).not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.focus();
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.blur());
}
