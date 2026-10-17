/**
 * MathLive 0.111 は IME 変換の開始時 (Mathfield.onCompositionStart)、選んでいる範囲を `deleteRange` で
 * 消してから変換中の文字を入れる。`deleteRange` は「分子・根号の中・上付き…の中身を丸ごと選んでいたら
 * 親ごと消す」(空の分数で Backspace したときの動き) なので、分数などを入れた直後の空欄や、クリックして
 * 選んだ空欄でそのまま変換すると、分数・根号・上付きごと消えて変換した文字だけが残っていた。
 * 英数字を打つときは選んだ範囲だけを消す (`deleteAtoms`) ので消えない。
 *
 * MathLive の処理より先に、英数字と同じく選んだ範囲だけを消しておく (MathLive からは範囲を選んで
 * いないように見え、変換中の文字はその場所 = 空欄の中に入る)。空欄を選んでいて変換を取り消したら、
 * 空欄に戻す。
 */
export type CompositionSelectionMathField = HTMLElement & {
  selection?: { ranges: Array<[number, number]> } | [number, number] | number;
  selectionIsCollapsed?: boolean;
  getValue?: (start?: number, end?: number, format?: "latex") => string;
  insert?: (text: string, options?: {
    format?: "latex";
    insertionMode?: "replaceSelection";
    selectionMode?: "placeholder";
  }) => boolean | void;
};

const MATHLIVE_SINK_SELECTOR = ".ML__keyboard-sink";
const PLACEHOLDER = String.raw`\placeholder{}`;
const installedRoots = new WeakSet<ShadowRoot>();

export function installMathLiveCompositionSelection(mathField: CompositionSelectionMathField, root: ShadowRoot) {
  if (installedRoots.has(root)) return;
  installedRoots.add(root);
  let replacedPlaceholder = false;

  // capture: sink 上の MathLive の処理 (deleteRange) より先に走らせる。
  root.addEventListener("compositionstart", (event) => {
    replacedPlaceholder = false;
    if (!isKeyboardSink(event.target) || mathField.selectionIsCollapsed !== false) return;
    const range = selectedRange(mathField.selection);
    if (!range || typeof mathField.insert !== "function") return;
    const selected = mathField.getValue?.(range[0], range[1], "latex");
    // 英数字の打鍵と同じ経路 (範囲だけを消し、親は残す) で、選んだ範囲を空にする。
    if (mathField.insert("", { insertionMode: "replaceSelection" }) === false) return;
    replacedPlaceholder = selected === PLACEHOLDER;
  }, { capture: true });

  root.addEventListener("compositionend", (event) => {
    if (!isKeyboardSink(event.target) || !replacedPlaceholder) return;
    replacedPlaceholder = false;
    // 取り消し (何も確定しなかった) なら空欄を戻し、変換を始める前と同じく選んだ状態にする。
    if ((event as CompositionEvent).data) return;
    mathField.insert?.(PLACEHOLDER, { format: "latex", selectionMode: "placeholder" });
  });
}

/** MathLive の選択 (複数範囲のこともある) 全体の [始め, 終わり]。 */
function selectedRange(selection: CompositionSelectionMathField["selection"]): [number, number] | null {
  if (selection === undefined || typeof selection === "number") return null;
  const ranges = Array.isArray(selection) ? [selection] : selection.ranges;
  const offsets = ranges.flat();
  if (offsets.length === 0) return null;
  const start = Math.min(...offsets);
  const end = Math.max(...offsets);
  return start === end ? null : [start, end];
}

function isKeyboardSink(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.matches(MATHLIVE_SINK_SELECTOR);
}
