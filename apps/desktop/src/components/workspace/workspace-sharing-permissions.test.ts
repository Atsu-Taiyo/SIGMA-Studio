import { describe, expect, it } from "vitest";
import type { LibrarySharingMetadata, SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import { canDeleteWorkspaceItem, canMutateWorkspaceItem } from "./workspace-sharing-permissions";
const ready: SharedCatalogStatus = { state: "ready", actorId: "actor", revision: 1 };
const metadata = (capabilities: Partial<LibrarySharingMetadata["capabilities"]>) => ({ state: "active", capabilities } as LibrarySharingMetadata);
describe("server capability projection", () => {
  it("uses the parent deletion capability for a document, not its own descendants capability", () => {
    const document = { sharing: metadata({ deleteDescendants: false, deleteRootShare: false }) };
    expect(canDeleteWorkspaceItem(document, { sharing: metadata({ deleteDescendants: true }) }, ready)).toBe(true);
    expect(canDeleteWorkspaceItem(document, { sharing: metadata({ deleteDescendants: false }) }, ready)).toBe(false);
    expect(canDeleteWorkspaceItem(document, undefined, ready)).toBe(false);
    expect(canDeleteWorkspaceItem({ sharing: { ...document.sharing, isShareRoot: true } }, { sharing: metadata({ deleteDescendants: true }) }, ready)).toBe(false);
    expect(canDeleteWorkspaceItem({ sharing: metadata({ deleteRootShare: true }) }, undefined, ready)).toBe(true);
  });
  it("blocks pending/offline shared hierarchy actions while local items remain usable", () => {
    expect(canDeleteWorkspaceItem({ sharingPending: true }, undefined, ready)).toBe(false);
    expect(canMutateWorkspaceItem(metadata({ rename: true }), { ...ready, state: "offline" }, "rename")).toBe(false);
    expect(canMutateWorkspaceItem(undefined, { ...ready, state: "offline" }, "rename")).toBe(true);
    expect(canMutateWorkspaceItem({ ...metadata({ rename: true }), state: "initializing" }, ready, "rename")).toBe(false);
  });
});
