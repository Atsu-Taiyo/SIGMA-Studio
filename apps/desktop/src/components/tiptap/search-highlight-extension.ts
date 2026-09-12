import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { countDecorationFullWalk } from "./decoration-walk-metrics";

const SEARCH_QUERY_EVENT = "sigma-studio:search-query";
const searchHighlightKey = new PluginKey<{ query: string }>("searchHighlight");

/**
 * いま画面に効いている検索語。**書き手は検索欄を持つシェルだけ** (`setLatestSearchQuery`)。
 *
 * 通知はイベント 1 本なので、通知より後に生まれたエディタ (タブ切替やページ増加で新しく載った
 * 本文ユニット) はそのままだと検索語を知らないまま始まる。通知側は打鍵のたびに送り直さない
 * (それが本文ユニット数分の transaction になる) ので、現在値をここに置いて新しいエディタの
 * 初期 state にする。イベント受信側では書かない — 受信側だけが書き手だと、エディタが 1 つも
 * 載っていない間の変更を取りこぼし、シェルが入れ替わっても前の値が残る。
 */
let latestSearchQuery = "";

/** シェルが現在の検索語を宣言する (マウント時の「検索していない」も含めて必ず通る)。 */
export function setLatestSearchQuery(query: string): void {
  latestSearchQuery = query;
}

export const SearchHighlightExtension = Extension.create({
  name: "searchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchHighlightKey,
        state: {
          init: () => ({ query: latestSearchQuery }),
          apply(transaction, previous) {
            const query = transaction.getMeta(searchHighlightKey);
            if (typeof query === "string") {
              return { query };
            }

            return previous;
          },
        },
        props: {
          decorations(state) {
            const query = searchHighlightKey.getState(state)?.query.trim();
            if (!query) {
              return DecorationSet.empty;
            }

            const decorations: Decoration[] = [];
            countDecorationFullWalk();
            state.doc.descendants((node, position) => {
              if (!node.isText || !node.text) {
                return;
              }

              let fromIndex = 0;
              while (fromIndex <= node.text.length) {
                const matchIndex = node.text.indexOf(query, fromIndex);
                if (matchIndex < 0) {
                  break;
                }

                decorations.push(
                  Decoration.inline(position + matchIndex, position + matchIndex + query.length, {
                    class: "search-match-highlight",
                  }),
                );
                fromIndex = matchIndex + query.length;
              }
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
        view(view) {
          const listener = (event: Event) => {
            const query = event instanceof CustomEvent && typeof event.detail?.query === "string" ? event.detail.query : "";
            view.dispatch(view.state.tr.setMeta(searchHighlightKey, query));
          };

          window.addEventListener(SEARCH_QUERY_EVENT, listener);
          return {
            destroy() {
              window.removeEventListener(SEARCH_QUERY_EVENT, listener);
            },
          };
        },
      }),
    ];
  },
});
