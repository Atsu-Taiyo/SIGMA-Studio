/**
 * 提案の表示状態 (内容を隠したか・適用の失敗・破棄理由を開いているか・図形の変更前を隠したか・
 * 適用後だけを見せているか)。
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
  /**
   * 適用後の姿だけを見せているか (紙面のカードの切り替え)。差分の装飾 (変更前・単語の印・注記) を外し、
   * 本文の変更前を畳み、図形の変更前を隠す。既定は差分の表示。
   */
  afterOnly: boolean;
}

export const DEFAULT_AI_PROPOSAL_DISPLAY_STATE: Readonly<AiProposalDisplayState> = Object.freeze({
  contentHidden: false,
  applyError: null,
  dismissReasonOpen: false,
  dismissReason: "",
  beforeHidden: false,
  afterOnly: false,
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
 * 紙面のカードの状態を持つ場所。カード自身の状態 (内容を隠した・失敗・破棄理由) はカードの key に、
 * 同じ提案のカードと図形すべてに効く状態 (図形の変更前を隠す・適用後だけ) は会話の key に持つ。
 */
export interface AiProposalCardDisplayKeys {
  cardKey: string;
  conversationKey: string;
  /** 同じ会話の紙面のカードすべての key (このカードを含む)。 */
  conversationCardKeys: readonly string[];
}

type DisplayPatch = Partial<AiProposalDisplayState>;

/** 会話の key に持つ状態 (同じ提案の複数のアンカーのカードと図形を一度に切り替える)。 */
const CONVERSATION_FIELDS: ReadonlySet<keyof AiProposalDisplayState> = new Set(["beforeHidden", "afterOnly"]);

/** 紙面のカードの状態: カードの key の状態に、会話の key の状態を重ねる。 */
export function readAiProposalCardDisplayState(
  states: AiProposalDisplayStates,
  keys: AiProposalCardDisplayKeys,
  proposalIds: readonly string[],
): AiProposalDisplayState {
  const card = readAiProposalDisplayState(states, keys.cardKey, proposalIds);
  const conversation = readAiProposalDisplayState(states, keys.conversationKey, proposalIds);
  return { ...card, beforeHidden: conversation.beforeHidden, afterOnly: conversation.afterOnly };
}

/**
 * 紙面のカードの 1 回の操作を、場所ごとの書き換えに分ける。適用後だけにしたら、同じ提案のどのカードも
 * 内容を隠さない (畳んだ本文と隠した内容が両方消えると、適用前でも適用後でもない姿になる)。
 * 規則はここ 1 か所に置き、カードが自分で状態を持つとき (`applyAiProposalCardDisplayPatch`) も同じものを通す。
 */
export function routeAiProposalCardDisplayPatch(
  patch: DisplayPatch,
  keys: AiProposalCardDisplayKeys,
): Array<[string, DisplayPatch]> {
  const conversationPatch: DisplayPatch = {};
  const cardPatch: DisplayPatch = {};
  for (const field of Object.keys(patch) as Array<keyof AiProposalDisplayState>) {
    Object.assign(CONVERSATION_FIELDS.has(field) ? conversationPatch : cardPatch, { [field]: patch[field] });
  }
  const patches = new Map<string, DisplayPatch>();
  const add = (key: string, part: DisplayPatch) => {
    if (Object.keys(part).length > 0) {
      patches.set(key, { ...patches.get(key), ...part });
    }
  };
  add(keys.conversationKey, conversationPatch);
  if (patch.afterOnly === true) {
    for (const cardKey of keys.conversationCardKeys) {
      add(cardKey, { contentHidden: false });
    }
  }
  add(keys.cardKey, cardPatch);
  return [...patches];
}

const SELF_KEYS: AiProposalCardDisplayKeys = { cardKey: "", conversationKey: "", conversationCardKeys: [""] };

/** カードが自分で状態を持つとき (単独で描くとき)。紙面と同じ規則 (`routeAiProposalCardDisplayPatch`) で書き換える。 */
export function applyAiProposalCardDisplayPatch(state: AiProposalDisplayState, patch: DisplayPatch): AiProposalDisplayState {
  return routeAiProposalCardDisplayPatch(patch, SELF_KEYS).reduce<AiProposalDisplayState>(
    (next, [, part]) => ({ ...next, ...part }),
    state,
  );
}

/**
 * 適用後の姿を紙面に組んでいるか: 適用後だけを選び、内容を隠していない。内容を隠したカードは本文を畳まない。
 */
export function showsAiProposalResultOnly(state: Pick<AiProposalDisplayState, "afterOnly" | "contentHidden">): boolean {
  return state.afterOnly && !state.contentHidden;
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
