import { createTranslator, getAppLocale } from "@/lib/i18n";

/** URL 装飾 (`url-detection-extension`) が付ける下線の要素。URL は `data-url` が持つ。 */
export const URL_LINK_SELECTOR = ".url-detected";

const SHOW_DELAY_MS = 250;
const HIDE_DELAY_MS = 180;
const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 2;
/** ポインタのこの手前から出す (カードへ向かう移動が短くて済む)。 */
const POINTER_LEAD_PX = 20;

const SVG_NS = "http://www.w3.org/2000/svg";

type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

// lucide の qr-code / external-link / panel-right。本文の外 (React の外) で描くので、
// 形だけを持ってここで SVG を組み立てる。
const QR_ICON: IconNode = [
  ["rect", { width: "5", height: "5", x: "3", y: "3", rx: "1" }],
  ["rect", { width: "5", height: "5", x: "16", y: "3", rx: "1" }],
  ["rect", { width: "5", height: "5", x: "3", y: "16", rx: "1" }],
  ["path", { d: "M21 16h-3a2 2 0 0 0-2 2v3" }],
  ["path", { d: "M21 21v.01" }],
  ["path", { d: "M12 7v3a2 2 0 0 1-2 2H7" }],
  ["path", { d: "M3 12h.01" }],
  ["path", { d: "M12 3h.01" }],
  ["path", { d: "M12 16v.01" }],
  ["path", { d: "M16 12h1" }],
  ["path", { d: "M21 12v.01" }],
  ["path", { d: "M12 21v-1" }],
];
const BROWSER_ICON: IconNode = [
  ["path", { d: "M15 3h6v6" }],
  ["path", { d: "M10 14 21 3" }],
  ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
];
const SIGMA_ICON: IconNode = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M15 3v18" }],
];

export type UrlLinkCardAction = "qr" | "browser" | "sigma";

export interface UrlLinkCardOptions {
  /** カードで選ばれた操作を実行する。 */
  onAction(action: UrlLinkCardAction, url: string): void;
  /** Sigma 内のブラウザを持つ環境か。持たない環境では選択肢ごと出さない (押しても開かない導線は作らない)。 */
  canOpenInSigma(): boolean;
}

export interface UrlLinkCard {
  /** ポインタがリンクに乗った。少し待ってからカードを出す。 */
  hoverLink(link: HTMLElement, pointer: { x: number; y: number }): void;
  /** ポインタがリンクから出た。カードへ移る猶予を置いて閉じる。 */
  leaveLink(): void;
  hide(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** ⌘ (mac) / Ctrl (それ以外)。リンクをそのまま開く修飾キーの表示名。 */
export function openModifierLabel(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return /mac|iphone|ipad/iu.test(platform) ? "⌘" : "Ctrl";
}

function buildIcon(node: IconNode): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attributes] of node) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
      shape.setAttribute(name, value);
    }
    svg.append(shape);
  }
  return svg;
}

function buildActionButton(action: UrlLinkCardAction, icon: IconNode, label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "url-link-card-action";
  button.dataset.action = action;
  button.tabIndex = -1;
  button.title = title;
  button.setAttribute("aria-label", title);
  const text = document.createElement("span");
  text.textContent = label;
  button.append(buildIcon(icon), text);
  return button;
}

/** ポインタのいる行の矩形 (折り返した URL は行ごとに矩形が分かれる)。 */
function pickLineRect(link: HTMLElement, pointerY: number): DOMRect {
  const rects = Array.from(link.getClientRects());
  if (rects.length === 0) {
    return link.getBoundingClientRect();
  }
  const distance = (rect: DOMRect) => (pointerY < rect.top ? rect.top - pointerY : pointerY > rect.bottom ? pointerY - rect.bottom : 0);
  return rects.reduce((best, rect) => (distance(rect) < distance(best) ? rect : best));
}

/**
 * 本文の URL にホバーしたときに出す小さなカード。「QR コードにする / 既定のブラウザで開く /
 * Sigma 内で開く」を選ばせる。本文の外 (document.body) に固定配置で出し、文書には何も書かない。
 */
export function createUrlLinkCard(options: UrlLinkCardOptions): UrlLinkCard {
  let element: HTMLElement | null = null;
  let shownUrl: string | null = null;
  let showTimer: number | null = null;
  let hideTimer: number | null = null;

  const clearShowTimer = () => {
    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
  };
  const clearHideTimer = () => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  // 出ている間だけ聞く。スクロール・リサイズ・Esc・ウィンドウの離脱で、位置が合わなくなる前に閉じる。
  const onScrollOrResize = () => hide();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      hide();
    }
  };

  function hide(): void {
    clearShowTimer();
    clearHideTimer();
    if (!element) {
      return;
    }
    element.remove();
    element = null;
    shownUrl = null;
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    window.removeEventListener("blur", onScrollOrResize);
    window.removeEventListener("keydown", onKeyDown, true);
  }

  function build(url: string): HTMLElement {
    const t = createTranslator(getAppLocale(), "editor");
    const key = openModifierLabel();
    const card = document.createElement("div");
    card.className = "url-link-card";
    card.setAttribute("role", "toolbar");
    card.setAttribute("aria-label", t("url.cardLabel"));
    card.dataset.url = url;
    card.append(buildActionButton("qr", QR_ICON, t("url.qrLabel"), t("url.makeQrCode")));
    card.append(buildActionButton("browser", BROWSER_ICON, t("url.browserLabel"), t("url.browserTitle", { key })));
    if (options.canOpenInSigma()) {
      card.append(buildActionButton("sigma", SIGMA_ICON, t("url.sigmaLabel"), t("url.sigmaTitle", { key })));
    }
    // 押してもエディタの選択・フォーカスを動かさない。
    card.addEventListener("mousedown", (event) => event.preventDefault());
    card.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
      if (!button || !card.contains(button)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.action as UrlLinkCardAction;
      hide();
      options.onAction(action, url);
    });
    card.addEventListener("mouseenter", clearHideTimer);
    card.addEventListener("mouseleave", () => scheduleHide());
    return card;
  }

  function place(card: HTMLElement, link: HTMLElement, pointer: { x: number; y: number }): void {
    const anchor = pickLineRect(link, pointer.y);
    const { offsetWidth: width, offsetHeight: height } = card;
    const maxLeft = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - width - VIEWPORT_MARGIN_PX);
    const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN_PX, pointer.x - POINTER_LEAD_PX));
    const below = anchor.bottom + ANCHOR_GAP_PX;
    const fitsBelow = below + height + VIEWPORT_MARGIN_PX <= window.innerHeight;
    const top = fitsBelow ? below : Math.max(VIEWPORT_MARGIN_PX, anchor.top - ANCHOR_GAP_PX - height);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function show(link: HTMLElement, url: string, pointer: { x: number; y: number }): void {
    showTimer = null;
    if (!link.isConnected) {
      return;
    }
    hide();
    const card = build(url);
    // 測ってから置く。置く前の一瞬を見せない。
    card.style.visibility = "hidden";
    document.body.append(card);
    place(card, link, pointer);
    card.style.visibility = "";
    element = card;
    shownUrl = url;
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("blur", onScrollOrResize);
    window.addEventListener("keydown", onKeyDown, true);
  }

  function scheduleHide(): void {
    clearShowTimer();
    clearHideTimer();
    hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
  }

  return {
    hoverLink(link, pointer) {
      const url = link.dataset.url;
      if (!url) {
        return;
      }
      clearHideTimer();
      if (shownUrl === url) {
        // 折り返した同じ URL の別の行へ動いただけ。出ているカードはそのまま。
        return;
      }
      if (shownUrl !== null) {
        hide();
      }
      clearShowTimer();
      showTimer = window.setTimeout(() => show(link, url, pointer), SHOW_DELAY_MS);
    },
    leaveLink: scheduleHide,
    hide,
    isOpen: () => element !== null,
    destroy: hide,
  };
}
