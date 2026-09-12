// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n/react";

import { WindowCloseSaveDialog } from "./WindowCloseSaveDialog";

let container: HTMLDivElement;
let shell: HTMLDivElement;
let trigger: HTMLButtonElement;
let root: Root;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  setAppLocale("ja");
  shell = document.createElement("div");
  shell.className = "app-shell";
  trigger = document.createElement("button");
  trigger.textContent = "trigger";
  shell.append(trigger);
  document.body.append(shell);
  trigger.focus();

  container = document.createElement("div");
  shell.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  shell.remove();
});

async function renderDialog() {
  const onRetry = vi.fn();
  const onCloseWithoutSaving = vi.fn();
  const onCancel = vi.fn();
  await act(async () => {
    root.render(
      <WindowCloseSaveDialog
        error="保存エラー"
        saving={false}
        onRetry={onRetry}
        onCloseWithoutSaving={onCloseWithoutSaving}
        onCancel={onCancel}
      />,
    );
  });
  return { onRetry, onCloseWithoutSaving, onCancel };
}

function pressTab(shiftKey = false) {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  }));
}

describe("WindowCloseSaveDialog", () => {
  it("makes the app shell inert and traps forward and backward tab navigation", async () => {
    await renderDialog();
    const dialog = document.body.querySelector<HTMLElement>(".window-close-save-dialog");
    const buttons = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button"));
    const cancel = buttons[0];
    const retry = buttons.at(-1);

    expect(shell.hasAttribute("inert")).toBe(true);
    expect(shell.contains(dialog)).toBe(false);
    expect(document.activeElement).toBe(retry);
    pressTab();
    expect(document.activeElement).toBe(cancel);
    pressTab(true);
    expect(document.activeElement).toBe(retry);
  });

  it("keeps all three portaled actions focusable and operable outside the inert shell", async () => {
    const { onRetry, onCloseWithoutSaving, onCancel } = await renderDialog();
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".window-close-save-dialog button"));

    expect(shell.hasAttribute("inert")).toBe(true);
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
      button.click();
    }
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCloseWithoutSaving).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("cancels on Escape and restores the previous focus when unmounted", async () => {
    const { onCancel } = await renderDialog();
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    expect(onCancel).toHaveBeenCalledOnce();

    await act(async () => root.render(null));
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
