"use client";

import { Bookmark } from "lucide-react";
import type { MouseEvent } from "react";

import { IconButton } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";

/**
 * Toggles a bookmark. Like the item menu, it never selects, opens, drags or toggles the containing item.
 * A bookmarked item keeps the button visible (filled) so the state is readable without hovering.
 */
export function WorkspaceBookmarkButton({ name, bookmarked, className, onToggle }: {
  name: string;
  bookmarked: boolean;
  className?: string;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const t = useT("workspace");
  return <IconButton
    label={t(bookmarked ? "bookmarks.remove" : "bookmarks.add", { replace: { name } })}
    className={["workspace-bookmark-button", bookmarked ? "is-active" : "", className].filter(Boolean).join(" ")}
    size="sm" tone="ghost" aria-pressed={bookmarked}
    onPointerDown={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); onToggle(event); }}
  ><Bookmark size={15} fill={bookmarked ? "currentColor" : "none"} /></IconButton>;
}
