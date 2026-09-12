/**
 * 検索ハイライトの通知 (`SEARCH_QUERY_EVENT`) を出すかどうかの判定。
 *
 * ハイライトは各エディタのプラグイン state に入った検索語と doc から毎回導出されるので
 * (`components/tiptap/search-highlight-extension.ts`)、文書が変わっただけで通知し直す必要はない。
 * 通知は「前回通知した検索語」から実際に変わった時だけ出す。
 */
export function shouldDispatchSearchQuery(lastDispatched: string | null, next: string): boolean {
  if (lastDispatched === next) {
    return false;
  }

  // 未通知 (null) と空文字はどちらも「ハイライト無し」で同じ状態なので、
  // 検索を一度も使っていない文書では 1 回も通知しない。
  return next !== "" || lastDispatched !== null;
}
