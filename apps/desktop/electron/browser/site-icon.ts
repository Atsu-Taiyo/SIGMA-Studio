/**
 * 開始ページのタイルに出す、サイトのアイコンの取得先。ロゴを同梱せず、サイト自身のアイコンを使うので、
 * 収録されていないサイトも、サイト側がロゴを変えたときも同じ仕組みで追従できる。
 *
 * 取得先へ渡すのはサイトの origin (ホスト名) だけで、パス・クエリ・資格情報は渡さない。
 * 暗号化されていない http のサイトは取得しない。
 */
const ICON_SERVICE = "https://www.google.com/s2/favicons";
const ICON_SIZE_PX = 128;

export function siteIconServiceUrl(pageUrl: string): string | null {
  try {
    const { protocol, origin } = new URL(pageUrl);
    if (protocol !== "https:") return null;
    return `${ICON_SERVICE}?domain_url=${encodeURIComponent(origin)}&sz=${ICON_SIZE_PX}`;
  } catch {
    return null;
  }
}
