"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";

import type {
  WorkspaceBodySearchExcerpt,
  WorkspaceBodySearchHandle,
  WorkspaceBodySearchUpdate,
} from "@/lib/workspace-body-search-contract";
import { canSearchWorkspaceBodies, openWorkspaceBodySearch } from "@/lib/workspace-repository";

/** 打鍵が続く間は送らず、止まったら送る。 */
const QUERY_DEBOUNCE_MS = 120;

const NO_HITS: ReadonlyMap<string, WorkspaceBodySearchExcerpt> = new Map();

interface BodySearchResult {
  queryId: number;
  query: string;
  hits: ReadonlyMap<string, WorkspaceBodySearchExcerpt>;
  /** まだ読んでいない教材の数。0 で出そろった。 */
  pending: number;
}

interface OpenSession {
  handle: WorkspaceBodySearchHandle;
  /** 最後に送った検索語。届いた答えのうち、これ以外への答えは捨てる。 */
  latest: { queryId: number; query: string } | null;
  nextQueryId: number;
}

export interface WorkspaceBodySearchState {
  /** 本文で一致した教材と、その抜粋。 */
  hits: ReadonlyMap<string, WorkspaceBodySearchExcerpt>;
  /** 今の検索語の結果がまだ出そろっていない (この間は「一致なし」を出さない)。 */
  pending: boolean;
}

/**
 * 検索欄の語で全教材の本文を探す。題名の絞り込みとは別に同時に始め、見つかったものから届く。
 * `warm` (検索欄に入った) の間は語が空でも開いておき、教材の一覧を先に取らせて最初の 1 文字で待たせない。
 * 検索欄を離れて語も空なら閉じる (main の索引は残るので、次に開いたときもすぐ答えられる)。
 */
export function useWorkspaceBodySearch(query: string, options: { warm?: boolean } = {}): WorkspaceBodySearchState {
  const trimmed = query.trim();
  const active = trimmed.length > 0;
  const open = active || Boolean(options.warm);
  const available = useMemo(() => open && canSearchWorkspaceBodies(), [open]);
  const sessionRef = useRef<OpenSession | null>(null);
  const [result, setResult] = useState<BodySearchResult | null>(null);

  useEffect(() => {
    if (!available) return;
    let session: OpenSession | null = null;
    const handle = openWorkspaceBodySearch((update) => {
      const latest = session?.latest;
      if (!latest || update.queryId !== latest.queryId) return;
      // 届いた結果で一覧を組み直すのは、打鍵より後でよい。
      startTransition(() => setResult((current) => applyUpdate(current?.queryId === update.queryId ? current : null, update, latest.query)));
    });
    if (!handle) return;
    session = { handle, latest: null, nextQueryId: 1 };
    sessionRef.current = session;
    return () => {
      handle.close();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [available]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!available || !session) return;
    const queryId = session.nextQueryId++;
    const send = () => {
      session.latest = { queryId, query: trimmed };
      session.handle.setQuery(queryId, trimmed);
    };
    // 開いて最初の語 (検索欄に入っただけの空の語の次も) は、題名の絞り込みと同時に始めるため待たない。
    if (session.latest === null || session.latest.query === "") {
      send();
      return;
    }
    const timer = window.setTimeout(send, QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [available, trimmed]);

  if (!available || !active) return { hits: NO_HITS, pending: false };
  if (result?.query === trimmed) return { hits: result.hits, pending: result.pending !== 0 };
  // 新しい答えが届くまでは、語を足した・削っただけなら前の一致を出したままにする (打鍵のたびに消えて点滅しないように)。
  const related = result !== null && (trimmed.includes(result.query) || result.query.includes(trimmed));
  return { hits: related ? result.hits : NO_HITS, pending: true };
}

function applyUpdate(current: BodySearchResult | null, update: WorkspaceBodySearchUpdate, query: string): BodySearchResult {
  const hits = new Map(update.reset || !current ? [] : current.hits);
  for (const fileId of update.removed) hits.delete(fileId);
  for (const hit of update.hits) hits.set(hit.fileId, hit.excerpt);
  return { queryId: update.queryId, query, hits, pending: update.pending };
}
