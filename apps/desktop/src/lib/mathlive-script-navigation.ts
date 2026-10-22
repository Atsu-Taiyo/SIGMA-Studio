/**
 * 上付き・下付きの両方を持つ原子 (`\int_a^b`・`\sum_{k=1}^{n}`・`x_1^2`) の中で、↓/↑ で上下の枠を行き来する。
 *
 * MathLive 0.111 の ↑/↓ (`moveUpward` / `moveDownward`) は分数の分子・分母と配列の行だけを移り、
 * 上付き・下付きの枠の中では何も起きない (`move-out` が出るだけ)。積分や総和の上端・下端を打ち分けるとき
 * マウスに持ち替えずに済むよう、次の場合だけこちらで移す。
 *
 * - 上付きの中で ↓ → 同じ原子の下付きへ
 * - 下付きの中で ↑ → 同じ原子の上付きへ
 *
 * 枠は**いちばん内側**で決める (入れ子の上付きの中にいるなら、その上付きを持つ原子の下付きへ)。外側の枠へは
 * 登らない。次の場合は何もせず false を返し、MathLive の動きにまかせる。
 * - 反対側の枠が無い (`x^2` だけ・`\lim_{x\to0}` だけ)
 * - いちばん内側の枠が分数の分子・分母 (`above` / `below`)・根号の指数・配列のセルのとき
 * - ↓ を下付きの中で、↑ を上付きの中で押したとき (もともと行き先が無い向き)
 * - LaTeX コマンドを打っている最中 (候補の一覧を ↑/↓ で選ぶ)・編集可能な空欄 (prompt) の中
 *
 * 移した先では、その枠の**末尾**にキャレットを置く (空欄だけの枠なら、その空欄を選ぶ)。枠の長さは上下で
 * 違う (`k=1` と `n`) ので同じ位置には揃えられず、末尾なら続けて書き足せる。
 *
 * MathLive の公開 API からは原子の木が見えない。`mathlive-open-fence.ts` と同じく内部の
 * `_mathfield.model` を読む。形が変わって見つからないときは何もしない (MathLive のままの動き)。
 * 触る内部は次だけ: `model.anchor`/`position`/`at()`/`offsetOf()`/`setPositionHandlingPlaceholder()`、
 * 原子の `parent`/`parentBranch`/`branch()`/`type`/`mode`。
 */
export type ScriptBranchDirection = "up" | "down";

/** 修飾キーも変換中の打鍵も無い ↑/↓ だけを拾う (Shift+矢印の範囲選択は MathLive のまま)。 */
export function getScriptBranchArrowDirection(event: {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  metaKey: boolean;
  shiftKey: boolean;
}): ScriptBranchDirection | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.keyCode === 229) {
    return null;
  }
  return event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : null;
}

interface AtomLike {
  mode?: string;
  parent?: AtomLike | null;
  parentBranch?: unknown;
  type?: string;
  branch?: (name: string) => readonly AtomLike[] | undefined;
}

interface ModelLike {
  anchor: number;
  mathfield?: { hasEditablePrompts?: boolean; stopCoalescingUndo?: () => void };
  position: number;
  at: (offset: number) => AtomLike | undefined;
  offsetOf: (atom: AtomLike) => number;
  setPositionHandlingPlaceholder: (offset: number) => void;
}

export function moveBetweenScriptBranches(mathField: unknown, direction: ScriptBranchDirection): boolean {
  const model = (mathField as { _mathfield?: { model?: ModelLike } } | null)?._mathfield?.model;
  if (
    !model ||
    typeof model.at !== "function" ||
    typeof model.offsetOf !== "function" ||
    typeof model.setPositionHandlingPlaceholder !== "function" ||
    model.mathfield?.hasEditablePrompts
  ) {
    return false;
  }

  // 範囲を選んでいるときは、MathLive の ↓/↑ と同じく ↓ は右端・↑ は左端を基準にする。
  const offset = direction === "down" ? Math.max(model.anchor, model.position) : Math.min(model.anchor, model.position);
  const target = findOppositeScriptBranch(model.at(offset), direction);
  if (!target || target.length === 0) {
    return false;
  }
  const last = target[target.length - 1];
  const lastOffset = model.offsetOf(last);
  if (lastOffset < 0) {
    return false;
  }
  model.setPositionHandlingPlaceholder(lastOffset);
  model.mathfield?.stopCoalescingUndo?.();
  return true;
}

/** `atom` から外へたどって最初の分数・配列・上付き・下付きの枠で、行き先の枠 (反対側の枠の原子) を返す。 */
function findOppositeScriptBranch(start: AtomLike | undefined, direction: ScriptBranchDirection): readonly AtomLike[] | null {
  for (let atom = start; atom; atom = atom.parent ?? undefined) {
    if (atom.type === "latex" || atom.type === "latexgroup" || atom.mode === "latex") {
      return null;
    }
    const branch = atom.parentBranch;
    if (branch === "superscript" || branch === "subscript") {
      // ↓ は上付きの中からだけ、↑ は下付きの中からだけ。反対側の枠が無ければ MathLive にまかせる。
      if ((direction === "down") !== (branch === "superscript")) {
        return null;
      }
      return atom.parent?.branch?.(branch === "superscript" ? "subscript" : "superscript") ?? null;
    }
    // 分子・分母 (above/below)・根号の指数・配列のセル ([行, 列]) は MathLive の移動にまかせる。
    if (branch === "above" || branch === "below" || Array.isArray(branch)) {
      return null;
    }
  }
  return null;
}
