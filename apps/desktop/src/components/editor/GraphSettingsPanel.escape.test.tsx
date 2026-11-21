// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphSettingsPanelFrame } from "./GraphSettingsPanel";
import { ToolbarPopover } from "./ToolbarPopover";
import { GraphItemActionsMenu } from "./GraphItemActionsMenu";
import { useRef, useState } from "react";

/**
 * Escape in a graph settings panel closes the innermost open thing first.
 *
 * The shared toolbar menu triggers (line dash / width / axis end) do not take focus on a mouse
 * open, so focus can stay on another control while their menu is open, and the popover's own
 * Escape handling (which only answers keys from inside itself) never sees the key. The panel then
 * closes the open menu instead of itself.
 */

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function PickerWithoutFocus({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" data-testid="other">other control</button>
      <button
        ref={anchorRef}
        type="button"
        data-testid="trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled && open}
        // Like EditorToolbarMenuButton: a mouse press does not move focus.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        dash
      </button>
      <ToolbarPopover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} role="menu" ariaLabel="線種">
        <button type="button" role="menuitemradio" aria-checked="false">破線</button>
      </ToolbarPopover>
    </>
  );
}

async function escape(target: Element) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

describe("GraphSettingsPanelFrame Escape", () => {
  it("closes a mouse-opened menu inside the panel before closing the panel", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <GraphSettingsPanelFrame shapeId="graph_1" title="グラフの設定" ariaLabel="グラフの設定" onClose={onClose} closeOpenPickerOnEscape>
          <PickerWithoutFocus />
        </GraphSettingsPanelFrame>,
      );
    });
    const other = document.querySelector<HTMLButtonElement>('[data-testid="other"]')!;
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    other.focus();
    await act(async () => {
      trigger.click();
    });
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
    expect(document.activeElement).toBe(other);

    await escape(other);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    // With nothing open, Escape closes the panel as before.
    await escape(trigger);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not swallow Escape for a picker whose trigger became disabled", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <GraphSettingsPanelFrame shapeId="graph_1" title="グラフの設定" ariaLabel="グラフの設定" onClose={onClose} closeOpenPickerOnEscape>
          <PickerWithoutFocus disabled />
        </GraphSettingsPanelFrame>,
      );
    });
    const other = document.querySelector<HTMLButtonElement>('[data-testid="other"]')!;
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    other.focus();
    await act(async () => {
      trigger.click();
    });
    expect(trigger.disabled).toBe(true);
    await escape(other);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the open picker before a hover-opened card menu, then the card menu, then the panel", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <GraphSettingsPanelFrame shapeId="graph_1" title="グラフの設定" ariaLabel="グラフの設定" onClose={onClose} closeOpenPickerOnEscape>
          <PickerWithoutFocus />
          <GraphItemActionsMenu label="関数 1 の操作" testId="curve-actions" onCloseNestedMenus={() => undefined} deferEscapeToOpenPicker>
            <button type="button">関数を削除</button>
          </GraphItemActionsMenu>
        </GraphSettingsPanelFrame>,
      );
    });
    const other = document.querySelector<HTMLButtonElement>('[data-testid="other"]')!;
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    const actions = document.querySelector<HTMLElement>('[data-testid="curve-actions"]')!;
    other.focus();
    await act(async () => {
      trigger.click();
    });
    await act(async () => {
      actions.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    const actionsMenu = () => document.querySelector('[role="dialog"][aria-label="関数 1 の操作"]');
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
    expect(actionsMenu()).toBeTruthy();

    await escape(other);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(actionsMenu()).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await escape(document.activeElement!);
    expect(actionsMenu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await escape(document.activeElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the original Escape order for point, fill and 3D card menus and for other panels", async () => {
    // 2D の点・塗りのカード、3D のカード (どれも deferEscapeToOpenPicker なし) は、hover で開いた `⋯` が
    // 先に Escape を受ける。3D・グラフ以外のパネル (closeOpenPickerOnEscape なし) は従来どおり閉じる。
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <GraphSettingsPanelFrame shapeId="graph_1" title="グラフの設定" ariaLabel="グラフの設定" onClose={onClose} closeOpenPickerOnEscape>
          <PickerWithoutFocus />
          <GraphItemActionsMenu label="点 1 の操作" testId="point-actions" onCloseNestedMenus={() => undefined}>
            <button type="button">点を削除</button>
          </GraphItemActionsMenu>
        </GraphSettingsPanelFrame>,
      );
    });
    const other = document.querySelector<HTMLButtonElement>('[data-testid="other"]')!;
    other.focus();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!.click();
    });
    await act(async () => {
      document.querySelector('[data-testid="point-actions"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    await escape(other);
    expect(document.querySelector('[role="dialog"][aria-label="点 1 の操作"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // closeOpenPickerOnEscape の無いパネル (3D・グラフ以外) では、開いたメニューがあっても Escape はパネルを閉じる。
    const onCloseOther = vi.fn();
    await act(async () => {
      root.render(
        <GraphSettingsPanelFrame shapeId="graph_2" title="3D" ariaLabel="3D" onClose={onCloseOther}>
          <PickerWithoutFocus />
        </GraphSettingsPanelFrame>,
      );
    });
    const other2 = document.querySelector<HTMLButtonElement>('[data-testid="other"]')!;
    other2.focus();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!.click();
    });
    await escape(other2);
    expect(onCloseOther).toHaveBeenCalledTimes(1);
  });
});
