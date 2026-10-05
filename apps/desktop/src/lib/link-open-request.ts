/**
 * 本文中のリンクを開く要求。本文の編集面 (Tiptap の装飾) が出し、受け取る側は
 * 開く先ごとに別々にいる: 既定のブラウザは編集画面の外枠、Sigma 内のブラウザは右サイドバー。
 * window イベントにしておけば、どの編集面にも受け取り側へのコールバックを通さずに済む
 * (QR コードの要求と同じ作り)。
 */

export const OPEN_LINK_REQUEST_EVENT = "sigma-studio:open-link-request";

/** `browser`: OS の既定のブラウザ。`sigma`: 右サイドバーのアプリ内ブラウザ。 */
export type OpenLinkTarget = "browser" | "sigma";

export interface OpenLinkRequestDetail {
  url: string;
  target: OpenLinkTarget;
}

export function requestOpenLink(url: string, target: OpenLinkTarget): void {
  if (typeof window === "undefined") {
    return;
  }
  const detail: OpenLinkRequestDetail = { url, target };
  window.dispatchEvent(new CustomEvent<OpenLinkRequestDetail>(OPEN_LINK_REQUEST_EVENT, { detail }));
}

/** イベントから、自分の開く先宛ての要求だけを取り出す。 */
export function readOpenLinkRequest(event: Event, target: OpenLinkTarget): string | null {
  const detail = event instanceof CustomEvent ? (event.detail as OpenLinkRequestDetail | null) : null;
  if (!detail || detail.target !== target) {
    return null;
  }
  const url = typeof detail.url === "string" ? detail.url.trim() : "";
  return url || null;
}
