/**
 * キーボードで本文から数式を開いた直後 (Ctrl+M・Ctrl+/ など) の打鍵を、入力欄が焦点を取るまで預かる。
 *
 * 入力欄ができて実際に焦点を取るのは 100ms ほど後 (数フレームの準備に加え、MathLive は focus() の
 * 60ms 後に受け口へ焦点を移す) で、その間に打った文字は本文 (ProseMirror) へ届き、数式の外
 * (右隣) に入っていた。預かったキーは、入力欄が焦点を取った時点で実際の打鍵と同じ
 * 「keydown → 文字入力」の順に入力欄へ流す。本文から押した Ctrl+/ などのショートカット自体も
 * ここへ積むので、「Ctrl+M で数式に入ってから押した」のと同じ処理を通る。数式パレットのテンプレートも
 * 同じ列に積み、入力欄が焦点を取ったら数式の中のショートカットと同じ挿入で入れる。
 */

/** 数式の入力欄へテンプレートを入れる依頼。入力欄が受けたら `preventDefault()` する。 */
export const INSERT_INLINE_MATH_TEMPLATE_EVENT = "sigma-studio:insert-inline-math-template";
export type InsertInlineMathTemplateDetail = { tex: string };

export type InlineMathTypeAheadKey = {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  keyCode: number;
  location: number;
  metaKey: boolean;
  shiftKey: boolean;
};

type InlineMathTypeAheadInput = InlineMathTypeAheadKey | { template: string };

type HeldTypeAhead = {
  cleanups: Array<() => void>;
  /** 入力欄が開かなかったとき用: 預かりをやめ、打たれたキーを今の焦点 (本文) へ返す。 */
  giveBack: () => void;
  id: string;
  inputs: InlineMathTypeAheadInput[];
  ownerWindow: Window;
  /** 預かりをやめる (キーは流し終えたか、別の預かりへ移した)。 */
  release: () => void;
};

/** 入力欄が焦点を取らないまま打鍵を奪い続けないための上限。 */
const INLINE_MATH_TYPE_AHEAD_TIMEOUT_MS = 3000;
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Fn", "Meta", "OS", "Shift"]);

let held: HeldTypeAhead | null = null;

export function toInlineMathTypeAheadKey(event: Pick<KeyboardEvent, keyof InlineMathTypeAheadKey>): InlineMathTypeAheadKey {
  return {
    altKey: event.altKey,
    code: event.code,
    ctrlKey: event.ctrlKey,
    key: event.key,
    keyCode: event.keyCode,
    location: event.location,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

/** `id` の数式の入力欄が焦点を取るまで、以後の打鍵を預かる。`initialKeys` は先頭に積むキー。 */
export function holdInlineMathTypeAhead(id: string, initialKeys: readonly InlineMathTypeAheadKey[] = []): void {
  if (!id || typeof window === "undefined") {
    return;
  }
  held?.release();

  const ownerWindow = window;
  const inputs: InlineMathTypeAheadInput[] = [...initialKeys];
  const handleKeyDown = (event: KeyboardEvent) => {
    // 流し直している合成キーは預からない。
    if (!event.isTrusted || MODIFIER_KEYS.has(event.key) || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.metaKey) {
      // Cmd 系 (保存・取り消しなど) は数式の中の打鍵ではない。本文の操作として通す。
      entry.giveBack();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    inputs.push(toInlineMathTypeAheadKey(event));
  };
  const entry: HeldTypeAhead = {
    cleanups: [],
    id,
    inputs,
    ownerWindow,
    release: () => {
      for (const cleanup of entry.cleanups.splice(0)) {
        cleanup();
      }
      if (held === entry) {
        held = null;
      }
    },
    giveBack: () => {
      // 本文が処理済みのショートカット (先頭に積んだキー) とテンプレートは返さない。返すと同じ数式を
      // また開く。
      const typed = entry.inputs.splice(0)
        .filter((input): input is InlineMathTypeAheadKey => !("template" in input) && !initialKeys.includes(input));
      entry.release();
      for (const key of typed) {
        dispatchTypedKey(ownerWindow.document, key);
      }
    },
  };
  ownerWindow.addEventListener("keydown", handleKeyDown, true);
  ownerWindow.addEventListener("pointerdown", entry.giveBack, true);
  const timeout = ownerWindow.setTimeout(entry.giveBack, INLINE_MATH_TYPE_AHEAD_TIMEOUT_MS);
  entry.cleanups.push(() => {
    ownerWindow.clearTimeout(timeout);
    ownerWindow.removeEventListener("keydown", handleKeyDown, true);
    ownerWindow.removeEventListener("pointerdown", entry.giveBack, true);
  });
  held = entry;
}

/** `id` の数式のために打鍵を預かっている最中か。 */
export function isHoldingInlineMathTypeAhead(id: string): boolean {
  return held?.id === id;
}

/** `id` の数式の入力欄が焦点を取ったら、預かっているキーより先にテンプレートを入れる。 */
export function queueInlineMathTemplate(id: string, tex: string): void {
  if (!isHoldingInlineMathTypeAhead(id)) {
    holdInlineMathTypeAhead(id);
  }
  held?.inputs.unshift({ template: tex });
}

/**
 * 焦点のある数式の入力欄へ、数式の中でショートカットを押したのと同じ挿入でテンプレートを入れる。
 * 入力欄が受けたら true (焦点が数式の入力欄に無ければ false)。
 */
export function insertTemplateIntoFocusedInlineMathField(tex: string, ownerDocument: Document = document): boolean {
  const target = getDeepActiveElement(ownerDocument);
  if (!target) {
    return false;
  }
  const event = new CustomEvent<InsertInlineMathTemplateDetail>(INSERT_INLINE_MATH_TEMPLATE_EVENT, {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: { tex },
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** 入力欄が開かなかった (編集ロック中・数式ができなかった) ときに呼ぶ。打たれたキーは本文へ返す。 */
export function releaseInlineMathTypeAhead(id: string): void {
  if (held?.id === id) {
    held.giveBack();
  }
}

/**
 * 入力欄 `field` に焦点を渡した直後に呼ぶ。焦点が実際に `field` の中へ入った時点で、預かっていた
 * キーを打鍵として流す。流し終えるまでに打たれたキーも引き続き預かり、順番どおりに流す。
 */
export function replayInlineMathTypeAhead(id: string, field: HTMLElement): void {
  const entry = held;
  if (!entry || entry.id !== id) {
    return;
  }
  if (containsDeepFocus(field)) {
    deliverAfterNextFrame(entry, field);
    return;
  }
  // MathLive は focus() の 60ms 後に受け口へ焦点を移す。
  const handleFocusIn = () => deliverAfterNextFrame(entry, field);
  field.addEventListener("focusin", handleFocusIn, { once: true });
  entry.cleanups.push(() => field.removeEventListener("focusin", handleFocusIn));
}

/**
 * 1 打鍵ずつ、次のフレームの後で流す。開いた直後の入力欄は次のフレームで下書きとキャレットを
 * 整え (TeX 入力欄)、確定 (Enter など) した後の本文は次のフレームで焦点とキャレットを戻す。
 * 実際の打鍵と同じく、それが済んでから次のキーを受け取らせる。
 */
function deliverAfterNextFrame(entry: HeldTypeAhead, field: HTMLElement | null): void {
  const { ownerWindow } = entry;
  let timeout = 0;
  const frame = ownerWindow.requestAnimationFrame(() => {
    timeout = ownerWindow.setTimeout(() => deliver(entry, field), 0);
  });
  entry.cleanups.push(() => {
    ownerWindow.cancelAnimationFrame(frame);
    ownerWindow.clearTimeout(timeout);
  });
}

function deliver(entry: HeldTypeAhead, field: HTMLElement | null): void {
  if (held !== entry) {
    return;
  }
  const input = entry.inputs.shift();
  if (!input) {
    entry.release();
    return;
  }
  if ("template" in input) {
    insertTemplateIntoFocusedInlineMathField(input.template, entry.ownerWindow.document);
  } else {
    dispatchTypedKey(entry.ownerWindow.document, input);
  }
  if (held !== entry) {
    // 流したキーが別の数式を開いた。残りはそちらの入力欄へ。
    held?.inputs.push(...entry.inputs.splice(0));
    return;
  }
  // 確定 (Enter など) で数式を出たら、残りは焦点の戻った本文へ流す。
  deliverAfterNextFrame(entry, field && containsDeepFocus(field) ? field : null);
}

function dispatchTypedKey(ownerDocument: Document, key: InlineMathTypeAheadKey): void {
  const target = getDeepActiveElement(ownerDocument);
  if (!target) {
    return;
  }
  const keydown = new KeyboardEvent("keydown", {
    ...key,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(keydown);
  if (keydown.defaultPrevented || key.ctrlKey || key.metaKey || Array.from(key.key).length !== 1) {
    return;
  }
  // 合成した keydown は文字を入れない。ブラウザの編集経路 (beforeinput → input) で入れると、
  // MathLive のキーボード受け口も TeX 入力欄の textarea も本文も、実際の打鍵と同じに受け取る。
  ownerDocument.execCommand("insertText", false, key.key);
}

function containsDeepFocus(field: HTMLElement): boolean {
  const active = getDeepActiveElement(field.ownerDocument);
  return Boolean(active && (field === active || field.contains(active) || field.shadowRoot?.contains(active)));
}

export function getDeepActiveElement(ownerDocument: Document): Element | null {
  let active = ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}
