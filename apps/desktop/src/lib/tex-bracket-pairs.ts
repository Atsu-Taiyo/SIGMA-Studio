/**
 * TeX ソース入力欄 (`textarea`) の括弧オートペア。
 *
 * MathLive の math-field 側は同じ機能をライブラリが `smartFence` として持っているので、
 * ここは「生の TeX を打つ面」専用。挙動の規則は CodeMirror 6 の `closeBrackets`
 * (@codemirror/autocomplete) と VS Code の auto-closing brackets に合わせてある:
 *
 * 1. 開き括弧を打つ → 閉じ括弧も入り、キャレットは間に入る。ただし直後の文字が
 *    「閉じても邪魔にならない文脈」のときだけ (CodeMirror の `closeBefore` 相当)。
 *    `(` を `x+1` の直前で打って `()x+1` になるのを防ぐための規則で、その場合は
 *    開き括弧だけが入り、末尾で `)` を打てば `(x+1)` になる。
 * 2. 選択範囲があるときに開き括弧を打つ → 選択を括弧で囲む (選択は保たれる)。
 * 3. 直後が同じ閉じ括弧のときに閉じ括弧を打つ → 二重に入れず、その閉じ括弧を飛び越す。
 * 4. 括弧の間で Backspace → 対で消える。
 *
 * 判定は DOM に触らない純関数にして、キー入力の分岐をユニットテストで固定する。結果は
 * 「置換範囲 + 差し込む文字列 + 適用後の選択」で返す。全文の差し替えではなく範囲にするのは、
 * `applyTexBracketEditToTextarea` がネイティブの入力として差し込めるようにするため
 * (取り消し履歴が残り、キャレットを非同期に戻さずに済む)。`null` はブラウザ既定の入力に任せる。
 *
 * 既製パッケージを採らなかった理由: textarea 単体に付けられる維持された実装は npm 上では
 * `autopair` しか無く、そのライセンス (Adjusted MIT) が「公立学校の教員は使用不可」を
 * 明文で禁じており、教材エディタである本アプリの利用者と正面から衝突する。CodeMirror の
 * `closeBrackets` は EditorState 前提で、飛び越しと対削除が StateField に持った
 * 「自動で入れた括弧か」の履歴に依存するため、textarea へは持ち込めない。
 */

/** 入力欄の状態 (値とキャレット / 選択範囲)。 */
export interface TexBracketEditorState {
  selectionEnd: number;
  selectionStart: number;
  value: string;
}

/** 適用すべき編集。`[from, to)` を `insert` で置き換え、選択を `selection*` にする。 */
export interface TexBracketEdit {
  from: number;
  insert: string;
  selectionEnd: number;
  selectionStart: number;
  to: number;
}

/** 判定に使うキーイベントの最小形。 */
export interface TexBracketKeyEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  metaKey: boolean;
}

/** 対にする括弧。ユーザーが求めたのは `()` と `{}` で、`[]` も同じ族として揃える。 */
export const TEX_BRACKET_PAIRS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};

const TEX_ESCAPED_CURLY_OPENING = "\\{";
const TEX_ESCAPED_CURLY_CLOSING = "\\}";

/**
 * 直後がこの文字なら開き括弧を自動で閉じる (それ以外の文字が続くときは閉じない)。
 * CodeMirror 6 の `closeBrackets` 既定値 `closeBefore: ")]}:;>"` と同じ。
 */
const TEX_AUTO_CLOSE_BEFORE = ")]}:;>";

const CLOSING_TO_OPENING: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TEX_BRACKET_PAIRS).map(([opening, closing]) => [closing, opening]),
);

/**
 * キー入力を括弧オートペアとして解釈する。処理したときだけ編集内容を返す。
 */
export function resolveTexBracketEdit(
  event: TexBracketKeyEventLike,
  state: TexBracketEditorState,
): TexBracketEdit | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) {
    return null;
  }

  const { value } = state;
  const selectionStart = clampOffset(state.selectionStart, value);
  const selectionEnd = clampOffset(state.selectionEnd, value);
  const from = Math.min(selectionStart, selectionEnd);
  const to = Math.max(selectionStart, selectionEnd);

  if (event.key === "Backspace") {
    return from === to ? deleteEnclosingPair(value, from) : null;
  }

  const closing = TEX_BRACKET_PAIRS[event.key];
  if (closing) {
    if (from === to && event.key === "{" && hasUnescapedBackslashBefore(value, from)) {
      return closeEscapedCurlyPairAtCaret(value, from);
    }
    return from === to
      ? closePairAtCaret(value, from, event.key, closing)
      : wrapSelection(value, from, to, event.key, closing);
  }

  if (from === to && CLOSING_TO_OPENING[event.key]) {
    if (event.key === "}" && value.slice(from, from + TEX_ESCAPED_CURLY_CLOSING.length) === TEX_ESCAPED_CURLY_CLOSING) {
      return skipOverClosing(value, from, TEX_ESCAPED_CURLY_CLOSING);
    }
    return skipOverClosing(value, from, event.key);
  }

  return null;
}

/** `\{` を入力したときは TeX の表示用波括弧として `\{ … \}` を対にする。 */
function closeEscapedCurlyPairAtCaret(value: string, caret: number): TexBracketEdit | null {
  const nextChar = value.slice(caret, caret + 1);
  const canClose = nextChar === "" ||
    /\s/.test(nextChar) ||
    TEX_AUTO_CLOSE_BEFORE.includes(nextChar);
  if (!canClose) {
    return null;
  }

  return {
    from: caret,
    insert: `{${TEX_ESCAPED_CURLY_CLOSING}`,
    selectionEnd: caret + 1,
    selectionStart: caret + 1,
    to: caret,
  };
}

/**
 * 解決した編集を textarea へ反映し、反映後の値を返す。
 *
 * 文字の差し込みは `execCommand("insertText")` に任せる。ネイティブの入力として扱われるので
 * 取り消し履歴が残り、`input` イベント経由で React の controlled value もその場で更新される。
 * キャレットは同期で置く: 非同期 (rAF) に戻すと、続けて打った文字が古い位置に入る。
 * 呼び出し側は戻り値を state へ反映すること (execCommand 経路では同じ値なので何も起きない)。
 */
export function applyTexBracketEditToTextarea(
  textarea: HTMLTextAreaElement,
  edit: TexBracketEdit,
): string {
  const nextValue = `${textarea.value.slice(0, edit.from)}${edit.insert}${textarea.value.slice(edit.to)}`;
  if (nextValue !== textarea.value) {
    textarea.setSelectionRange(edit.from, edit.to);
    if (!document.execCommand("insertText", false, edit.insert)) {
      textarea.value = nextValue;
    }
  }
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  return nextValue;
}

/** 規則 2: 選択範囲を括弧で囲む。中身の選択はそのまま保つ。 */
function wrapSelection(
  value: string,
  from: number,
  to: number,
  opening: string,
  closing: string,
): TexBracketEdit {
  return {
    from,
    insert: `${opening}${value.slice(from, to)}${closing}`,
    selectionEnd: to + opening.length,
    selectionStart: from + opening.length,
    to,
  };
}

/** 規則 1: 閉じても邪魔にならない文脈なら対で入れ、そうでなければブラウザに任せる。 */
function closePairAtCaret(
  value: string,
  caret: number,
  opening: string,
  closing: string,
): TexBracketEdit | null {
  const nextChar = value.slice(caret, caret + 1);
  const canClose = nextChar === "" ||
    /\s/.test(nextChar) ||
    TEX_AUTO_CLOSE_BEFORE.includes(nextChar);
  if (!canClose) {
    return null;
  }

  return {
    from: caret,
    insert: `${opening}${closing}`,
    selectionEnd: caret + opening.length,
    selectionStart: caret + opening.length,
    to: caret,
  };
}

/** 規則 3: 直後の同じ閉じ括弧を飛び越す (二重入力を防ぐ)。 */
function skipOverClosing(value: string, caret: number, closing: string): TexBracketEdit | null {
  if (value.slice(caret, caret + closing.length) !== closing) {
    return null;
  }

  return {
    from: caret,
    insert: "",
    selectionEnd: caret + closing.length,
    selectionStart: caret + closing.length,
    to: caret,
  };
}

/** 規則 4: 空の対の中で Backspace を打ったら両方消す。 */
function deleteEnclosingPair(value: string, caret: number): TexBracketEdit | null {
  if (
    value.slice(caret - TEX_ESCAPED_CURLY_OPENING.length, caret) === TEX_ESCAPED_CURLY_OPENING &&
    value.slice(caret, caret + TEX_ESCAPED_CURLY_CLOSING.length) === TEX_ESCAPED_CURLY_CLOSING
  ) {
    return {
      from: caret - TEX_ESCAPED_CURLY_OPENING.length,
      insert: "",
      selectionEnd: caret - TEX_ESCAPED_CURLY_OPENING.length,
      selectionStart: caret - TEX_ESCAPED_CURLY_OPENING.length,
      to: caret + TEX_ESCAPED_CURLY_CLOSING.length,
    };
  }

  const previousChar = value.slice(caret - 1, caret);
  const nextChar = value.slice(caret, caret + 1);
  if (!previousChar || TEX_BRACKET_PAIRS[previousChar] !== nextChar) {
    return null;
  }

  return {
    from: caret - 1,
    insert: "",
    selectionEnd: caret - 1,
    selectionStart: caret - 1,
    to: caret + 1,
  };
}

/** 直前に奇数個の `\` が続くとき、次の波括弧は TeX 上でエスケープされる。 */
function hasUnescapedBackslashBefore(value: string, caret: number): boolean {
  let backslashCount = 0;
  for (let index = caret - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function clampOffset(offset: number, value: string): number {
  if (!Number.isFinite(offset)) {
    return value.length;
  }

  return Math.min(Math.max(Math.round(offset), 0), value.length);
}
