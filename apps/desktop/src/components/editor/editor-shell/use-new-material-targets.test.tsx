// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workspaceRepository from "@/lib/workspace-repository";
import { useNewMaterialTargets, type NewMaterialTargets } from "./use-new-material-targets";

let root: Root;
let container: HTMLDivElement;
let latest: NewMaterialTargets;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Probe({ open }: { open: boolean }) {
  const targets = useNewMaterialTargets(open, { fileId: "file", workspaceId: "local", folderId: null });
  useLayoutEffect(() => { latest = targets; });
  return null;
}

const stamp = "2026-10-16T00:00:00.000Z";

it("reads the workspaces only while the menu is open, and keeps the last list while reading again", async () => {
  const overview = vi.spyOn(workspaceRepository, "listWorkspaceOverview").mockResolvedValue({
    state: "ready",
    overview: { activeWorkspaceId: "local", files: [], folders: [], workspaces: [{ id: "local", name: "マイ教材", createdAt: stamp, updatedAt: stamp }] },
  });
  await act(async () => root.render(<Probe open={false} />));
  expect(overview).not.toHaveBeenCalled();
  expect(latest).toEqual({ loading: false, options: [] });

  await act(async () => root.render(<Probe open />));
  expect(overview).toHaveBeenCalledExactlyOnceWith("local");
  expect(latest.loading).toBe(false);
  expect(latest.options.map((option) => [option.workspaceId, option.isDefault])).toEqual([["local", true]]);

  await act(async () => root.render(<Probe open={false} />));
  let resolve!: (value: Awaited<ReturnType<typeof workspaceRepository.listWorkspaceOverview>>) => void;
  overview.mockReturnValueOnce(new Promise((next) => { resolve = next; }));
  await act(async () => root.render(<Probe open />));
  // 読み直しの間も前の一覧を出したまま (メニューの高さを揺らさない)。
  expect(latest.loading).toBe(false);
  expect(latest.options).toHaveLength(1);
  await act(async () => resolve({ state: "error", error: "x" }));
  expect(latest).toEqual({ loading: false, options: [] });
});
