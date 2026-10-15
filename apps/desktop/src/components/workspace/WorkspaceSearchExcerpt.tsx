"use client";

import type { WorkspaceBodySearchExcerpt } from "@/lib/workspace-body-search-contract";
import { useT } from "@/lib/i18n/react";

/** 本文で検索に一致した教材の、一致した箇所の 1 行。入りきらない後ろは薄れて消える。 */
export function WorkspaceSearchExcerpt({ excerpt }: { excerpt: WorkspaceBodySearchExcerpt }) {
  const t = useT("workspace");
  return (
    <span className="workspace-search-excerpt" title={`${excerpt.before}${excerpt.match}${excerpt.after}`}>
      <span className="visually-hidden">{t("search.bodyMatch")} </span>
      {excerpt.before}
      <mark>{excerpt.match}</mark>
      {excerpt.after}
    </span>
  );
}
