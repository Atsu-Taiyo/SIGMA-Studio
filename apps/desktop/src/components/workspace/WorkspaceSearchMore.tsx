"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef } from "react";

import { useT } from "@/lib/i18n/react";

/**
 * 検索結果の続きを出すボタン。スクロールして見えたら自分で押されたことにするので、普段は意識せずに
 * 続きが出てくる。キーボードやスクロールしない場面では、そのまま押して足せる。
 */
export function WorkspaceSearchMore({ remaining, onShowMore }: { remaining: number; onShowMore: () => void }) {
  const t = useT("workspace");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const showMoreRef = useRef(onShowMore);

  useEffect(() => {
    showMoreRef.current = onShowMore;
  }, [onShowMore]);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMoreRef.current();
    }, { rootMargin: "0px 0px 240px 0px" });
    observer.observe(button);
    return () => observer.disconnect();
  }, [remaining]);

  return (
    <div className="workspace-search-more">
      <button ref={buttonRef} type="button" className="button secondary" onClick={onShowMore}>
        <ChevronDown size={15} aria-hidden="true" />
        {t("search.showMore", { count: remaining })}
      </button>
    </div>
  );
}
