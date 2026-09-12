import type { Page } from "@playwright/test";

/**
 * ページを跨ぐブロックは「正本 (source)」と「断片の複製 (replica)」の N+1 個の編集面に
 * 描かれ、どの面も同じ `data-sigma-doc-id` と同じ本文を持つ。したがって `blockId` と
 * `textContent` だけを見るヘルパは、キャレットが**見えていない面**にあっても緑になる。
 *
 * ここでは「どの面が選択を持ち」「どの面が DOM フォーカスを持ち」「キャレット矩形がその面の
 * 可視帯に入っているか」まで読む。`.spec.ts` ではないので Playwright はこのファイルを
 * テストとして拾わない (`desktop-runtime-mock.ts` 等と同じ規約)。
 */
export interface CaretSurfaceRef {
  kind: "source" | "replica" | "outside";
  blockId: string | null;
  fragmentIndex: number | null;
}

export interface CaretSurfaceState {
  /** DOM 選択のアンカーが乗っている面。 */
  selectionSurface: CaretSurfaceRef | null;
  /** `document.activeElement` が乗っている面。 */
  activeSurface: CaretSurfaceRef | null;
  blockId: string | null;
  text: string;
  offset: number;
  /** キャレット矩形の縦中点が `selectionSurface` の可視帯 `[top, bottom)` に入っているか。 */
  caretVisible: boolean;
  /** 断片跨ぎ選択の帯を描いている面の数。 */
  spanSurfaceCount: number;
  /** 断片 viewport の `scrollTop` の最大値 (常に 0 が正)。 */
  maxFragmentScrollTop: number;
  collapsed: boolean;
}

export async function readCaretSurface(page: Page): Promise<CaretSurfaceState> {
  return page.evaluate(() => {
    const FRAGMENT_VIEWPORT = ".editor-box-fragment-viewport";
    const FRAGMENT_SOURCE = "[data-box-fragment-source-id]";

    const elementOf = (node: Node | null): Element | null => {
      if (node instanceof Element) {
        return node;
      }
      return node?.parentElement ?? null;
    };

    const sourceBandOwner = (element: Element): HTMLElement | null => {
      const ancestor = element.closest<HTMLElement>(FRAGMENT_SOURCE);
      if (ancestor) {
        return ancestor;
      }
      // `document.activeElement` は ProseMirror のルートなので、断片ソースは祖先ではなく
      // 子孫側にいる。面の中に断片ソースがちょうど 1 つのときだけそれを面の代表とみなす
      // (複数あると「どの断片ソースか」はアンカーからしか決まらない)。
      const editorRoot = element.closest<HTMLElement>(".text-flow-editor") ?? null;
      const owned = editorRoot?.querySelectorAll<HTMLElement>(FRAGMENT_SOURCE);
      return owned && owned.length === 1 ? owned[0] : null;
    };

    const surfaceOf = (node: Node | null): CaretSurfaceRef | null => {
      const element = elementOf(node);
      if (!element) {
        return null;
      }
      const viewport = element.closest<HTMLElement>(FRAGMENT_VIEWPORT);
      if (viewport) {
        const rawIndex = viewport.dataset.boxFragmentIndex;
        const parsedIndex = rawIndex === undefined ? Number.NaN : Number(rawIndex);
        return {
          kind: "replica",
          blockId: viewport.dataset.boxSourceId ?? null,
          fragmentIndex: Number.isFinite(parsedIndex) ? parsedIndex : null,
        };
      }
      if (element.closest(".text-flow-editor")) {
        return {
          kind: "source",
          blockId: sourceBandOwner(element)?.dataset.boxFragmentSourceId ?? null,
          fragmentIndex: 0,
        };
      }
      return { kind: "outside", blockId: null, fragmentIndex: null };
    };

    const visibleBand = (node: Node | null): { bottom: number; top: number } | null => {
      const element = elementOf(node);
      if (!element) {
        return null;
      }
      const viewport = element.closest<HTMLElement>(FRAGMENT_VIEWPORT);
      if (viewport) {
        const rect = viewport.getBoundingClientRect();
        return { bottom: rect.bottom, top: rect.top };
      }
      // 帯は**祖先**の断片ソースだけで決める。「面の中に断片ソースが 1 つならそれ」の
      // フォールバック (面の同定用) をここで使うと、箱の外の普通の段落まで箱の可視帯で
      // 判定してしまい、見えているのに false になる。
      const source = element.closest<HTMLElement>(FRAGMENT_SOURCE);
      if (source) {
        const rect = source.getBoundingClientRect();
        const visibleHeight = Number.parseFloat(
          getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"),
        );
        // 可視高さはズーム前の紙面 px、矩形は client px。実寸との比で倍率を掛ける
        // (掛け忘れるとズーム 100% では通り、拡大したときだけ帯が短くなって落ちる)。
        const rawScale = source.offsetHeight > 0 ? rect.height / source.offsetHeight : 1;
        const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
        return {
          bottom: Number.isFinite(visibleHeight)
            ? Math.min(rect.bottom, rect.top + Math.max(0, visibleHeight) * scale)
            : rect.bottom,
          top: rect.top,
        };
      }
      // 段組みの本文は 1 つの編集面の中でブロックが絶対配置されるので、編集面自身の矩形は
      // ほとんど潰れている。ふつうのブロックは「自分のブロックの矩形の中」が可視帯。
      const block = element.closest<HTMLElement>("[data-sigma-doc-id]");
      if (block) {
        const rect = block.getBoundingClientRect();
        // 区切り線のように 1px しか高さの無いブロックは、自分の矩形を帯にすると半開区間の
        // 判定に入らない。そういうブロックは編集面の矩形へ落とす。
        if (rect.height >= 2) {
          return { bottom: rect.bottom, top: rect.top };
        }
      }
      const editorRoot = element.closest<HTMLElement>(".text-flow-editor");
      if (!editorRoot) {
        return null;
      }
      const rect = editorRoot.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    };

    const caretRect = (
      selection: Selection,
      block: HTMLElement | null,
    ): { bottom: number; top: number } | null => {
      if (selection.rangeCount === 0) {
        return null;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.top !== 0 || rect.bottom !== 0) {
        return { bottom: rect.bottom, top: rect.top };
      }
      // 折り返し境界などで潰れた矩形が返ることがあるので、ブロック矩形へ退避する。
      const fallback = block?.getBoundingClientRect();
      return fallback ? { bottom: fallback.bottom, top: fallback.top } : null;
    };

    const viewports = Array.from(
      document.querySelectorAll<HTMLElement>(FRAGMENT_VIEWPORT),
    );
    const maxFragmentScrollTop = viewports.reduce(
      (largest, viewport) => Math.max(largest, viewport.scrollTop),
      0,
    );
    const spanSurfaceCount = document.querySelectorAll(
      ".text-flow-editor[data-box-fragment-span]",
    ).length;
    const activeSurface = surfaceOf(document.activeElement);

    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode ?? null;
    const anchorBlock = elementOf(anchorNode)?.closest<HTMLElement>("[data-sigma-doc-id]") ?? null;
    // 区切り線などノードを丸ごと選んでいる状態は、DOM 選択のアンカーが編集面のルート側に
    // 付くのでブロックまで辿れない。選ばれているノードそのものを見る。
    //
    // 復元は正本と複製の**すべての面**に同じ選択を適用しうるので、文書全体から拾うと
    // 「DOM 順で最初の面」を答えてしまい、この試験群が守りたい所有権の性質を素通りする。
    // 今フォーカスを持っている面の中だけを見る。
    const activeSurfaceRoot = document.activeElement instanceof Element
      ? document.activeElement.closest<HTMLElement>(".text-flow-editor")
      : null;
    const selectedNode = (activeSurfaceRoot ?? document).querySelector<HTMLElement>(
      ".ProseMirror-selectednode[data-sigma-doc-id]",
    );
    const block = anchorBlock ?? selectedNode;
    if (!selection || !anchorNode || !block) {
      return {
        activeSurface,
        blockId: null,
        caretVisible: false,
        collapsed: selection?.isCollapsed ?? false,
        maxFragmentScrollTop,
        offset: -1,
        selectionSurface: null,
        spanSurfaceCount,
        text: "",
      };
    }

    // ノード選択には文字 offset が無い。アンカーがブロックの中にあるときだけ数える。
    let offset = 0;
    if (anchorBlock) {
      const offsetRange = document.createRange();
      offsetRange.selectNodeContents(anchorBlock);
      offsetRange.setEnd(anchorNode, selection.anchorOffset);
      offset = offsetRange.toString().length;
    }

    const band = visibleBand(anchorBlock ?? block);
    const rect = caretRect(selection, block);
    const middle = rect ? (rect.top + rect.bottom) / 2 : null;

    return {
      activeSurface,
      blockId: block.dataset.sigmaDocId ?? null,
      // 半開区間。断片の境界でちょうど 2 つの面が「見えている」と名乗るのを防ぐ。
      caretVisible: band !== null
        && middle !== null
        && middle >= band.top - 0.5
        && middle < band.bottom - 0.5,
      collapsed: selection.isCollapsed,
      maxFragmentScrollTop,
      offset,
      selectionSurface: surfaceOf(anchorBlock ?? block),
      spanSurfaceCount,
      text: block.textContent ?? "",
    };
  });
}

/**
 * `run` の間にキャレットの所有権が編集面から編集面へ何回移ったかを数える。
 *
 * 「断片が N 個あっても復元 1 回あたりのフォーカス移動は 1 回」を e2e から測るための唯一の
 * 手段。同じ面への連続 focus は 1 回に畳む (ProseMirror の再フォーカスと、別の面が
 * フォーカスを奪う退行を区別するため)。
 */
export async function countFocusIn(page: Page, run: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const probeWindow = window as unknown as {
      __caretFocusProbe?: { count: number; dispose: () => void };
    };
    probeWindow.__caretFocusProbe?.dispose();

    let lastSurface: Element | null = document.activeElement?.closest(".text-flow-editor") ?? null;
    const probe = { count: 0, dispose: () => {} };
    const listener = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const surface = target?.closest(".text-flow-editor") ?? null;
      if (!surface || surface === lastSurface) {
        return;
      }
      lastSurface = surface;
      probe.count += 1;
    };
    document.addEventListener("focusin", listener, true);
    probe.dispose = () => {
      document.removeEventListener("focusin", listener, true);
      delete probeWindow.__caretFocusProbe;
    };
    probeWindow.__caretFocusProbe = probe;
  });

  await run();

  return page.evaluate(() => {
    const probeWindow = window as unknown as {
      __caretFocusProbe?: { count: number; dispose: () => void };
    };
    const probe = probeWindow.__caretFocusProbe;
    if (!probe) {
      return -1;
    }
    const { count } = probe;
    probe.dispose();
    return count;
  });
}
