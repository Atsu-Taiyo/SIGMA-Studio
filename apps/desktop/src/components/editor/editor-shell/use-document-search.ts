"use client";

import { SEARCH_QUERY_EVENT } from "@/components/editor/editor-shell/constants";
import type { DocumentChange } from "@/components/editor/editor-shell/types";
import { shouldDispatchSearchQuery } from "@/components/editor/search-query-dispatch";
import { setLatestSearchQuery } from "@/components/tiptap/search-highlight-extension";
import { type SigmaDocument } from "@/features/document";
import { countTextMatches,findFirstBlockWithText,replaceInDocument } from "@/features/text-editing";
import { useEffect,useMemo,useRef,useState } from "react";
import { tEditor } from "./editor-translations";

export function useDocumentSearchState() {
  const [searchQuery, setSearchQuery] = useState("");
  /** 直近に検索ハイライトへ通知した検索語 (未通知なら null)。 */
  const lastDispatchedSearchQueryRef = useRef<string | null>(null);
  const [replaceText, setReplaceText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  useEffect(() => {
    // これから生まれるエディタが初期 state に使う「現在の検索語」はシェルが宣言する
    // (マウント時の空文字も含めて必ず通るので、前のシェルの検索語を引きずらない)。
    setLatestSearchQuery(searchQuery);

    // 通知は検索語が変わった時だけ。文書は deps に入れない — ハイライトは各エディタの
    // プラグイン state に入った検索語と doc から毎回導出されるので、打鍵のたびに通知し直すと
    // 本文ユニット数だけ ProseMirror の transaction が増えるだけで表示は変わらない。
    if (!shouldDispatchSearchQuery(lastDispatchedSearchQueryRef.current, searchQuery)) {
      return;
    }

    // Debounced so per-keystroke highlight updates don't re-render the document.
    const timeoutId = window.setTimeout(() => {
      lastDispatchedSearchQueryRef.current = searchQuery;
      window.dispatchEvent(new CustomEvent(SEARCH_QUERY_EVENT, { detail: { query: searchQuery } }));
    }, searchQuery ? 150 : 0);
    return () => window.clearTimeout(timeoutId);
  }, [searchQuery]);

  return { searchOpen, setSearchOpen, replaceOpen, setReplaceOpen, searchQuery, setSearchQuery, replaceText, setReplaceText };
}

interface SearchCommandPorts {
  document: SigmaDocument;
  selectedId: string | null;
  searchQuery: string;
  replaceText: string;
  /**
   * 紙面に描かれていないブロック (畳んだ表示)。探さず数えない。置換はそのまま文書の変更口へ渡し、
   * 見えないブロックを書き換える変更は変更口が断る (断った理由は変更口が出す)。
   */
  hiddenBlockIds?: ReadonlySet<string>;
  /**
   * 表示の絞り込み (設定 > 表示) で紙面に描かれていないブロック。探さず数えず、置換もしない
   * (変更口はこれを断らないので、置換の側で避ける。見えないまま書き換えない)。
   */
  skippedBlockIds?: ReadonlySet<string>;
  setSelectedId: (id: string) => void;
  setStatusMessage: (message: string) => void;
  /** 文書を変えたら true。断ったら false (理由は変更口が出しているので、ここでは何も言わない)。 */
  commitDocumentChange: (change: DocumentChange) => boolean | void;
}
export function useDocumentSearchCommands({ document, selectedId, searchQuery, replaceText, hiddenBlockIds: collapsedBlockIds, skippedBlockIds, setSelectedId, setStatusMessage, commitDocumentChange }: SearchCommandPorts) {
  const hiddenBlockIds = useMemo(
    () => !skippedBlockIds || skippedBlockIds.size === 0
      ? collapsedBlockIds
      : !collapsedBlockIds || collapsedBlockIds.size === 0
        ? skippedBlockIds
        : new Set([...collapsedBlockIds, ...skippedBlockIds]),
    [collapsedBlockIds, skippedBlockIds],
  );
  const findNext = () => {
    const match = findFirstBlockWithText(document.content, searchQuery, selectedId, "next", hiddenBlockIds);
    if (!match) {
      setStatusMessage(tEditor("status.noSearchResults"));
      return;
    }

    setSelectedId(match.id);
    window.document.getElementById(match.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setStatusMessage(tEditor("status.searchResultSelected"));
  };

  const findPrevious = () => {
    const match = findFirstBlockWithText(document.content, searchQuery, selectedId, "previous", hiddenBlockIds);
    if (!match) {
      setStatusMessage(tEditor("status.noSearchResults"));
      return;
    }

    setSelectedId(match.id);
    window.document.getElementById(match.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setStatusMessage(tEditor("status.searchResultSelected"));
  };

  const replaceNext = () => {
    const match = findFirstBlockWithText(document.content, searchQuery, selectedId, "next", hiddenBlockIds);
    if (!match) {
      setStatusMessage(tEditor("status.nothingToReplace"));
      return;
    }

    if (commitDocumentChange((current) => replaceInDocument(current, searchQuery, replaceText, false, { skipBlockIds: skippedBlockIds })) === false) {
      return;
    }
    setSelectedId(match.id);
    setStatusMessage(tEditor("status.replacedOne"));
  };

  const replaceAll = () => {
    const count = countTextMatches(document.content, searchQuery, hiddenBlockIds);
    if (count === 0) {
      setStatusMessage(tEditor("status.nothingToReplace"));
      return;
    }

    if (commitDocumentChange((current) => replaceInDocument(current, searchQuery, replaceText, true, { skipBlockIds: skippedBlockIds })) === false) {
      return;
    }
    setStatusMessage(tEditor("status.replacedMany", { matches: count }));
  };

  const searchMatchCount = useMemo(
    () => countTextMatches(document.content, searchQuery, hiddenBlockIds),
    [document.content, hiddenBlockIds, searchQuery],
  );

  return { findNext, findPrevious, replaceNext, replaceAll, searchMatchCount };
}
