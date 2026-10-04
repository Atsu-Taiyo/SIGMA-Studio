/**
 * 提案の表示状態 (内容を隠したか・適用の失敗・破棄理由を開いているか・図形の変更前を隠したか)。
 *
 * 紙面のカードは改ページで切れると、続きが同じ `content` を別の React インスタンスで描き直す。
 * カード自身の state に持つと正本と複製で食い違い、作り直しで消えるので、状態はカードの外
 * (紙面の拡張を組む側) に置き、正本と複製の両方が同じ値を props で読む。
 *
 * カードの key は会話単位で固定 (同じ部屋の追加ターンで作り直さない) なので、key だけで状態を
 * 引くと、追加ターンで増えた提案に前の「隠した」「失敗した」が残る。状態は提案 id の組と一緒に
 * 覚え、組が変わったら既定に戻す。
 */
export interface AiProposalDisplayState {
  /** 内容を隠してバーだけ残しているか。 */
  contentHidden: boolean;
  /** 直近の適用の失敗の理由。 */
  applyError: string | null;
  /** 破棄理由のポップオーバーが開いているか。 */
  dismissReasonOpen: boolean;
  /** 破棄理由の入力中の文 (カードが作り直されても残す)。 */
  dismissReason: string;
  /** 図形の変更前 (赤の破線) を隠しているか。 */
  beforeHidden: boolean;
}

export const DEFAULT_AI_PROPOSAL_DISPLAY_STATE: Readonly<AiProposalDisplayState> = Object.freeze({
  contentHidden: false,
  applyError: null,
  dismissReasonOpen: false,
  dismissReason: "",
  beforeHidden: false,
});

interface AiProposalDisplayEntry {
  /** どの提案についての状態か (提案 id の組。並び順によらない)。 */
  signature: string;
  state: AiProposalDisplayState;
}

/** 表示の場所 (カードの key など) → 状態。 */
export type AiProposalDisplayStates = ReadonlyMap<string, AiProposalDisplayEntry>;

function signatureOf(proposalIds: readonly string[]): string {
  return [...proposalIds].sort().join("\u0000");
}

/** その場所の、今の提案についての状態。覚えている状態が別の提案のものなら既定。 */
export function readAiProposalDisplayState(
  states: AiProposalDisplayStates,
  key: string,
  proposalIds: readonly string[],
): AiProposalDisplayState {
  const entry = states.get(key);
  return entry && entry.signature === signatureOf(proposalIds) ? entry.state : DEFAULT_AI_PROPOSAL_DISPLAY_STATE;
}

/** 状態の一部を書き換えた新しい表。別の提案の状態だった場所は既定から始める。 */
export function patchAiProposalDisplayState(
  states: AiProposalDisplayStates,
  key: string,
  proposalIds: readonly string[],
  patch: Partial<AiProposalDisplayState>,
): AiProposalDisplayStates {
  const next = new Map(states);
  next.set(key, {
    signature: signatureOf(proposalIds),
    state: { ...readAiProposalDisplayState(states, key, proposalIds), ...patch },
  });
  return next;
}

/**
 * 今は無い場所・別の提案に変わった場所の状態を捨てる。何も捨てなければ同じ表を返す
 * (React の state 更新を空振りさせる)。
 */
export function pruneAiProposalDisplayStates(
  states: AiProposalDisplayStates,
  live: ReadonlyMap<string, readonly string[]>,
): AiProposalDisplayStates {
  let next: Map<string, AiProposalDisplayEntry> | null = null;
  for (const [key, entry] of states) {
    const proposalIds = live.get(key);
    if (proposalIds && signatureOf(proposalIds) === entry.signature) {
      continue;
    }
    next ??= new Map(states);
    next.delete(key);
  }
  return next ?? states;
}
