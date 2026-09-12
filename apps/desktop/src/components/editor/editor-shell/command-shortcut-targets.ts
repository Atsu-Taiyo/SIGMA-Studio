import {
  isSingleCharacterShortcut,
  type EditorCommandTargetPolicy,
  type EditorShortcutBinding,
} from "@/lib/editor-command-shortcuts";

/**
 * ショートカットを「いまフォーカスがある面」に照らして振り分ける。
 *
 * **⌘Z の 3 つの入口が全部ここを通る。** キーボード、ネイティブメニューの click (WI-1 以降
 * macOS ではこれが主), そして `beforeinput` ガードが右クリック Undo・3 本指スワイプ・
 * 支援技術から流してくる window イベント (WI-2)。判定をイベントの中に書くと、keydown を
 * 伴わない後ろ 2 つがフォーカス判定を丸ごと迂回する —— AI チャット欄で打ち間違えて ⌘Z を
 * 押すと教材本体が巻き戻る、という形で実際に壊れていた。
 */

/** 自前の編集履歴を持つ面 (SigmaDoc に入らないローカル下書き) の目印。 */
export const LOCAL_EDIT_HISTORY_ATTRIBUTE = "data-local-edit-history";

/**
 * **前に出ているモーダルの目印。文書のどこにフォーカスがあっても文書の undo を止める。**
 *
 * 祖先だけを見てはいけない: ダイアログはフォーカスを奪うとは限らず (`TableSettingsDialog` は
 * autoFocus もフォーカストラップも持たない手組み)、本文にキャレットを残したまま開く。
 * その状態の ⌘Z / 右クリック Undo が**ダイアログ越しに背後の教材**を巻き戻していた。
 *
 * 主役は `[data-modal-backdrop]`。**このリポジトリが既に持っている「モーダルが前に出ている」の
 * 印**で、背面を覆う要素にだけ付き (`ui/Modal` と手組みダイアログ)、`ToolbarPopover` /
 * `Select` / `Tooltip` は**読むだけで描かない**。`OverlayCanvasEditorClient` のキーボード
 * ハンドラも同じ印で全体を判定している (先例)。
 *
 * **`[role='dialog']` は使わない。** このアプリでは浮遊パネルにも広く付いていて
 * (ツールバーのポップオーバー・グラフ設定・コメントパネル・AI 承認カード)、それを数えると
 * **本文を編集しながら開いておく面の表示中に ⌘Z が丸ごと死ぬ** —— いま直している不具合そのもの。
 * backdrop を持たない例外 (`.preview-drawer`) のために `aria-modal="true"` と
 * `<dialog open>` の名乗りも足す。名乗るのは背面を隔離する面だけ、というのがこのリポジトリの約束。
 */
const MODAL_SURFACE_SELECTOR = "[data-modal-backdrop], [aria-modal='true'], dialog[open]";

/**
 * 加えて「**その中に**フォーカスがあるなら文書を戻さない」面。
 *
 * WI-5 以前から `documentSurface` のコマンドを止めていた面の列挙をそのまま引き継ぐ。
 * `data-non-modal-surface` / `aria-modal="false"` を持つものは対象外 (開いたままでも
 * Undo が効かなければならない、と面の側が宣言している)。
 */
const BLOCKING_SURFACE_SELECTOR =
  MODAL_SURFACE_SELECTOR
  + ", .find-widget, .command-settings-dialog, .page-settings-dialog,"
  + " .document-library-dialog, .file-access-dialog, .preview-drawer";

/**
 * `documentSurface` のコマンド (太字・削除・矢印など) を止める面。**WI-5 以前のまま。**
 *
 * undo と違ってこちらは `[role='dialog']` を含む —— 浮遊パネルにフォーカスがある間、
 * 背後の本文を書き換えるコマンドが走らないのは元からの正しい挙動で、触る理由が無い。
 * **undo だけがこの列挙から外れる**: 「パネルを開いて眺めている間 ⌘Z が死ぬ」は
 * この WI が消しに来た症状そのもので、履歴には「見ている文書を戻す」という答えがある。
 */
const DOCUMENT_SURFACE_BLOCKING_SELECTOR =
  "[role='dialog'], .find-widget, .command-settings-dialog, .page-settings-dialog,"
  + " .document-library-dialog, .file-access-dialog, .preview-drawer";

/**
 * `execCommand("undo")` が効かない `<input>` の type。
 *
 * スライダーやチェックボックスは**変更が SigmaDoc に入る**ので、ここでネイティブ欄として
 * 扱うと ⌘Z が黙って飲まれ、文書の undo が走らない (`Graph3DSettingsPanel` や
 * オーバーレイの各パネル)。テキストを打てる type だけをネイティブ欄とみなす。
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** `edit.undo` / `edit.redo` を実際にどこへ届けるか。 */
export type EditorHistoryShortcutTarget =
  /** SigmaDoc の undo/redo を実行する。 */
  | { kind: "document" }
  /**
   * その面自身の編集履歴へ届ける (コメント下書き・箱タイトル)。
   *
   * 内容が SigmaDoc に入らないので、文書の undo を走らせると「打った下書きは残ったまま
   * 無関係な教材が巻き戻る」になる。
   */
  | { kind: "surfaceHistory"; element: HTMLElement }
  /**
   * ネイティブのフィールド undo へ委譲する (AI チャット・検索欄・リネーム欄)。
   *
   * **これは「無音」ではなく「その面の undo が正しく動く」状態。** 中身は SigmaDoc に
   * 一切入っていないので、ここで文書を戻すのが最も驚く挙動になる。
   */
  | { kind: "nativeField"; element: HTMLElement }
  /**
   * MathLive の入力履歴へ譲る。
   *
   * 数式欄の打鍵は `editingTex` とプレビュー DOM しか更新せず SigmaDoc/PM には入らない
   * (コミットは Enter / blur / 矢印離脱のみ)。**まだ確定していない打鍵を戻す先はそちらしか
   * 無い** ので、`canUndo()` が真な限り譲る。
   *
   * **開いたばかりの数式欄は `canUndo()` が偽を返す** (MathLive の実装は
   * `this.index - 1 >= 0`)。つまり 1 文字も打っていない数式欄の上で ⌘Z を押すと、
   * その下の文書が 1 手戻る。**これは意図どおり** —— 直前にしていた文書編集を戻したい、
   * というのが自然な期待で、無音で何も起きないよりよい。
   */
  | { kind: "mathField"; element: MathFieldHistoryElement }
  /**
   * 前に出ているモーダルの上にいる。**文書は戻さない。**
   *
   * IME 中の `ignore` と分けているのは、こちらは「入力欄なら届けてよい」から
   * (モーダルの中の欄でもローカルな undo は正しい動作)。この結末になるのは、
   * どの入力欄でもない場所にフォーカスがあるときだけ。
   */
  | { kind: "blockedByModalSurface" }
  /** 何もしない。IME 変換中に文書を差し替えると未確定の文字列ごと壊れる。 */
  | { kind: "ignore" };

export interface MathFieldHistoryElement extends HTMLElement {
  canUndo?: () => boolean;
  canRedo?: () => boolean;
  executeCommand?: (selector: string) => boolean;
}

function isNativeTextField(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }
  if (!(element instanceof HTMLInputElement)) {
    return false;
  }
  return !NON_TEXT_INPUT_TYPES.has(element.type);
}

/** MathLive の履歴問い合わせ。未 upgrade / 別実装の要素では throw しうる。 */
function mathFieldCanRestore(element: MathFieldHistoryElement, direction: "undo" | "redo"): boolean {
  try {
    return direction === "undo" ? element.canUndo?.() === true : element.canRedo?.() === true;
  } catch {
    // カスタム要素がまだ upgrade されていない / 別実装、のどちらか。**ここで例外を漏らすと
    // keydown ハンドラごと落ちて undo 自体が起きない**ので、「譲る先が無い」に倒す。
    return false;
  }
}

/** その面自身が「背面を隔離しない」と宣言しているか。 */
function isNonModalSurface(element: Element): boolean {
  return element.hasAttribute("data-non-modal-surface")
    || element.getAttribute("aria-modal") === "false";
}

/**
 * `element` の祖先に、背面を止める面があるか。
 *
 * `closest` を 1 回で済ませない: いちばん近い面が非モーダル (グラフ設定パネル) でも、
 * その外側が本物のモーダルなら止めなければならない。
 */
function blockedBySurface(element: Element, selector: string): boolean {
  let current: Element | null = element;
  while (current) {
    const surface: HTMLElement | null = current.closest<HTMLElement>(selector);
    if (!surface) {
      return false;
    }
    if (!isNonModalSurface(surface)) {
      return true;
    }
    current = surface.parentElement;
  }
  return false;
}

const blockedByModalSurface = (element: Element) => blockedBySurface(element, BLOCKING_SURFACE_SELECTOR);

/**
 * 文書のどこかに「背面を隔離している」面が開いているか。**フォーカス位置と無関係に見る。**
 *
 * これが無いと、フォーカスが本文に残ったままダイアログが開いた状態で ⌘Z / 右クリック Undo が
 * 背後の文書を戻す。祖先だけを見る {@link blockedByModalSurface} では捕まえられない。
 */
function hasOpenModalSurface(ownerDocument: Document | null): boolean {
  if (!ownerDocument) {
    return false;
  }
  for (const surface of ownerDocument.querySelectorAll<HTMLElement>(MODAL_SURFACE_SELECTOR)) {
    if (!isNonModalSurface(surface)) {
      return true;
    }
  }
  return false;
}

export function resolveEditorHistoryShortcutTarget(params: {
  target: EventTarget | null;
  direction: "undo" | "redo";
  isComposing: boolean;
  /** 文書全体のモーダル判定に使う。省略時は `target` から辿る。 */
  ownerDocument?: Document | null;
}): EditorHistoryShortcutTarget {
  if (params.isComposing) {
    return { kind: "ignore" };
  }

  const ownerDocument = params.ownerDocument
    ?? (params.target instanceof Node ? params.target.ownerDocument : null);
  // 前に出ている面の判定は**届け先の解決とは独立**。「文書を戻すか」にだけ効かせ、
  // フォーカスされている欄への配達は止めない (止めると全面で ⌘Z が無音になる)。
  const documentBlocked = (element: Element | null) =>
    hasOpenModalSurface(ownerDocument) || (element !== null && blockedByModalSurface(element));
  const documentOrBlocked = (element: Element | null): EditorHistoryShortcutTarget =>
    documentBlocked(element) ? { kind: "blockedByModalSurface" } : { kind: "document" };

  if (!(params.target instanceof Element)) {
    return documentOrBlocked(null);
  }

  // **祖先を 1 度だけ登る。** 種類ごとに `closest` を並べると「どれが近いか」ではなく
  // 「どれを先に書いたか」で勝敗が決まる —— 下書き面の中の `<input>` にフォーカスが
  // あるのに面の履歴へ送る (逆もまた然り) という取り違えになる。近いほうが勝つのが正しい。
  //
  // 譲る先を持たない要素 (打ち終わっていない数式欄・チェックボックスやスライダー) では
  // **止まらずに登り続ける**。下書き面の中のチェックボックスは下書き面の履歴で戻すのが
  // 正しく、そこで文書へ落とすと無関係な教材が動く。
  for (let element: Element | null = params.target; element; element = element.parentElement) {
    if (element.tagName.toLowerCase() === "math-field"
      && mathFieldCanRestore(element as MathFieldHistoryElement, params.direction)) {
      return { kind: "mathField", element: element as MathFieldHistoryElement };
    }
    if (element.matches("input, textarea, select") && isNativeTextField(element)) {
      return { kind: "nativeField", element: element as HTMLElement };
    }
    if (element.getAttribute(LOCAL_EDIT_HISTORY_ATTRIBUTE) === "true") {
      return { kind: "surfaceHistory", element: element as HTMLElement };
    }
  }

  return documentOrBlocked(params.target);
}

/**
 * IME 合成が**まだ続いているか**。`compositionstart` で捕まえた要素を渡す。
 *
 * メニュー経路には `event.isComposing` が無いので合成中かを自前で持つしかないが、
 * 「立てたフラグを `compositionend` で降ろす」形は**降ろす側が来ない経路**で詰む
 * (要素の差し替え・Escape でのキャンセル・アプリ切り替え・programmatic blur)。
 * 詰まると**そのセッションのメニュー ⌘Z が永久に死ぬ**。
 *
 * そこで「立っている」ほうを毎回確かめる: 要素が DOM に居て、かつ**まだフォーカスを
 * 持っている**ことを読み取り時に検算する。合成はフォーカスのある要素でしか続かない。
 */
export function isCompositionStillActive(element: Element | null): boolean {
  if (!element || !element.isConnected) {
    return false;
  }
  const root = element.getRootNode();
  // `math-field` の合成は shadow root の中で起きる。外側から見た `activeElement` は
  // ホスト要素なので、shadow root 側の `activeElement` と突き合わせないと取り違える。
  const active = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot
    ? root.activeElement
    : element.ownerDocument.activeElement;
  if (!active) {
    return false;
  }
  return active === element || element.contains(active) || active.contains(element);
}

/**
 * このイベントは「合成がもう終わっている」ことの証拠か。
 *
 * 合成中のキーイベントは `isComposing` が真になる。偽のキー入力やポインタ操作が来たなら、
 * `compositionend` を取りこぼしていても合成は終わっている。**これが Escape キャンセルの
 * 唯一の出口**で、フラグが次の操作より長く立ち続けることを不可能にする。
 */
export function shouldEndCompositionForEvent(event: Event): boolean {
  if ("isComposing" in event) {
    return (event as KeyboardEvent).isComposing !== true;
  }
  return true;
}

/**
 * このコマンドを、いまフォーカスがある面では**走らせない**か。
 *
 * `documentSurface` (既定) は従来どおり「入力欄・ダイアログの中では本文向けのコマンドを
 * 走らせない」。`editHistory` は上の {@link resolveEditorHistoryShortcutTarget} に委ねる ——
 * **バインドが単一文字かどうかで性質を推測する形では、ユーザーがキーを再割り当てした
 * 瞬間に破綻する**ので、コマンドの性質で判定する。
 */
export function isCommandShortcutBlockedByTarget(
  target: EventTarget | null,
  policy: EditorCommandTargetPolicy,
  binding: EditorShortcutBinding,
  direction: "undo" | "redo" | null,
): boolean {
  if (policy === "editHistory") {
    // キーボード経路では「文書へ回さない」= イベントを止めない、が正しい振る舞い。
    // 止めなければ MathLive / ProseMirror / ブラウザの既定 undo がそのまま処理する。
    return resolveEditorHistoryShortcutTarget({
      target,
      direction: direction ?? "undo",
      isComposing: false,
    }).kind !== "document";
  }

  if (!(target instanceof Element)) {
    return false;
  }

  if (blockedBySurface(target, DOCUMENT_SURFACE_BLOCKING_SELECTOR)) {
    return true;
  }

  const textInput = target.closest("input, textarea, select, math-field");
  if (textInput) {
    return true;
  }

  const editable = target.closest("[contenteditable='true']");
  if (!editable) {
    return false;
  }

  return isSingleCharacterShortcut(binding);
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("input, textarea, select, math-field, [contenteditable='true']") !== null;
}

/**
 * 解決した届け先へ実際に届ける。**戻り値が `"document"` のときだけ**、呼び出し側が
 * SigmaDoc の undo/redo コマンドを走らせる。
 *
 * keydown を伴わない入口 (ネイティブメニュー・`beforeinput` ガード) のための関数。
 * キーボード経路なら「イベントを止めない」だけで MathLive / ProseMirror / ブラウザの
 * 既定 undo が処理してくれるが、そちらでは OS が既にキーを消費しているので、
 * **こちらから届けないとどこにも undo が起きない**(= 無音で死ぬ)。
 */
export function deliverHistoryShortcutToFocusedSurface(params: {
  activeElement: Element | null;
  direction: "undo" | "redo";
  isComposing: boolean;
  /**
   * 文書全体のモーダル判定に使う。**`activeElement` が `null` でも判定できるように**
   * 別で受け取る (本文にフォーカスが無い状態でダイアログが開いていることがある)。
   */
  ownerDocument?: Document | null;
  /**
   * 前に出ているモーダルの open フラグが立っているか。
   *
   * **文書を戻さないためだけに使う。** フォーカスされている入力欄・下書き面・数式欄への
   * 配達はモーダル中でも行う —— その面のローカルな undo は、モーダルが開いていようと
   * 正しい動作で、ここで止めると列挙した 12 面すべてで ⌘Z が完全に無音になる。
   */
  isModalSurfaceOpen: boolean;
  /**
   * 入力欄・下書き面・数式欄へ実際に届けるか。
   *
   * `beforeinput` ガード由来の入口では `false`。あの経路は**面ごとの振り分けを既に
   * ガード側が済ませて**いて、shell に届いた時点で「文書で戻してほしい」の意味しかない。
   * ここで下書き面へ `beforeinput` を投げ返すと、同じ合図がガードとの間で往復する。
   */
  deliverToFocusedSurface?: boolean;
}): "handled" | "document" | "ignored" {
  const resolved = resolveEditorHistoryShortcutTarget({
    target: params.activeElement,
    direction: params.direction,
    isComposing: params.isComposing,
    ownerDocument: params.ownerDocument ?? params.activeElement?.ownerDocument ?? null,
  });

  if (resolved.kind === "ignore" || resolved.kind === "blockedByModalSurface") {
    return "ignored";
  }
  if (resolved.kind === "document") {
    // モーダルの抑止が掛かるのは**ここだけ**。
    return params.isModalSurfaceOpen ? "ignored" : "document";
  }
  if (params.deliverToFocusedSurface === false) {
    return "ignored";
  }
  if (resolved.kind === "mathField") {
    resolved.element.executeCommand?.(params.direction);
    return "handled";
  }
  if (resolved.kind === "nativeField") {
    // `<input>` / `<textarea>` のフィールド undo を起こす唯一の手段。deprecated だが
    // Chromium では現役で、代替 API が無い。
    resolved.element.focus();
    resolved.element.ownerDocument.execCommand(params.direction);
    return "handled";
  }
  // 自前の履歴を持つ面 (コメント下書き・箱タイトル)。WI-2 で入れた `beforeinput` の
  // 受け口へ、OS が投げるのと同じ形の合図を送る。
  resolved.element.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: params.direction === "undo" ? "historyUndo" : "historyRedo",
  }));
  return "handled";
}
