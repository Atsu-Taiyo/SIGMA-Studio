"use client";

import { Check, Link, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { SigmaCommentAnchor } from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { encodeDocumentLocation } from "@/lib/document-location";
import { useT } from "@/lib/i18n/react";
import type { SharedTargetRef } from "../model/catalog";
import { createShareLink } from "../model/share-link";
import { copySelectionLink } from "./copy-selection-link";


export function SelectionLinkButton({ target, anchor, title }: { target: SharedTargetRef; anchor: SigmaCommentAnchor; title: string }) {
  const t = useT("chrome");
  const [state, setState] = useState<"idle" | "busy" | "copied" | "error">("idle");
  const location = encodeDocumentLocation(anchor);
  if (target.kind !== "document" || !location) return null;
  const label = t(state === "copied" ? "collaboration.copied" : state === "error" ? "collaboration.selectionLinkFailed" : "collaboration.copySelectionLink");
  return <button type="button" className="selection-toolbar-button" title={label} aria-label={label} disabled={state === "busy"}
    onMouseDown={event => event.preventDefault()} onClick={async event => {
      event.stopPropagation();
      setState("busy");
      try {
        const details = await getDesktopBridge()?.sharedCatalog?.details({ source: "shared", shared: target });
        if (!details || details.sharing.state !== "active" || !details.sharing.capabilities.read) throw new Error("TARGET_UNAVAILABLE");
        const url = createShareLink(details.target, undefined, anchor);
        const quote = "quote" in anchor ? anchor.quote?.trim() : "";
        await copySelectionLink(url, quote?.slice(0, 300) || title);
        setState("copied");
      } catch { setState("error"); }
    }}>
    {state === "copied" ? <Check size={16} aria-hidden="true" /> : state === "error" ? <TriangleAlert size={16} aria-hidden="true" /> : <Link size={16} aria-hidden="true" />}
  </button>;
}
