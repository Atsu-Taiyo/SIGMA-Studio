import { hasFullWidthAscii, toHalfWidthAscii } from "@/lib/half-width-ascii";

/**
 * 数式の入力欄へ**確定した**全角の英数・記号 (`ｘ＋１`) を、半角 (`x+1`) にして MathLive へ渡す。
 *
 * 数式に入ると IME を英数へ切り替える (`electron/input-source.ts`) が、切り替えは非同期なので最初の数打鍵は
 * 全角で確定することがあり、英語の入力ソースが無い環境では切り替えそのものが失敗する。どちらでも
 * 全角の `ｘ` が数式に残らないよう、入力欄に届く確定文字だけをここで直す。
 *
 * MathLive が文字を受ける口は 2 つ (隠し要素 `.ML__keyboard-sink` の中):
 * - 変換を挟まない入力 (全角英数モードの直接入力) の `input`
 * - 変換 (ひらがなモードで打った `ｘ＋１` を Enter で確定) の `compositionend`
 * どちらも `event.data` をそのまま文字として使うので、MathLive の処理より先 (capture) に `data` を
 * 半角にした値へ差し替える。イベントを作り直さないので、MathLive 側の打鍵の扱い (括弧・`/` の分数など)
 * は半角で打ったときと同じになる。
 *
 * **変換中の文字には触れない** (`compositionupdate` と `isComposing` の `input`)。変換中の文字は IME が
 * 持つ未確定の文字で、書き換えると変換の候補や確定が食い違う。かな・漢字は `\text{…}` で使うので、
 * 全角 ASCII 範囲の外は何もしない。
 */
const MATHLIVE_SINK_SELECTOR = ".ML__keyboard-sink";
/** MathLive の sink の `input` 受けが無視する入力 (`delegateKeyboardEvents`)。こちらも触らない。 */
const IGNORED_INPUT_TYPES: ReadonlySet<string> = new Set(["insertCompositionText", "insertFromPaste"]);

const installedRoots = new WeakSet<ShadowRoot>();

export function installMathLiveHalfWidthInput(root: ShadowRoot) {
  if (installedRoots.has(root)) return;
  installedRoots.add(root);

  // capture: sink 上の MathLive の処理 (`event.data` を読む) より先に値を差し替える。
  root.addEventListener("input", (event) => {
    if (!isKeyboardSink(event.target)) return;
    const input = event as InputEvent;
    if (input.isComposing || IGNORED_INPUT_TYPES.has(input.inputType)) return;
    replaceCommittedData(input);
  }, { capture: true });

  root.addEventListener("compositionend", (event) => {
    if (!isKeyboardSink(event.target)) return;
    replaceCommittedData(event as CompositionEvent);
  }, { capture: true });
}

function replaceCommittedData(event: InputEvent | CompositionEvent) {
  const data = event.data;
  if (typeof data !== "string" || !hasFullWidthAscii(data)) return;
  // `data` はイベントの prototype にある読み取り専用の getter。このイベントだけに値を持たせて隠す。
  Object.defineProperty(event, "data", { configurable: true, value: toHalfWidthAscii(data) });
}

function isKeyboardSink(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.matches(MATHLIVE_SINK_SELECTOR);
}
