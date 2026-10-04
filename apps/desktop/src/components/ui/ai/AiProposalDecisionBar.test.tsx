// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTranslator } from "@/lib/i18n";

import { AiProposalDecisionBar } from "./AiProposalDecisionBar";

type BarProps = ComponentProps<typeof AiProposalDecisionBar>;

function renderBar(props: Partial<BarProps> = {}): string {
  return renderToStaticMarkup(<AiProposalDecisionBar title="AI編集案" surface="page" applying={false} {...props} />);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(element: React.ReactElement): Promise<void> {
  await act(async () => root.render(element));
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === name);
  if (!found) {
    throw new Error(`no button named ${name}: ${container.innerHTML}`);
  }
  return found;
}

describe("AiProposalDecisionBar", () => {
  it("is one thin bar: the heading, the kind of change, references and the shared decision actions", () => {
    const html = renderBar({
      references: <span data-testid="chips">参照元</span>,
      onApply: async () => ({ ok: true }),
      onDismiss: () => {},
      onOpenConversation: () => {},
    });

    expect(html).toContain('data-ai-proposal-bar=""');
    expect(html).toContain('data-surface="page"');
    expect(html).toContain("提案された変更");
    expect(html).toContain("AI編集案");
    expect(html).toContain("参照元");
    expect(html.indexOf("提案された変更")).toBeLessThan(html.indexOf('aria-label="破棄"'));
    expect(html.indexOf('aria-label="破棄"')).toBeLessThan(html.indexOf('aria-label="続けて修正"'));
    expect(html.indexOf('aria-label="続けて修正"')).toBeLessThan(html.indexOf('aria-label="適用"'));
  });

  it("offers the content and before-shape toggles only where the surface has them", () => {
    const bare = renderBar();
    expect(bare).not.toContain("内容を隠す");
    expect(bare).not.toContain("変更前を隠す");

    const withToggles = renderBar({
      contentId: "proposal-content",
      onContentHiddenChange: () => {},
      onBeforeHiddenChange: () => {},
    });
    expect(withToggles).toContain('aria-label="内容を隠す"');
    expect(withToggles).toContain('aria-expanded="true"');
    expect(withToggles).toContain('aria-controls="proposal-content"');
    expect(withToggles).toContain('aria-label="変更前を隠す"');
    expect(withToggles).toContain('aria-pressed="false"');

    const toggled = renderBar({
      contentHidden: true,
      beforeHidden: true,
      onContentHiddenChange: () => {},
      onBeforeHiddenChange: () => {},
    });
    expect(toggled).toContain('aria-label="内容を表示"');
    expect(toggled).toContain('aria-expanded="false"');
    expect(toggled).toContain('aria-label="変更前を表示"');
    expect(toggled).toContain('aria-pressed="true"');
  });

  it("renders a notice slot under the heading row (e.g. a merged-edit note)", () => {
    expect(renderBar({ notice: <span>あなたの編集と合わせた内容です</span> })).toContain("あなたの編集と合わせた内容です");
  });

  it("disables decisions and shows the shimmer while applying", () => {
    const html = renderBar({ applying: true, onApply: async () => ({ ok: true }), onDismiss: () => {} });

    expect(html).toContain("適用中…");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });

  it("shows why the apply failed on the bar and retries from the same button", async () => {
    const onApply = vi.fn<NonNullable<BarProps["onApply"]>>()
      .mockResolvedValueOnce({ ok: false, reason: "対象が更新されました" })
      .mockResolvedValueOnce({ ok: true });
    await mount(<AiProposalDecisionBar title="AI編集案" surface="page" applying={false} onApply={onApply} />);

    await act(async () => button("適用").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("対象が更新されました");

    await act(async () => button("適用").click());
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a thrown apply as the generic failure text", async () => {
    const onApply = vi.fn(async () => {
      throw new Error("IPCが切れました");
    });
    await mount(<AiProposalDecisionBar title="AI編集案" surface="panel" applying={false} onApply={onApply} />);

    await act(async () => button("適用").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("IPCが切れました");
  });

  it("lifts the error to the owner when it is controlled, so a re-mounted bar keeps it", async () => {
    const onApplyErrorChange = vi.fn();
    await mount(
      <AiProposalDecisionBar
        title="AI編集案"
        surface="page"
        applying={false}
        applyError="前に失敗した理由"
        onApplyErrorChange={onApplyErrorChange}
        onApply={async () => ({ ok: false, reason: "新しい理由" })}
      />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("前に失敗した理由");

    await act(async () => button("適用").click());
    expect(onApplyErrorChange.mock.calls).toEqual([[null], ["新しい理由"]]);
  });

  it("toggles the content and the before shapes through the owner's state", async () => {
    function Owner() {
      const [contentHidden, setContentHidden] = useState(false);
      const [beforeHidden, setBeforeHidden] = useState(false);
      return (
        <AiProposalDecisionBar
          title="AI図形の変更案"
          surface="overlay"
          applying={false}
          contentHidden={contentHidden}
          onContentHiddenChange={setContentHidden}
          beforeHidden={beforeHidden}
          onBeforeHiddenChange={setBeforeHidden}
        />
      );
    }
    await mount(<Owner />);

    await act(async () => button("内容を隠す").click());
    expect(button("内容を表示").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button("内容を表示").click());
    expect(button("内容を隠す").getAttribute("aria-expanded")).toBe("true");

    await act(async () => button("変更前を隠す").click());
    expect(button("変更前を表示").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the dismiss reason outside the bar so a clipped card cannot cut it, and keeps it in the owner's state", async () => {
    const onDismiss = vi.fn();
    function Owner() {
      const [open, setOpen] = useState(false);
      return (
        <div style={{ clipPath: "inset(0)" }} data-testid="clipped-card">
          <AiProposalDecisionBar
            title="AI編集案"
            surface="page"
            applying={false}
            dismissReasonPlaceholder="例: 数式が合っていない"
            dismissReasonOpen={open}
            onDismissReasonOpenChange={setOpen}
            onDismiss={onDismiss}
          />
        </div>
      );
    }
    await mount(<Owner />);

    await act(async () => button("破棄").click());
    const popover = document.querySelector<HTMLElement>('[aria-label="破棄する理由"]');
    expect(popover).not.toBeNull();
    expect(container.contains(popover)).toBe(false);
    expect(popover?.style.position).toBe("fixed");
    expect(document.activeElement?.tagName).toBe("TEXTAREA");

    const textarea = popover!.querySelector("textarea")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(textarea, "  図が違う  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...popover!.querySelectorAll("button")].find((candidate) => candidate.textContent === "破棄");
    await act(async () => submit!.click());
    expect(onDismiss).toHaveBeenCalledWith("図が違う");
    expect(document.querySelector('[aria-label="破棄する理由"]')).toBeNull();
  });

  it("draws a continuation replica at the same size but hidden and without operations", async () => {
    await mount(
      <AiProposalDecisionBar
        title="AI編集案"
        surface="page"
        applying={false}
        replica
        dismissReasonOpen
        onDismissReasonOpenChange={() => {}}
        dismissReasonPlaceholder="例"
        onDismiss={() => {}}
        onApply={async () => ({ ok: true })}
      />,
    );

    const bar = container.querySelector<HTMLElement>("[data-ai-proposal-bar]");
    expect(bar?.hasAttribute("data-replica")).toBe(true);
    expect(bar?.getAttribute("aria-hidden")).toBe("true");
    // 開いている破棄理由は正本の側にだけ出す (複製から 2 つ目を出さない)。
    expect(document.querySelectorAll('[aria-label="破棄する理由"]')).toHaveLength(0);
  });

  it("is a single row: references, a notice and the apply error sit under the bar, not inside it", () => {
    const html = renderBar({
      references: <span>参照元のチップ</span>,
      notice: <span>あなたの編集と合わせた内容です</span>,
      applyError: "対象が更新されました",
      onApplyErrorChange: () => {},
      onApply: async () => ({ ok: true }),
      onDismiss: () => {},
    });
    const barStart = html.indexOf("data-ai-proposal-bar=");
    const detailsStart = html.indexOf("data-ai-proposal-bar-details=");
    expect(barStart).toBeGreaterThanOrEqual(0);
    expect(detailsStart).toBeGreaterThan(barStart);
    // バーの中には見出し・切り替え・判断操作だけ。
    const barHtml = html.slice(barStart, detailsStart);
    expect(barHtml).toContain("提案された変更");
    expect(barHtml).toContain('aria-label="適用"');
    expect(barHtml).not.toContain("参照元のチップ");
    expect(barHtml).not.toContain("対象が更新されました");
    const detailsHtml = html.slice(detailsStart);
    expect(detailsHtml).toContain("参照元のチップ");
    expect(detailsHtml).toContain("あなたの編集と合わせた内容です");
    expect(detailsHtml).toContain("対象が更新されました");
  });

  it("shows the references and the error on a continuation replica too, as a picture only", async () => {
    await mount(
      <AiProposalDecisionBar
        title="AI編集案"
        surface="page"
        applying={false}
        replica
        references={<span className="chips">参照元のチップ</span>}
        applyError="対象が更新されました"
        onApplyErrorChange={() => {}}
        onApply={async () => ({ ok: true })}
      />,
    );
    const details = container.querySelector<HTMLElement>("[data-ai-proposal-bar-details]");
    expect(details?.textContent).toContain("参照元のチップ");
    expect(details?.textContent).toContain("対象が更新されました");
    expect(details?.hasAttribute("data-replica")).toBe(false);
    expect(container.querySelector("[data-ai-proposal-bar]")?.hasAttribute("data-replica")).toBe(true);
  });

  it("leaves out 適用 when the surface cannot apply", () => {
    const html = renderBar({ showApply: false, onDismiss: () => {} });
    expect(html).not.toContain('aria-label="適用"');
    expect(html).toContain('aria-label="破棄"');
  });

  it("keeps the reason being typed in the owner's state and does not steal focus when the bar is re-created", async () => {
    function Owner({ generation }: { generation: number }) {
      const [open, setOpen] = useState(false);
      const [reason, setReason] = useState("");
      return (
        <>
          <input aria-label="ほかの入力欄" />
          <AiProposalDecisionBar
            key={generation}
            title="AI編集案"
            surface="page"
            applying={false}
            dismissReasonPlaceholder="例"
            dismissReasonOpen={open}
            onDismissReasonOpenChange={setOpen}
            dismissReason={reason}
            onDismissReasonChange={setReason}
            onDismiss={() => {}}
          />
        </>
      );
    }
    await mount(<Owner generation={1} />);
    await act(async () => button("破棄").click());
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="破棄する理由"] textarea')!;
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "図が違う");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // 別の場所で作業している最中に、カードが作り直された。
    const other = container.querySelector<HTMLInputElement>('input[aria-label="ほかの入力欄"]')!;
    other.focus();
    await mount(<Owner generation={2} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

    const reopened = document.querySelector<HTMLTextAreaElement>('[aria-label="破棄する理由"] textarea');
    expect(reopened?.value).toBe("図が違う");
    expect(document.activeElement).toBe(other);
  });

  it("follows the dismiss button while the reason is open (the card can move without a scroll)", async () => {
    await mount(
      <AiProposalDecisionBar title="AI編集案" surface="page" applying={false} dismissReasonPlaceholder="例" onDismiss={() => {}} />,
    );
    const trigger = button("破棄");
    let top = 100;
    trigger.getBoundingClientRect = () => ({
      top, bottom: top + 28, left: 560, right: 600, width: 40, height: 28, x: 560, y: top, toJSON: () => ({}),
    });
    await act(async () => trigger.click());
    const popover = () => document.querySelector<HTMLElement>('[aria-label="破棄する理由"]')!;
    const firstTop = popover().style.top;

    top = 300;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(popover().style.top).not.toBe(firstTop);
    expect(popover().style.top).toBe(`${300 + 28 + 8}px`);
  });

  it("keeps Tab inside the reason popover and gives focus back to 破棄 when it closes", async () => {
    const onDismiss = vi.fn();
    await mount(
      <AiProposalDecisionBar title="AI編集案" surface="page" applying={false} dismissReasonPlaceholder="例" onDismiss={onDismiss} />,
    );
    await act(async () => button("破棄").click());
    const popover = document.querySelector<HTMLElement>('[aria-label="破棄する理由"]')!;
    const focusables = [...popover.querySelectorAll<HTMLElement>("button, textarea")];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const press = async (target: HTMLElement, shiftKey = false) => {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
      });
    };

    last.focus();
    await press(last);
    expect(document.activeElement).toBe(first);
    await press(first, true);
    expect(document.activeElement).toBe(last);

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[aria-label="破棄する理由"]')).toBeNull();
    expect(document.activeElement).toBe(button("破棄"));

    await act(async () => button("破棄").click());
    const submit = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="破棄する理由"] button')]
      .find((candidate) => candidate.textContent === "破棄")!;
    await act(async () => submit.click());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button("破棄"));
  });

  it("resolves every new label in English", () => {
    const t = createTranslator("en", "ai");
    const keys = ["card.hideContent", "card.showContent", "card.hideBefore", "card.showBefore"] as const;
    expect(keys.map((key) => t(key))).toEqual(["Hide details", "Show details", "Hide original", "Show original"]);
  });
});
