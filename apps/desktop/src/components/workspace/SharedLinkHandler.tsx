"use client";

import { useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { encodeDocumentLocation } from "@/lib/document-location";
import { navigateToAppRoute, prepareAppNavigation } from "@/lib/app-navigation";
import { WorkspaceJoinDialog } from "./WorkspaceJoinDialog";

/** Keep the current editor mounted while authentication or a failed link is shown. */
export function SharedLinkHandler() {
  const [request, setRequest] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    const links = getDesktopBridge()?.shareLinks;
    if (!links) return;
    let disposed = false;
    const check = () => { void links.pending().then(next => { if (!disposed) setRequest(next); }).catch(() => {}); };
    const unsubscribe = links.onAvailable(check);
    check();
    return () => { disposed = true; unsubscribe(); };
  }, []);
  if (!request) return null;
  const close = async () => {
    setRequest(null);
    await getDesktopBridge()?.shareLinks?.acknowledge(request.id);
  };
  return <WorkspaceJoinDialog key={request.id} initialValue={request.url} onClose={() => { void close(); }} onJoined={async (result, location) => {
    if (!(await prepareAppNavigation())) throw new Error("SAVE_NOT_COMPLETED");
    await close();
    if (result.fileId) navigateToAppRoute("/", { fileId: result.fileId, location: location ? encodeDocumentLocation(location) : undefined });
    else navigateToAppRoute("/workspace", { workspaceId: result.workspaceId, folderId: result.folderId });
  }} />;
}
