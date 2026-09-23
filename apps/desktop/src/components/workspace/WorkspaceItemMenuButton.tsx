"use client";

import { MoreHorizontal } from "lucide-react";
import type { MouseEvent } from "react";
import { IconButton } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";

/** Menu actions never select, open, drag, or toggle the containing item. */
export function WorkspaceItemMenuButton({ name, expanded = false, disabled, onClick }: {
  name: string;
  expanded?: boolean;
  disabled?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const t = useT("workspace");
  return <IconButton
    label={t("action.itemMenu", { replace: { name } })}
    className="workspace-item-menu-button"
    size="sm" tone="ghost" aria-haspopup="menu" aria-expanded={expanded}
    disabled={disabled}
    onPointerDown={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); onClick(event); }}
  ><MoreHorizontal size={15} /></IconButton>;
}
