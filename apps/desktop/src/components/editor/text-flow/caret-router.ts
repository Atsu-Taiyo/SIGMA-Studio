import type { Editor } from "@tiptap/core";

import {
  buildCaretFragmentTable,
  nextSurfaceInVisualOrder,
  resolveCaretSurface,
  resolveVerticalMove,
  type CaretFragmentPlacement,
  type CaretFragmentSourceLayout,
} from "@/features/rendering/core";
import type { CaretAddress, TextFlowSelectionBookmark } from "@/features/text-editing";

import { guardCaretAgainstForeignScroll } from "./caret-scroll";
import type { TextRunEditorHandle } from "./text-run-span";

/**
 * 本文を編集できる面 (surface) の単一 registry。
 *
 * ページや段を跨ぐブロックは、正本の面と断片ごとの複製の面という **N+1 個の編集面**に描かれ、
 * どれも同じ SigmaDoc id を持つ。以前は用途ごとに別々の Map (跨ぎ選択用・断片選択用) が面を
 * 覚えていて、面の集合が用途ごとに食い違っていた。ここに 1 本化する。
 *
 * **登録は `editor` 1 つにつき 1 回**で、打鍵のたびに変わる情報 (担当ブロック列・並び順・断片の
 * レイアウト) は登録に含めない。含めると再登録が走り、その解除が跨ぎ選択を消してしまう。
 * 変わる情報は `updateCaretSurfaceFacets` で書き換える。
 */
export interface CaretSurfaceId {
  kind: "unit" | "fragmentReplica" | "richText";
  /** 本文チャンクの id (kind: "unit")。 */
  unitId?: string;
  /** 複製が見せているブロックの id (kind: "fragmentReplica")。 */
  blockId?: string;
  /** 複製が見せている断片の番号。正本は 0。 */
  fragmentIndex?: number;
}

export interface CaretSurfaceHandle {
  editor: Editor;
  surface: CaretSurfaceId;
  /** 文書順を表すタプル。空配列は「順番を持たない面」= 上下移動の行き先にしない。 */
  order: readonly number[];
  /** この面がそのブロックを見せているか。 */
  ownsBlock: (blockId: string) => boolean;
  addressAt: (position: number) => CaretAddress | null;
  posFor: (address: CaretAddress) => number | null;
  /**
   * **分割されたブロックの上端**からの縦位置 (拡大前の紙面 px)。原点を `containerBlockId` に
   * するので、断片の帯 (`sourceOffsetY`) と同じ原点になる。
   */
  localYFor: (address: CaretAddress, containerBlockId: string) => number | null;
  /**
   * そのブロックを含んでいる「分割されたブロック」の id。1 つのユニットは複数の分割された
   * ブロックを持ちうるので、面ごとに 1 つへ潰さずキャレットの位置ごとに解決する。
   */
  fragmentBlockIdFor: (blockId: string) => string | null;
  /** この面が関わる断片ブロックの id 一覧 (正本は複数持ちうる)。 */
  boxIds: readonly string[];
  /**
   * この面へキャレットを適用してフォーカスを取る。適用できなければ false。
   *
   * 適用の仕方 (ProseMirror の選択の作り方・書式の張り直し) は面が知っている。ルーターは
   * **どの面に配るか**だけを決める。
   */
  applyCaret: (selection: TextFlowSelectionBookmark) => boolean;
  /**
   * 次の行までの送り (拡大前の紙面 px)。キャレット矩形の高さではなく**実測の送り**を返す
   * — 段落と段落の間には余白があり、矩形の高さで代用すると「次の行はまだ同じ断片」と誤る。
   */
  caretLineAdvance: (containerBlockId: string, direction: "up" | "down") => number | null;
  /**
   * 分割されたブロックの中の縦位置へキャレットを置いてフォーカスを取る。横位置は画面上の
   * px (`preferredX`) で、面の可視帯に収める。
   */
  focusCaretAtLocalY: (input: {
    containerBlockId: string;
    localY: number;
    preferredX: number;
  }) => boolean;
  /** 面の一番上 / 一番下の行へキャレットを置く。 */
  focusCaretAtEdge: (edge: "top" | "bottom", preferredX: number) => boolean;
  /**
   * 分割されたブロックの直前 / 直後のブロックへキャレットを置く。`preferredX` が null なら
   * 横位置を選ばず論理的な端 (直後の先頭 / 直前の末尾) に置く — 左右移動の出口が使う。
   */
  focusCaretAfterBlock: (
    containerBlockId: string,
    direction: "up" | "down",
    preferredX: number | null,
  ) => boolean;
  /** 同じ doc の、その向きにある次のテキストブロックの位置。無ければ null。 */
  adjacentTextblockAddress: (direction: "up" | "down") => CaretAddress | null;
  /** この面の doc の先頭 / 末尾のキャレット位置。左右移動がユニット境界を渡るときの行き先。 */
  docEdgeAddress: (edge: "start" | "end") => CaretAddress | null;
  /** キャレットが可視域の外なら、紙面をスクロールして見える位置へ入れる。 */
  ensureCaretVisible: () => void;
  /** 跨ぎ選択・跨ぎ置換が使う面ごとの情報。持たない面 (素材ダイアログ等) は null。 */
  textRun: TextRunEditorHandle | null;
}

/** 登録後も変わりうる情報。`registerCaretSurface` には渡さない。 */
export type CaretSurfaceFacets = Omit<CaretSurfaceHandle, "editor">;

const surfaces = new Map<Editor, CaretSurfaceHandle>();
const unregisterListeners = new Set<(handle: CaretSurfaceHandle) => void>();
const caretKeeperTargetListeners = new Set<(blockId: string) => void>();

let focusTraceInstalled = false;
let lastFocusedSurfaceEditor: Editor | null = null;

const CARET_KEEPER_MAX_REDELIVERIES = 3;

interface CaretKeeperState {
  checkFrameId: number | null;
  closeFrameIds: number[];
  generation: number;
  reanchorFrameId: number | null;
  redeliveries: number;
  redelivering: boolean;
  targetEditor: Editor | null;
}

let caretKeeper: CaretKeeperState | null = null;
let nextCaretKeeperGeneration = 1;

function surfaceForFocusTarget(target: EventTarget | null): CaretSurfaceHandle | null {
  if (!(target instanceof Node)) {
    return null;
  }
  return getCaretSurfaces().find((handle) => handle.editor.view.dom.contains(target)) ?? null;
}

function installFocusTrace(): void {
  if (focusTraceInstalled || typeof window === "undefined") {
    return;
  }
  focusTraceInstalled = true;
  window.addEventListener("focusout", (event) => {
    handleCaretKeeperFocusOut(event);
  });
  window.addEventListener("focusin", (event) => {
    const focusedSurface = surfaceForFocusTarget(event.target);
    // surface の DOM が消えたときは focusin 無しで BODY へ落ちる。その間だけ直前の
    // surface を覚えておき、明示的に別の要素へ focus したときは stale な候補を消す。
    lastFocusedSurfaceEditor = focusedSurface?.editor ?? null;
    if (caretKeeper && !focusedSurface && isIntentionalFocusTarget(event.target)) {
      closeCaretKeeperWindow();
    }
  });
  window.addEventListener("focus", () => {
    if (caretKeeper) {
      scheduleCaretKeeperCheck(caretKeeper);
    }
  });
  // 入力のたびに、ブラウザ自身のキャレット追従スクロールを見張る (打鍵の keydown で前の見張りは
  // 外れるので、ここで張り直す)。
  window.addEventListener("beforeinput", (event) => {
    const surface = surfaceForFocusTarget(event.target);
    if (surface) {
      guardCaretVisibility(surface);
    }
  }, true);
  window.addEventListener("pointerdown", cancelCaretKeeperForUserNavigation, true);
  window.addEventListener("touchstart", cancelCaretKeeperForUserNavigation, true);
  window.addEventListener("wheel", cancelCaretKeeperForUserNavigation, { capture: true, passive: true });
  window.addEventListener("keydown", (event) => {
    if (CARET_KEEPER_NAVIGATION_KEYS.has(event.key)) {
      cancelCaretKeeperForUserNavigation();
    }
  }, true);
}

const CARET_KEEPER_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

/** 利用者の操作ではないスクロールでこの面のキャレットが見えなくなったら、短い間だけ戻す。 */
function guardCaretVisibility(handle: CaretSurfaceHandle): void {
  if (handle.editor.isDestroyed) {
    return;
  }
  guardCaretAgainstForeignScroll(handle.editor.view.dom as HTMLElement, () => {
    if (!handle.editor.isDestroyed && handle.editor.isFocused) {
      handle.ensureCaretVisible();
    }
  });
}

function cancelCaretKeeperForUserNavigation(): void {
  if (caretKeeper) {
    closeCaretKeeperWindow();
  }
}

/**
 * 大量 paste 後の段階的 hydrate 中だけ、配送済みキャレットの DOM focus を守る。
 * 通常編集では state 自体が存在しないため、恒久的な focus trace listener は挙動へ介入しない。
 */
export function startCaretKeeperWindow(): void {
  closeCaretKeeperWindow();
  caretKeeper = {
    checkFrameId: null,
    closeFrameIds: [],
    generation: nextCaretKeeperGeneration,
    reanchorFrameId: null,
    redeliveries: 0,
    redelivering: false,
    targetEditor: null,
  };
  nextCaretKeeperGeneration += 1;
}

/** hydrate 完了後も React/EditorContent の付け替えを 2 frame 見届けてから監視を閉じる。 */
export function finishCaretKeeperWindow(): void {
  const keeper = caretKeeper;
  if (!keeper || typeof window === "undefined") {
    return;
  }
  cancelKeeperCloseFrames(keeper);
  const firstFrame = window.requestAnimationFrame(() => {
    if (caretKeeper !== keeper) {
      return;
    }
    const secondFrame = window.requestAnimationFrame(() => {
      if (caretKeeper === keeper) {
        closeCaretKeeperWindow();
      }
    });
    keeper.closeFrameIds.push(secondFrame);
  });
  keeper.closeFrameIds.push(firstFrame);
}

/** PageCanvasEditor の unmount 用。終了 frame を待たず、監視と予約済み check を必ず外す。 */
export function cancelCaretKeeperWindow(): void {
  closeCaretKeeperWindow();
}

/**
 * hydrate / pagination の DOM commit 後に、配送済みのキャレットを再び可視域へ入れる。
 * 同じ frame の複数の実測は 1 回に畳み、手動ナビゲーションで keeper が閉じた後は何もしない。
 */
export function requestCaretKeeperReanchor(): void {
  const keeper = caretKeeper;
  if (!keeper?.targetEditor || keeper.reanchorFrameId !== null || typeof window === "undefined") {
    return;
  }
  keeper.reanchorFrameId = window.requestAnimationFrame(() => {
    keeper.reanchorFrameId = null;
    if (caretKeeper !== keeper || !document.hasFocus()) {
      return;
    }
    const handle = keeper.targetEditor ? surfaces.get(keeper.targetEditor) : null;
    if (!handle || handle.editor.isDestroyed) {
      return;
    }
    handle.ensureCaretVisible();
  });
}

/**
 * keeper が守る論理キャレットの block を通知する。未 mount の配送先も通知するので、
 * PageCanvasEditor はその unit を背景 hydrate の順番待ちから外せる。
 */
export function subscribeCaretKeeperTarget(listener: (blockId: string) => void): () => void {
  caretKeeperTargetListeners.add(listener);
  return () => {
    caretKeeperTargetListeners.delete(listener);
  };
}

function publishCaretKeeperTarget(blockId: string): void {
  if (!caretKeeper) {
    return;
  }
  caretKeeperTargetListeners.forEach((listener) => listener(blockId));
}

function handleCaretKeeperFocusOut(event: FocusEvent): void {
  const keeper = caretKeeper;
  if (!keeper?.targetEditor || event.target !== keeper.targetEditor.view.dom) {
    return;
  }
  const nextSurface = surfaceForFocusTarget(event.relatedTarget);
  if (nextSurface) {
    return;
  }
  if (isIntentionalFocusTarget(event.relatedTarget)) {
    closeCaretKeeperWindow();
    return;
  }
  scheduleCaretKeeperCheck(keeper);
}

function scheduleCaretKeeperCheck(keeper: CaretKeeperState): void {
  if (caretKeeper !== keeper || keeper.checkFrameId !== null || typeof window === "undefined") {
    return;
  }
  keeper.checkFrameId = window.requestAnimationFrame(() => {
    keeper.checkFrameId = null;
    if (caretKeeper !== keeper) {
      return;
    }
    // OS / browser window 自体が非アクティブなら DOM focus の喪失ではない。復帰時の
    // window focus で改めて検査し、再配送上限も消費しない。
    if (!document.hasFocus()) {
      return;
    }
    const activeElement = document.activeElement;
    if (!isDocumentFocusEmpty(activeElement)) {
      if (!keeper.targetEditor?.view.dom.contains(activeElement)) {
        closeCaretKeeperWindow();
      }
      return;
    }
    if (keeper.redeliveries >= CARET_KEEPER_MAX_REDELIVERIES) {
      closeCaretKeeperWindow();
      return;
    }
    const handle = keeper.targetEditor ? surfaces.get(keeper.targetEditor) : null;
    if (!handle || handle.editor.isDestroyed) {
      closeCaretKeeperWindow();
      return;
    }
    let anchorAddress: CaretAddress | null = null;
    let headAddress: CaretAddress | null = null;
    try {
      const { anchor, head } = handle.editor.state.selection;
      anchorAddress = handle.addressAt(anchor);
      headAddress = handle.addressAt(head);
    } catch {
      // 次の frame では EditorContent の付け替えが終わっている可能性がある。
    }
    keeper.redeliveries += 1;
    if (!anchorAddress || !headAddress) {
      scheduleCaretKeeperCheck(keeper);
      return;
    }
    keeper.redelivering = true;
    requestCaretFromKeeper(
      { anchor: anchorAddress, head: headAddress, preferredX: null },
      keeper.generation,
    );
    const redelivered = flushPendingCaret();
    if (!redelivered) {
      keeper.redelivering = false;
      scheduleCaretKeeperCheck(keeper);
    }
  });
}

function isDocumentFocusEmpty(element: Element | null): boolean {
  return element === null || element === document.body || element === document.documentElement;
}

function isIntentionalFocusTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !isDocumentFocusEmpty(target);
}

function armCaretKeeper(handle: CaretSurfaceHandle): void {
  const keeper = caretKeeper;
  if (!keeper) {
    return;
  }
  keeper.targetEditor = handle.editor;
}

function cancelKeeperCloseFrames(keeper: CaretKeeperState): void {
  if (typeof window !== "undefined") {
    keeper.closeFrameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
  }
  keeper.closeFrameIds = [];
}

function closeCaretKeeperWindow(): void {
  const keeper = caretKeeper;
  if (!keeper) {
    return;
  }
  if (typeof window !== "undefined" && keeper.checkFrameId !== null) {
    window.cancelAnimationFrame(keeper.checkFrameId);
  }
  if (typeof window !== "undefined" && keeper.reanchorFrameId !== null) {
    window.cancelAnimationFrame(keeper.reanchorFrameId);
  }
  cancelKeeperCloseFrames(keeper);
  // keeper の寿命を越えて遅延 mount が起きても focus を奪い返さない。同じ slot にある
  // undo 等の通常予約 (generation が null) や、後続 keeper の予約は消さない。
  if (pendingCaret?.caretKeeperGeneration === keeper.generation) {
    pendingCaret = null;
  }
  caretKeeper = null;
}

export function registerCaretSurface(handle: CaretSurfaceHandle): () => void {
  installFocusTrace();
  surfaces.set(handle.editor, handle);
  if (handle.editor.isFocused) {
    lastFocusedSurfaceEditor = handle.editor;
  }
  // 待っていた宛先が現れたかもしれない。タイマーではなくここで消化する。
  if (pendingCaret) {
    flushPendingCaret();
  }
  return () => {
    const current = surfaces.get(handle.editor);
    if (!current) {
      return;
    }
    rememberFocusedCaretBeforeUnregister(current);
    if (lastFocusedSurfaceEditor === current.editor) {
      lastFocusedSurfaceEditor = null;
    }
    surfaces.delete(handle.editor);
    // 実際に面が消えたときだけ通知する。ファセットの書き換えでは通知しないので、
    // 打鍵のたびに跨ぎ選択が消えることはない。
    unregisterListeners.forEach((listener) => listener(current));
  };
}

/**
 * 登録済みの面の可変情報を書き換える。**面の登録・解除は起きない**ので、跨ぎ選択も
 * IME 合成も切れない。
 */
export function updateCaretSurfaceFacets(
  editor: Editor,
  patch: Partial<CaretSurfaceFacets>,
): void {
  const current = surfaces.get(editor);
  if (!current) {
    return;
  }
  surfaces.set(editor, { ...current, ...patch });
}

/**
 * 面が本当に消えたときの後始末を購読する。跨ぎ選択の状態はそれぞれの持ち主が持っている
 * ので、registry 側から状態を触らずに知らせるだけにする。
 */
export function subscribeCaretSurfaceUnregister(
  listener: (handle: CaretSurfaceHandle) => void,
): () => void {
  unregisterListeners.add(listener);
  return () => {
    unregisterListeners.delete(listener);
  };
}

export function getCaretSurface(editor: Editor): CaretSurfaceHandle | null {
  return surfaces.get(editor) ?? null;
}

export function getCaretSurfaces(): CaretSurfaceHandle[] {
  return [...surfaces.values()].filter((handle) => !handle.editor.isDestroyed);
}

export function getCaretSurfaceByViewDom(viewDom: Element): CaretSurfaceHandle | null {
  return getCaretSurfaces().find((handle) => handle.editor.view.dom === viewDom) ?? null;
}

/** 跨ぎ選択・跨ぎ置換のための面。登録順ではなく文書順 (`textRun.order`) で返す。 */
export function getTextRunSurfaces(groupId: string): TextRunEditorHandle[] {
  return getCaretSurfaces()
    .map((handle) => handle.textRun)
    .filter((textRun): textRun is TextRunEditorHandle => textRun?.groupId === groupId)
    .sort((left, right) => left.order - right.order);
}

export function getTextRunSurface(editor: Editor): TextRunEditorHandle | null {
  return getCaretSurface(editor)?.textRun ?? null;
}

export function getTextRunSurfaceByViewDom(viewDom: Element): TextRunEditorHandle | null {
  return getCaretSurfaceByViewDom(viewDom)?.textRun ?? null;
}

/**
 * フォーカス中のユニット id。再チャンクの小チャンク併合はチャンクの先頭ブロック id =
 * React の key を動かすため、フォーカス中 — 特に IME 合成中 — のエディタに掛かると
 * unmount で IME セッションごと落ちる。`chunkTextRun` はこの id が関わる併合を見送る。
 */
export function getFocusedCaretSurfaceUnitIds(): ReadonlySet<string> {
  const focused = new Set<string>();
  for (const handle of getCaretSurfaces()) {
    if (handle.textRun && handle.editor.isFocused) {
      focused.add(handle.textRun.unitId);
    }
  }
  return focused;
}

/** その断片ブロックを見せている面すべて (正本 + 複製)。 */
export function getCaretSurfacesForBox(boxId: string): CaretSurfaceHandle[] {
  return getCaretSurfaces().filter((handle) => handle.boxIds.includes(boxId));
}


// --- 配送 -------------------------------------------------------------------

let fragmentSources: Readonly<Record<string, CaretFragmentSourceLayout>> = {};
let fragmentReplicas: Readonly<Record<string, readonly CaretFragmentPlacement[]>> = {};

interface PendingCaret {
  /** keeper が再配送のために作った予約だけを外部 focus 時に識別して破棄する。 */
  caretKeeperGeneration: number | null;
  selection: TextFlowSelectionBookmark;
  /** マウント要求を出した宛先。同じ宛先へ何度も要求を投げないための鍵。 */
  requestedKey: string | null;
  /** 待っている宛先が属する「分割されたブロック」の id。表から消えたら予約を捨てる。 */
  requestedContainerId: string | null;
}

let pendingCaret: PendingCaret | null = null;
const mountListeners = new Set<(surface: CaretSurfaceId) => void>();

/**
 * ページ割りが決めた断片の並び。配送はこの表だけを見て宛先を決める。
 */
export function setFragmentTables(
  sources: Readonly<Record<string, CaretFragmentSourceLayout>>,
  replicas: Readonly<Record<string, readonly CaretFragmentPlacement[]>>,
): void {
  fragmentSources = sources;
  fragmentReplicas = replicas;
  // 待っていた断片が表から消えたら予約を捨てる (タイマーでは消さない)。鍵はキャレットの
  // 葉ブロックではなく**分割されたブロック**の id — 表はそちらで引くため。
  const waitingFor = pendingCaret?.requestedContainerId;
  if (waitingFor && !(waitingFor in fragmentSources)) {
    pendingCaret = null;
  }
  if (pendingCaret) {
    // 表が最新になった今なら宛先が決まる。
    flushPendingCaret();
    return;
  }
  rerouteFocusedCaret();
}

/**
 * ページ割りが変わって、今キャレットが載っている面がその位置を見せなくなったとき、見せている
 * 面へ移す。
 *
 * 「箱があふれた最初の打鍵」がこれ: 打った瞬間はまだ正本が見せていた行が、再ページ割りの後は
 * 次のページの断片に移る。**今の**選択を読み直して配り直すので、その間に打ち足した文字より
 * 前へ戻ることはない。
 */
function rerouteFocusedCaret(): void {
  const focused = getCaretSurfaces().find((handle) => handle.editor.isFocused);
  if (!focused || !focused.editor.state.selection.empty) {
    return;
  }
  const address = focused.addressAt(focused.editor.state.selection.head);
  if (!address || !focused.fragmentBlockIdFor(address.blockId)) {
    return;
  }
  const selection: TextFlowSelectionBookmark = {
    anchor: address,
    head: address,
    preferredX: null,
  };
  const owners = getCaretSurfaces().filter((handle) => handle.ownsBlock(address.blockId));
  const target = resolveTargetSurface(owners, selection);
  if (target.key === surfaceKey(focused.surface)) {
    // 面は変わらなくても、ページ割りが変わって紙面上の位置は動いている。見えているかを
    // 確かめ直す (ここを飛ばすと「改行した瞬間に紙面が別の場所を映したまま」になる)。
    focused.ensureCaretVisible();
    return;
  }
  if (!target.key) {
    // どの面もこの位置を持っていない。触らない。
    return;
  }
  if (!target.handle) {
    rememberPending(selection, target);
    if (target.surface) {
      const requested = target.surface;
      mountListeners.forEach((listener) => listener(requested));
    }
    return;
  }
  applyToSurface(target.handle, selection, target);
}

/** 描き直しの後に配る予約。まだ配らない。 */
export function requestCaret(selection: TextFlowSelectionBookmark): void {
  pendingCaret = {
    caretKeeperGeneration: null,
    requestedContainerId: null,
    requestedKey: null,
    selection,
  };
}

function requestCaretFromKeeper(
  selection: TextFlowSelectionBookmark,
  caretKeeperGeneration: number,
): void {
  pendingCaret = {
    caretKeeperGeneration,
    requestedContainerId: null,
    requestedKey: null,
    selection,
  };
}

/** 予約を消化する。描き直しが終わった後に 1 回だけ呼ぶ。 */
export function flushPendingCaret(): boolean {
  const pending = pendingCaret;
  if (!pending) {
    return false;
  }
  pendingCaret = null;
  return deliverCaretWithGeneration(pending.selection, pending.caretKeeperGeneration);
}

/**
 * キャレットを**ただ 1 つの面**へ配る。
 *
 * ページを跨ぐブロックは N+1 個の面に描かれ、どれも同じ論理位置を復元できてしまう。以前は
 * `window` へブロードキャストして全ての面が復元し、購読順で最後の面がフォーカスを攫っていた。
 * ここで宛先を 1 つに決め、他の面には dispatch しない。
 */
export function deliverCaret(selection: TextFlowSelectionBookmark): boolean {
  return deliverCaretWithGeneration(selection, null);
}

function deliverCaretWithGeneration(
  selection: TextFlowSelectionBookmark,
  caretKeeperGeneration: number | null,
): boolean {
  const blockId = selection.head.blockId;
  const owners = getCaretSurfaces().filter((handle) => handle.ownsBlock(blockId));
  if (owners.length === 0) {
    publishCaretKeeperTarget(blockId);
    rememberPending(
      selection,
      { containerBlockId: null, handle: null, key: null, surface: null },
      caretKeeperGeneration,
    );
    return false;
  }

  const target = resolveTargetSurface(owners, selection);
  if (!target.handle) {
    rememberPending(selection, target, caretKeeperGeneration);
    if (target.surface) {
      const requested = target.surface;
      mountListeners.forEach((listener) => listener(requested));
    }
    return false;
  }

  return applyToSurface(target.handle, selection, target, caretKeeperGeneration);
}

/**
 * 論理位置ひとつをキャレットとして配る (畳まれた選択)。ブロックの端へ焦点を戻す経路が使う。
 */
export function focusCaretAddress(address: CaretAddress): boolean {
  return deliverCaret({ anchor: address, head: address, preferredX: null });
}

/**
 * 断片の複製がマウントされるまで待つ購読。カリングされている複製へ配る必要が出たとき、
 * 「その複製を出してほしい」とだけ伝える。タイマーは置かない。
 */
export function subscribeCaretSurfaceMount(
  listener: (surface: CaretSurfaceId) => void,
): () => void {
  mountListeners.add(listener);
  return () => {
    mountListeners.delete(listener);
  };
}

function rememberPending(
  selection: TextFlowSelectionBookmark,
  target: CaretTarget,
  caretKeeperGeneration: number | null = null,
): void {
  pendingCaret = {
    caretKeeperGeneration,
    requestedContainerId: target.containerBlockId,
    requestedKey: target.key,
    selection,
  };
}

/**
 * 再チャンクで focused な面が消えると DOM focus は BODY へ落ちる。その面がまだ持っている
 * **現在の**選択を bookmark に戻しておき、後継面の登録時に通常の配送経路で復元する。
 * paste 時に予約した古い位置を使わないので、配送後に打鍵済みでも巻き戻らない。
 */
function rememberFocusedCaretBeforeUnregister(handle: CaretSurfaceHandle): {
  rearmed: boolean;
  reason: string;
} {
  // undo や跨ぎ置換が予約した変更後の正しい位置を、消える旧 surface の選択で潰さない。
  if (pendingCaret) {
    return { rearmed: false, reason: "pending-caret-already-exists" };
  }
  const wasLastFocusedSurface = lastFocusedSurfaceEditor === handle.editor;
  if (!handle.editor.isFocused && !wasLastFocusedSurface) {
    return {
      rearmed: false,
      reason: "editor-not-focused",
    };
  }
  let anchorAddress: CaretAddress | null = null;
  let headAddress: CaretAddress | null = null;
  try {
    const { anchor, head } = handle.editor.state.selection;
    anchorAddress = handle.addressAt(anchor);
    headAddress = handle.addressAt(head);
  } catch {
    return { rearmed: false, reason: "selection-read-failed" };
  }
  if (!anchorAddress || !headAddress) {
    return { rearmed: false, reason: "selection-address-unresolved" };
  }
  rememberPending(
    { anchor: anchorAddress, head: headAddress, preferredX: null },
    { containerBlockId: null, handle: null, key: null, surface: null },
  );
  return {
    rearmed: true,
    reason: handle.editor.isFocused
      ? "focused-selection-captured"
      : "last-focused-selection-captured",
  };
}

function surfaceKey(surface: CaretSurfaceId): string {
  if (surface.kind === "fragmentReplica") {
    return `replica:${surface.blockId}:${surface.fragmentIndex}`;
  }
  if (surface.kind === "richText") {
    return `richText:${surface.blockId ?? ""}`;
  }
  return `unit:${surface.unitId ?? ""}`;
}

interface CaretTarget {
  handle: CaretSurfaceHandle | null;
  key: string | null;
  /** マウントを頼める宛先 (断片の複製) のときだけ入る。正本は頼んでも出せない。 */
  surface: CaretSurfaceId | null;
  containerBlockId: string | null;
}

/**
 * 宛先の面を決める。断片に分かれたブロックなら、**代表の面 1 つだけ**で縦位置を測り
 * (`doc.descendants` の走査はここ 1 回)、断片の表から番号を出す。
 */
function resolveTargetSurface(
  owners: readonly CaretSurfaceHandle[],
  selection: TextFlowSelectionBookmark,
): CaretTarget {
  const blockId = selection.head.blockId;
  // 「このキャレットを含む分割されたブロック」を面ごとに聞く。1 ユニットに分割ブロックが
  // 複数あるとき、面ごとに 1 つへ潰すと別のブロックの表で断片番号を読んでしまう。
  let containerBlockId: string | null = null;
  let representative: CaretSurfaceHandle | null = null;
  for (const handle of owners) {
    const candidate = handle.fragmentBlockIdFor(blockId);
    if (!candidate || !(candidate in fragmentSources)) {
      continue;
    }
    containerBlockId = candidate;
    // 代表は正本 (断片番号 0 を持つ面) を優先する。複製は translate されているだけで
    // 同じ値を測れるが、正本のほうが常にマウントされている。
    if (!representative || handle.surface.kind !== "fragmentReplica") {
      representative = handle;
    }
    if (handle.surface.kind !== "fragmentReplica") {
      break;
    }
  }

  if (containerBlockId && representative) {
    const table = buildCaretFragmentTable(
      fragmentSources[containerBlockId],
      fragmentReplicas[containerBlockId] ?? [],
    );
    const localY = representative.localYFor(selection.head, containerBlockId);
    if (localY !== null) {
      const placement = resolveCaretSurface(localY, table);
      if (placement.kind === "fragment") {
        return resolveFragmentTarget(owners, containerBlockId, placement.fragmentIndex);
      }
    }
  }

  const handle = preferredOwner(owners);
  return {
    containerBlockId,
    handle,
    key: handle ? surfaceKey(handle.surface) : null,
    surface: null,
  };
}

/**
 * 断片番号から宛先の面を引く。番号 0 は**複製ではない面** (正本) であって、たまたま代表に
 * 選ばれた面ではない。
 */
function resolveFragmentTarget(
  owners: readonly CaretSurfaceHandle[],
  containerBlockId: string,
  fragmentIndex: number,
): CaretTarget {
  if (fragmentIndex === 0) {
    const source = owners.find((handle) => handle.surface.kind !== "fragmentReplica") ?? null;
    return {
      containerBlockId,
      handle: source,
      key: source ? surfaceKey(source.surface) : `source:${containerBlockId}`,
      // 正本はカリングされない。出してほしいと頼む相手が居ないので surface は返さない。
      surface: null,
    };
  }
  const wanted: CaretSurfaceId = {
    kind: "fragmentReplica",
    blockId: containerBlockId,
    fragmentIndex,
  };
  const key = surfaceKey(wanted);
  return {
    containerBlockId,
    handle: owners.find((handle) => surfaceKey(handle.surface) === key) ?? null,
    key,
    surface: wanted,
  };
}

/**
 * 断片に分かれていないブロックの宛先。同じ id を持つ面が複数あるのは、本文とヘッダ/フッタや
 * 素材ダイアログが同じブロックを見せている場合。焦点のある面を優先し、無ければ文書順を
 * 持つ面 (= 本文) を選ぶ。
 */
function preferredOwner(owners: readonly CaretSurfaceHandle[]): CaretSurfaceHandle | null {
  return owners.find((handle) => handle.editor.isFocused)
    ?? owners.find((handle) => handle.order.length > 0)
    ?? owners[0]
    ?? null;
}

/**
 * IME 合成中の適用は合成セッションを切り、確定前の文字を失わせる。合成が終わってから
 * やり直す (`TextFlowEditor` の受動同期と同じガード)。
 */
const composingRetries = new WeakSet<Editor>();

function applyToSurface(
  handle: CaretSurfaceHandle,
  selection: TextFlowSelectionBookmark,
  target: CaretTarget,
  caretKeeperGeneration: number | null = null,
): boolean {
  if (handle.editor.isDestroyed) {
    return false;
  }
  if (handle.editor.view.composing) {
    // 予約として持ち直す。合成が終わってから **その時点の表で** 配り直すので、合成中に
    // 確定した文字より前へキャレットが戻らない。待ち受けは面ごとに 1 つだけにする。
    rememberPending(selection, target, caretKeeperGeneration);
    if (!composingRetries.has(handle.editor)) {
      composingRetries.add(handle.editor);
      handle.editor.view.dom.addEventListener("compositionend", () => {
        composingRetries.delete(handle.editor);
        flushPendingCaret();
      }, { once: true });
    }
    return false;
  }
  const previousFocus = typeof document === "undefined" ? null : document.activeElement;
  const applied = handle.applyCaret(selection);
  if (applied) {
    // 別の面から移ってきたときだけ、ブラウザ自身のキャレット追従スクロールを見張る。
    const previousSurface = surfaceForFocusTarget(previousFocus);
    if (previousSurface && previousSurface !== handle) {
      guardCaretVisibility(handle);
    }
    const keeper = caretKeeper;
    armCaretKeeper(handle);
    publishCaretKeeperTarget(selection.head.blockId);
    if (keeper?.redelivering) {
      keeper.redelivering = false;
      handle.ensureCaretVisible();
      // EditorContent の DOM がまだ detached なら applyCaret 自体は成功しても focus は BODY の
      // ままになりうる。次 frame に実フォーカスを検査し、上限内でもう一度だけ配送経路へ戻す。
      scheduleCaretKeeperCheck(keeper);
    }
    return true;
  }
  // この面の doc では解決できなかった (再描画の途中など)。捨てずに持ち直す。
  rememberPending(selection, target, caretKeeperGeneration);
  return false;
}


// --- 上下移動 ---------------------------------------------------------------

/**
 * キャレットがテキストブロックの端の行 (up = 先頭行 / down = 最終行) にいるか。
 *
 * `endOfTextblock` は内部で DOM の幾何を見るため、CSS multicol (段組みセクション) の中では
 * 端の行にいても false を返すことがある。false のときだけ、ブロックの端の位置と同じ行に
 * いるかを自前の幾何で確かめて補う。
 */
export function caretAtTextblockEdgeLine(
  view: Editor["view"],
  direction: "up" | "down",
): boolean {
  if (view.endOfTextblock(direction)) {
    return true;
  }
  try {
    const { $head } = view.state.selection;
    if (!$head.parent.isTextblock) {
      return false;
    }
    const caret = view.coordsAtPos($head.pos);
    const edge = view.coordsAtPos(
      direction === "down" ? $head.end() : $head.start(),
      direction === "down" ? -1 : 1,
    );
    const lineHeight = Math.max(caret.bottom - caret.top, 1);
    return Math.abs(edge.top - caret.top) < lineHeight / 2;
  } catch {
    return false;
  }
}

/**
 * 1 行ぶんの上下移動を**先回りして**解決する。面をまたぐときだけ介入し、`true` を返したら
 * 呼び出し側が `preventDefault` する。
 *
 * 断片の複製はブロック全体の doc を持つので、断片 3 の 1 行目で ↑ を押してもネイティブ移動は
 * **同じ doc の中で成功してしまう**。移動先の行は `translateY` で viewport の上へ押し出されて
 * 見えないだけで、「位置が変わらなかったら隣の面へ」という後追い判定は永久に false になる。
 * だから `endOfTextblock` を見る前に、断片の表で行き先を決める。
 */
export function moveCaretVertically(
  viewDom: Element,
  direction: "up" | "down",
  preferredX: number,
): boolean {
  const from = getCaretSurfaceByViewDom(viewDom);
  if (!from || from.editor.isDestroyed || !from.editor.state.selection.empty) {
    return false;
  }

  const address = from.addressAt(from.editor.state.selection.head);
  const containerBlockId = address ? from.fragmentBlockIdFor(address.blockId) : null;
  if (address && containerBlockId && containerBlockId in fragmentSources) {
    const decided = moveWithinFragmentedBlock(from, containerBlockId, direction, preferredX);
    if (decided !== null) {
      return decided;
    }
  }

  // 分割されていない面。ブロックの縦の端でなければネイティブに任せる。
  if (!caretAtTextblockEdgeLine(from.editor.view, direction)) {
    return false;
  }
  // 同じ doc にまだ次のテキストブロックがあるならネイティブで足りる。ただしその行き先が
  // **分割されたブロックの中**なら、ネイティブは clip された見えない場所へ入ってしまう。
  const adjacent = from.adjacentTextblockAddress(direction);
  if (adjacent) {
    const adjacentContainer = from.fragmentBlockIdFor(adjacent.blockId);
    if (adjacentContainer && adjacentContainer in fragmentSources) {
      const routed = routeToAdjacentFragment(from, adjacent, adjacentContainer, preferredX);
      if (routed !== null) {
        return routed;
      }
    }
    return false;
  }
  return moveToNeighbourSurface(from, direction, preferredX);
}

/** 分割されたブロックの中へ入る移動。見せている面まで決めてから配る。 */
function routeToAdjacentFragment(
  from: CaretSurfaceHandle,
  adjacent: CaretAddress,
  containerBlockId: string,
  preferredX: number,
): boolean | null {
  const localY = from.localYFor(adjacent, containerBlockId);
  if (localY === null) {
    return null;
  }
  const table = buildCaretFragmentTable(
    fragmentSources[containerBlockId],
    fragmentReplicas[containerBlockId] ?? [],
  );
  const placement = resolveCaretSurface(localY, table);
  if (placement.kind !== "fragment") {
    return null;
  }
  const owners = getCaretSurfaces().filter((handle) => handle.ownsBlock(adjacent.blockId));
  const target = resolveFragmentTarget(owners, containerBlockId, placement.fragmentIndex);
  if (!target.handle || target.handle === from) {
    return null;
  }
  return target.handle.focusCaretAtLocalY({
    containerBlockId,
    localY: placement.localY,
    preferredX,
  });
}

/**
 * 分割されたブロックの中での移動。介入しないと決めたら `false`、決められなければ `null`。
 */
function moveWithinFragmentedBlock(
  from: CaretSurfaceHandle,
  containerBlockId: string,
  direction: "up" | "down",
  preferredX: number,
): boolean | null {
  const address = from.addressAt(from.editor.state.selection.head);
  const localY = address ? from.localYFor(address, containerBlockId) : null;
  const table = buildCaretFragmentTable(
    fragmentSources[containerBlockId],
    fragmentReplicas[containerBlockId] ?? [],
  );
  const edgeFragment = direction === "down" ? table.fragments.at(-1) : table.fragments[0];
  const lineHeight = from.caretLineAdvance(containerBlockId, direction);
  // At a replica's text edge, there is no next line to measure. ProseMirror
  // may select the enclosing box instead, so resolve this exit semantically
  // before asking for next-line geometry (which can legitimately be null).
  const exitsReplica = from.surface.kind === "fragmentReplica"
    && from.surface.fragmentIndex === edgeFragment?.fragmentIndex
    && caretAtTextblockEdgeLine(from.editor.view, direction)
    && from.adjacentTextblockAddress(direction) === null;
  if (!exitsReplica && (localY === null || lineHeight === null || lineHeight <= 0)) {
    return null;
  }

  const move = exitsReplica
    ? { kind: direction === "down" ? "afterBlock" as const : "beforeBlock" as const }
    : resolveVerticalMove({ direction, lineHeight: lineHeight!, localY: localY!, table });
  if (move.kind === "same") {
    return false;
  } else if (move.kind === "fragment") {
    const owners = getCaretSurfaces().filter((handle) => handle.ownsBlock(address!.blockId));
    const target = resolveFragmentTarget(owners, containerBlockId, move.fragmentIndex);
    if (!target.handle) {
      // 行き先の複製がまだ出ていない。出してほしいとだけ頼み、この打鍵はネイティブへ渡す
      // (論理位置は同じ doc の中なので失われない)。1 行ぶんの移動でカリング距離
      // (rootMargin 1200px) を越えることは実際には起きない。
      if (target.surface) {
        const requested = target.surface;
        mountListeners.forEach((listener) => listener(requested));
      }
      return null;
    }
    if (target.handle === from) {
      return false;
    }
    return target.handle.focusCaretAtLocalY({
      containerBlockId,
      localY: move.localY,
      preferredX,
    });
  }

  // ブロックの外へ出る。続きは**正本の doc**にある (箱の後ろの本文は正本が持っている)。
  const owners = getCaretSurfaces().filter((handle) => handle.ownsBlock(containerBlockId));
  const source = owners.find((handle) => handle.surface.kind !== "fragmentReplica") ?? null;
  if (!source || source === from) {
    // 既に正本にいる。この doc の中で完結するならネイティブ、doc の端なら隣の面へ —
    // どちらかは共通の経路が決めるので「未決」で返す (ここで false にすると、分割ブロック
    // が先頭/末尾にある面だけ隣のユニットへ抜けられなくなる)。
    return null;
  }
  if (source.focusCaretAfterBlock(containerBlockId, direction, preferredX)) {
    return true;
  }
  // 箱がユニットの端 (その向きに正本の doc の続きが無い)。隣のユニットへ。
  return moveToNeighbourSurface(from, direction, preferredX);
}

/**
 * 文書順で隣の面へ移る。**順番を持たない面 (素材ダイアログ・ヘッダ/フッタ) は候補にしない**
 * ので、モーダルが開いていても本文の上下移動が漏れない。
 *
 * 候補は**ユニットだけ**。複製の順番タプルは正本の直後に並ぶが、その内容は持ち主のユニットの
 * 一部 (箱) の写しであって「doc の端の先」ではない — 複製を候補にすると、箱より後ろの本文の
 * 末尾で ↓ を押しただけで同じ箱の頭へ逆戻りする。行き先の面 (正本か複製か) は、行き先ユニット
 * の端の**内容の住所**から引き直す: 端が分割されたブロックの中なら、それを見せている複製の端へ
 * preferredX を保って置く。
 */
function moveToNeighbourSurface(
  from: CaretSurfaceHandle,
  direction: "up" | "down",
  preferredX: number,
): boolean {
  if (from.order.length === 0) {
    return false;
  }
  const units = getCaretSurfaces().filter((handle) => (
    handle.order.length > 0 && handle.surface.kind === "unit"
  ));
  const next = nextSurfaceInVisualOrder(units, from.order, direction);
  if (!next) {
    return false;
  }
  const address = next.docEdgeAddress(direction === "down" ? "start" : "end");
  const face = address
    ? resolveTargetSurface(
      getCaretSurfaces().filter((handle) => handle.ownsBlock(address.blockId)),
      { anchor: address, head: address, preferredX: null },
    ).handle
    : null;
  // 行き先の複製がまだ出ていない (カリング) ときはユニットの正本へ。見える帯の端に置くので
  // clip された場所へは入らない。
  const target = face ?? next;
  return target.focusCaretAtEdge(direction === "down" ? "top" : "bottom", preferredX);
}


// --- 左右移動 ---------------------------------------------------------------

/**
 * 1 文字ぶんの左右移動のうち、**ネイティブでは正しく動けない境界**だけを先回りして解決する。
 * `true` を返したら呼び出し側が `preventDefault` する。
 *
 * - 行の途中・普通のブロック境界はネイティブに任せる (bidi・数式ノードビューの中まで自前で
 *   持たないのは上下移動と同じ方針)。
 * - 行き先が**別の面が見せている断片**の中: ネイティブは同じ doc の中で成功して clip された
 *   見えない場所へ入ってしまうので、見せている面へ配る。
 * - doc の端: ネイティブは動けず、キャレットが端で止まる。複製の端ならブロックの外 (正本の
 *   doc) へ、ユニットの端なら文書順で隣のユニットの端へ渡す。
 */
export function moveCaretHorizontally(
  viewDom: Element,
  direction: "forward" | "backward",
): boolean {
  const from = getCaretSurfaceByViewDom(viewDom);
  if (!from || from.editor.isDestroyed || !from.editor.state.selection.empty) {
    return false;
  }
  if (!from.editor.view.endOfTextblock(direction)) {
    return false;
  }
  const verticalDirection = direction === "forward" ? "down" : "up";
  const adjacent = from.adjacentTextblockAddress(verticalDirection);
  if (adjacent) {
    const container = from.fragmentBlockIdFor(adjacent.blockId);
    if (!container || !(container in fragmentSources)) {
      return false;
    }
    const selection: TextFlowSelectionBookmark = {
      anchor: adjacent,
      head: adjacent,
      preferredX: null,
    };
    const owners = getCaretSurfaces().filter((handle) => handle.ownsBlock(adjacent.blockId));
    const target = resolveTargetSurface(owners, selection);
    if (!target.handle || target.handle === from) {
      return false;
    }
    return applyToSurface(target.handle, selection, target);
  }

  // doc の端。複製なら行き先はまずブロックの外 = 正本の doc にある。
  if (from.surface.kind === "fragmentReplica") {
    const containerBlockId = from.surface.blockId;
    const source = containerBlockId
      ? getCaretSurfaces()
        .filter((handle) => handle.ownsBlock(containerBlockId))
        .find((handle) => handle.surface.kind !== "fragmentReplica") ?? null
      : null;
    if (source?.focusCaretAfterBlock(containerBlockId!, verticalDirection, null)) {
      return true;
    }
    // 箱がユニットの端 (その向きに正本の doc の続きが無い)。下の共通経路で隣のユニットへ。
  }

  // ユニットの端。隣の候補は**ユニットだけ**にする: 複製の doc はこのユニットの内容の一部
  // (同じ箱) の写しであって、この先・この前の内容を持たない。
  if (from.order.length === 0) {
    return false;
  }
  const units = getCaretSurfaces().filter((handle) => (
    handle.order.length > 0 && handle.surface.kind === "unit"
  ));
  const next = nextSurfaceInVisualOrder(units, from.order, verticalDirection);
  if (!next) {
    return false;
  }
  const address = next.docEdgeAddress(direction === "forward" ? "start" : "end");
  if (!address) {
    return false;
  }
  // 行き先の位置が分割されたブロックの中なら、`deliverCaret` が見せている面まで選び直す。
  return deliverCaret({ anchor: address, head: address, preferredX: null });
}
