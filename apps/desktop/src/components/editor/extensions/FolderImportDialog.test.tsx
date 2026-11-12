// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createTranslator } from "@/lib/i18n";
import { FolderImportDialog } from "./FolderImportDialog";

afterEach(() => { delete window.sigmaExtensions; });
it("shows empty results, closes, and reports an output-open failure", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const close = vi.fn();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.sigmaExtensions = { menu: async () => [], run: async () => ({ ok: false, error: "canceled" }), onMenuChange: () => () => {}, openFolderResult: async () => false };
  try {
    act(() => root.render(<FolderImportDialog progress={null} result={{ ok: true, kind: "folder", jobId: "job", outputDirectory: "/output", counts: { success: 0, failed: 0, skipped: 0 }, entries: [], truncated: false }} onClose={close} />));
    expect(document.body.textContent).toContain("処理対象はありませんでした。");
    const buttons = Array.from(document.body.querySelectorAll("button"));
    await act(async () => buttons.find(button => button.textContent === "保存先を開く")!.click());
    expect(document.body.textContent).toContain("保存先を開けませんでした。");
    act(() => buttons.find(button => button.textContent === "閉じる")!.click());
    expect(close).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); container.remove(); }
});
it("has English product copy and reason translations", () => {
  const t = createTranslator("en", "editor");
  expect(t("extensions.folder.title")).toBe("Folder conversion results");
  expect(t("extensions.folder.reasons.changed")).toBe("Entry changed or removed since scanning");
  expect(t("extensions.folder.summary", { success: 1, skipped: 2, failed: 3 })).toBe("Success 1 / Skipped 2 / Failed 3");
});
