// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WorkspaceCreateDialog } from "./WorkspaceCreateDialog";

it("offers create-and-open by submit/Enter and create-only without submitting twice", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const submit = vi.fn((event: { preventDefault(): void }, _openAfterCreate: boolean) => event.preventDefault());
  try {
    const render = (kind: "document" | "folder", saving = false) => act(() => root.render(<WorkspaceCreateDialog dialog={{ kind, name: "教材", folderId: null }} folders={[]} saving={saving} onNameChange={vi.fn()} onSubmit={submit} onClose={vi.fn()} />));
    render("document");
    const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === label)!;
    expect(button("作成して開く").type).toBe("submit");
    await act(async () => button("作成のみ").click());
    expect(submit.mock.calls).toHaveLength(1); expect(submit.mock.calls[0][1]).toBe(false);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(submit.mock.calls[1][1]).toBe(true);
    render("document", true);
    expect(button("作成のみ").disabled).toBe(true); expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    render("folder"); expect(container.textContent).not.toContain("作成のみ");
  } finally { act(() => root.unmount()); container.remove(); }
});
