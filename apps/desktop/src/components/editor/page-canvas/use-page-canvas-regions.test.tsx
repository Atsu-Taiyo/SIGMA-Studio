// @vitest-environment happy-dom
import { ensurePageLayout } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import { createTranslator } from "@/lib/i18n";
import { act,StrictMode,useLayoutEffect,type PointerEvent as ReactPointerEvent } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { usePageCanvasRunningRegions } from "./use-page-canvas-regions";
let root: Root;
let owner: ReturnType<typeof usePageCanvasRunningRegions>;
const commit = vi.fn();
function Probe({ documentId }: { documentId: string }) {
  const [layout] = [ensurePageLayout(createBlankDocument()).pageLayout!];
  const current = usePageCanvasRunningRegions({ documentId, layout, zoom: 100, tEditorText: createTranslator("ja", "editor"), onSelect: vi.fn(), onPageLayoutChange: commit, onRunningRegionEditingChange: undefined });
  useLayoutEffect(() => { owner = current; });
  return null;
}
async function render(documentId = "first") { await act(async () => root.render(<StrictMode><Probe documentId={documentId} /></StrictMode>)); }
async function move(x = 80, y = 90) { await act(async () => window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }))); }
async function up() { await act(async () => window.dispatchEvent(new PointerEvent("pointerup"))); }
beforeEach(async () => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; commit.mockClear(); root = createRoot(document.createElement("div")); await render(); });
afterEach(async () => { await act(async () => root.unmount()); });

it("commits the final margin draft once and cancels superseded drag listeners", async () => {
  await act(async () => owner.beginPageMarginDrag("left", 0)); await move();
  expect(owner.pageLayoutDraft).not.toBeNull();
  await act(async () => owner.beginPageMarginDrag("right", 0)); await move(30);
  const draft = owner.pageLayoutDraft;
  await up(); await up();
  expect(commit).toHaveBeenCalledExactlyOnceWith(draft); expect(owner.pageLayoutDraft).toBeNull();
});
it("discards pointercancel and never writes the transient draft", async () => {
  await act(async () => owner.beginPageMarginDrag("left", 0)); await move();
  await act(async () => window.dispatchEvent(new PointerEvent("pointercancel"))); await up();
  expect(commit).not.toHaveBeenCalled(); expect(owner.pageLayoutDraft).toBeNull();
});
it("removes running-region and margin drag listeners on file switch and unmount", async () => {
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientY: 0 } as unknown as ReactPointerEvent<HTMLElement>;
  await act(async () => owner.startRunningRegionDrag("header", "end", event)); await move();
  await render("second"); await move(); await up();
  expect(commit).not.toHaveBeenCalled(); expect(owner.pageLayoutDraft).toBeNull();
  await act(async () => owner.beginPageMarginDrag("left", 0)); await move();
  await act(async () => root.unmount()); await move(); await up();
  expect(commit).not.toHaveBeenCalled();
});
