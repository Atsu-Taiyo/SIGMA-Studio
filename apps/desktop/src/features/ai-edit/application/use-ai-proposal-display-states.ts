"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  patchAiProposalDisplayState,
  pruneAiProposalDisplayStates,
  type AiProposalDisplayState,
  type AiProposalDisplayStates,
} from "../model/proposal-display-state";

const EMPTY_DISPLAY_STATES: AiProposalDisplayStates = new Map();

/**
 * 提案の表示状態 (内容を隠した・適用の失敗・破棄理由・変更前を隠した) をカードの外に持つ。
 * 紙面のカードは改ページで切れると続きが別のインスタンスで描かれ、key は会話単位で固定なので、
 * カードの state にすると食い違ったり追加ターンに残ったりする (`model/proposal-display-state.ts`)。
 *
 * 場所の key: 紙面のカードはカードの key、浮かぶバーと「変更前を隠す」は会話の key。
 * 状態は提案 id の組と一緒に覚え、今の場所・提案に無いものは書き換えのたびに捨てる。
 *
 * 書き込むときの提案 id の組は、その場所の**今の**組を使う (渡された組は場所が無いときの代わり)。
 * 適用の結果は await の後に届くので、押した時点の組で書くと、その間に同じ部屋の追加ターンで提案が
 * 増えたとき失敗が古い組に書かれて見えなくなる。追加ターンより前に書いた状態 (隠した・失敗) は
 * 組が変わるので既定に戻る。
 */
export function useAiProposalDisplayStates(live: ReadonlyMap<string, readonly string[]>) {
  const [states, setStates] = useState<AiProposalDisplayStates>(EMPTY_DISPLAY_STATES);
  const liveRef = useRef(live);
  useLayoutEffect(() => {
    liveRef.current = live;
  }, [live]);
  const update = useCallback((key: string, proposalIds: readonly string[], patch: Partial<AiProposalDisplayState>) => {
    setStates((previous) => patchAiProposalDisplayState(
      pruneAiProposalDisplayStates(previous, liveRef.current),
      key,
      liveRef.current.get(key) ?? proposalIds,
      patch,
    ));
  }, []);
  return [states, update] as const;
}
