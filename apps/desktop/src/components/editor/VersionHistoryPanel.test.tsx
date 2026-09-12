// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import type { DocumentVersion, DocumentVersionMetadata } from "@/lib/document-version-history";

const mocks = vi.hoisted(() => ({
  getDocumentVersion: vi.fn(),
  listDocumentVersions: vi.fn(),
  onChange: vi.fn(() => () => undefined),
}));
vi.mock("@/lib/storage", () => ({
  getDocumentVersion: mocks.getDocumentVersion,
  listDocumentVersions: mocks.listDocumentVersions,
}));
vi.mock("@/lib/runtime", () => ({ getAppRuntime: () => ({ library: { onChange: mocks.onChange } }) }));

let VersionHistoryPanel: typeof import("./VersionHistoryPanel").VersionHistoryPanel;
let container: HTMLDivElement;
let root: Root;

function metadata(versionId: string, capturedAt: string): DocumentVersionMetadata {
  return { versionId, revision: 1, capturedAt, origin: "user" };
}
function version(value: DocumentVersionMetadata, title: string): DocumentVersion {
  return { ...value, document: { ...createBlankDocument(title), metadata: { title } } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}
async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
}

beforeAll(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  VersionHistoryPanel = (await import("./VersionHistoryPanel")).VersionHistoryPanel;
});
beforeEach(() => {
  mocks.getDocumentVersion.mockReset();
  mocks.listDocumentVersions.mockReset();
  mocks.onChange.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("VersionHistoryPanel", () => {
  it("starts on the synthetic current version and previews a loaded snapshot", async () => {
    const saved = metadata("version_saved", "2026-09-01T02:00:00.000Z");
    const onPreviewChange = vi.fn();
    mocks.listDocumentVersions.mockResolvedValue([saved]);
    mocks.getDocumentVersion.mockResolvedValue(version(saved, "saved"));
    await act(async () => root.render(<VersionHistoryPanel busy={false} fileId="file_1" onClose={vi.fn()} onPreviewChange={onPreviewChange} selectedVersionId={null} />));
    await flush();
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".version-history-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("現在の版");
    expect(rows[0]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => rows[1]!.click());
    await flush();
    expect(onPreviewChange).toHaveBeenLastCalledWith(expect.objectContaining({ versionId: "version_saved" }));
    await act(async () => root.render(<VersionHistoryPanel busy={false} fileId="file_1" onClose={vi.fn()} onPreviewChange={onPreviewChange} selectedVersionId="version_saved" />));
    expect(rows[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(rows[0]!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => root.render(<VersionHistoryPanel busy={false} fileId="file_1" onClose={vi.fn()} onPreviewChange={onPreviewChange} selectedVersionId={null} />));
    expect(rows[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(rows[1]!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => rows[0]!.click());
    expect(onPreviewChange).toHaveBeenLastCalledWith(null);
  });

  it("renders the empty state below the synthetic current version", async () => {
    mocks.listDocumentVersions.mockResolvedValue([]);
    await act(async () => root.render(
      <VersionHistoryPanel busy={false} fileId="file_1" onClose={vi.fn()} onPreviewChange={vi.fn()} selectedVersionId={null} />,
    ));
    await flush();

    const list = container.querySelector<HTMLElement>(".version-history-list");
    expect(list?.children[0]?.classList.contains("version-history-current-row")).toBe(true);
    expect(list?.children[1]?.classList.contains("version-history-state")).toBe(true);
  });

  it("discards an older load result after another version is selected", async () => {
    const newest = metadata("version_newest", "2026-09-01T02:00:00.000Z");
    const older = metadata("version_older", "2026-09-01T01:00:00.000Z");
    const newestLoad = deferred<DocumentVersion | null>();
    const olderLoad = deferred<DocumentVersion | null>();
    const onPreviewChange = vi.fn();
    mocks.listDocumentVersions.mockResolvedValue([newest, older]);
    mocks.getDocumentVersion.mockImplementation((_fileId: string, versionId: string) => (
      versionId === newest.versionId ? newestLoad.promise : olderLoad.promise
    ));
    await act(async () => root.render(<VersionHistoryPanel busy={false} fileId="file_1" onClose={vi.fn()} onPreviewChange={onPreviewChange} selectedVersionId={null} />));
    await flush();
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".version-history-row")];
    await act(async () => { rows[1]!.click(); rows[2]!.click(); });
    await act(async () => olderLoad.resolve(version(older, "older")));
    await act(async () => newestLoad.resolve(version(newest, "newest")));
    expect(onPreviewChange).toHaveBeenCalledTimes(1);
    expect(onPreviewChange).toHaveBeenCalledWith(expect.objectContaining({ versionId: older.versionId }));
  });

  it("keeps the current preview on a failed load and retries the same row", async () => {
    const saved = metadata("version_saved", "2026-09-01T02:00:00.000Z");
    const onPreviewChange = vi.fn();
    mocks.listDocumentVersions.mockResolvedValue([saved]);
    mocks.getDocumentVersion.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => root.render(<VersionHistoryPanel busy={false} fileId="file_1" onClose={vi.fn()} onPreviewChange={onPreviewChange} selectedVersionId={null} />));
    await flush();
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".version-history-row")[1]!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(onPreviewChange).not.toHaveBeenCalled();
    mocks.getDocumentVersion.mockResolvedValueOnce(version(saved, "saved"));
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] .button')!.click());
    await flush();
    expect(onPreviewChange).toHaveBeenCalledWith(expect.objectContaining({ versionId: saved.versionId }));
  });

  it("disables navigation and closing while a restore is busy", async () => {
    const saved = metadata("version_saved", "2026-09-01T02:00:00.000Z");
    const onClose = vi.fn();
    const onPreviewChange = vi.fn();
    mocks.listDocumentVersions.mockResolvedValue([saved]);
    await act(async () => root.render(
      <VersionHistoryPanel busy fileId="file_1" onClose={onClose} onPreviewChange={onPreviewChange} selectedVersionId={null} />,
    ));
    await flush();

    const list = container.querySelector<HTMLElement>(".version-history-list");
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".version-history-row")];
    const close = container.querySelector<HTMLButtonElement>(".sidebar-close-button");
    expect(list?.getAttribute("aria-busy")).toBe("true");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.disabled)).toBe(true);
    expect(close?.disabled).toBe(true);

    rows[0]!.click();
    rows[1]!.click();
    close!.click();
    expect(onPreviewChange).not.toHaveBeenCalled();
    expect(mocks.getDocumentVersion).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
