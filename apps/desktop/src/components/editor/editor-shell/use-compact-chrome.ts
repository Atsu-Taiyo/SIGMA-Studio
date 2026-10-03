import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * タイトル行が文字付きのまま重ならずに収まる最小の幅。メニュー・共有・過去の版・問題を報告・
 * ワークスペースを並べたときの実測 (約 800px) に余裕を足した値。これより狭い列は文字を省く。
 */
export const COMPACT_CHROME_MAX_WIDTH = 820;

/**
 * 右のサイドバーを開くと、タイトル・メニュー・本文の列はその分だけ狭くなる。クロームの配置は
 * ウィンドウの幅ではなくこの列の幅で決まるので、狭くなったら `.app-shell` に印を付ける
 * (`data-chrome-compact`)。印があるときの見た目は controls.css が決める。
 */
export function useCompactChrome(shellRef: RefObject<HTMLElement | null>, layoutKey: string) {
  useEffect(() => {
    const shell = shellRef.current;
    const header = shell?.querySelector<HTMLElement>(":scope > .editor-menubar");
    if (!shell || !header || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      if (header.clientWidth > 0 && header.clientWidth < COMPACT_CHROME_MAX_WIDTH) shell.dataset.chromeCompact = "true";
      else delete shell.dataset.chromeCompact;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => {
      observer.disconnect();
      delete shell.dataset.chromeCompact;
    };
  }, [shellRef, layoutKey]);
}
