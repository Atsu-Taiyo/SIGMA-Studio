import type { LibrarySharingMetadata, SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import type { SharedCapabilities } from "@/features/collaboration/model/catalog";

/** Local items remain usable offline; shared hierarchy mutations require current authority. */
export function canMutateWorkspaceItem(sharing: LibrarySharingMetadata | undefined, status: SharedCatalogStatus | undefined, capability: keyof SharedCapabilities): boolean {
  return !sharing || (status?.state === "ready" && sharing.state === "active" && sharing.capabilities[capability]);
}

export function canDeleteWorkspaceItem(
  item: { sharing?: LibrarySharingMetadata; sharingPending?: boolean } | null | undefined,
  parent: { sharing?: LibrarySharingMetadata; sharingPending?: boolean } | null | undefined,
  status: SharedCatalogStatus | undefined,
): boolean {
  if (!item || item.sharingPending || parent?.sharingPending) return false;
  if (!item.sharing) return true;
  if (item.sharing.isShareRoot) return canMutateWorkspaceItem(item.sharing, status, "deleteRootShare");
  return parent?.sharing
    ? canMutateWorkspaceItem(parent.sharing, status, "deleteDescendants")
    : canMutateWorkspaceItem(item.sharing, status, "deleteRootShare");
}
