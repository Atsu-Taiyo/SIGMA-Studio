import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import type { PageBreakMarkerKind } from "@/features/text-editing/model";
import { createPageBreakMarkerContent } from "@/components/editor/page-break-marker";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";

export interface PageBreakGapOptions {
  /** Returns the current map of block sigmaDocId -> spacer height px that pushes a block to the next page. */
  getGaps: () => Record<string, number>;
  /** Returns block ids that explicitly start with a manual page break marker. */
  getBreakBeforeIds: () => string[];
  /** Returns the kind of manual break used when a block has no override. */
  getBreakBeforeKind: () => PageBreakMarkerKind;
  /** Returns per-block overrides for nested manual breaks. */
  getBreakBeforeKinds: () => Record<string, PageBreakMarkerKind>;
  /**
   * Resolves the visible label for a marker kind.
   *
   * **種別と表示文言を分けているのが要点。** 以前はラベル文字列そのものを
   * `"改段"` と比較して段区切りを判定していたので、文言を訳した瞬間に
   * `manual-column-break-before` が付かなくなる作りだった。
   */
  getBreakBeforeLabel: (kind: PageBreakMarkerKind) => string;
  /** Resolves the accessible/action label for removing a marker. */
  getRemoveBreakLabel: (kind: PageBreakMarkerKind) => string;
  getRemoveBreakButtonLabel: () => string;
  /** Explicit removal command. Text editing never calls this callback. */
  onRemoveBreak: (blockId: string) => void;
  /** Continuation replicas render markers for context, but only the canonical surface owns commands. */
  isReplicaSurface: () => boolean;
  /** Returns absolute marker layouts when the surrounding editor positions blocks manually. */
  getBreakBeforeMarkerLayouts: () => Record<string, PageBreakMarkerLayout>;
}

export interface PageBreakMarkerLayout {
  x: number;
  y: number;
  width: number;
}

export const paginationGapKey = new PluginKey<DecorationSet>("paginationGap");

/**
 * Inserts non-editable page-break spacers before whichever top-level block
 * (paragraph/heading) starts a new page, so a multi-paragraph text run can flow
 * across page boundaries inside a single editor without splitting into separate
 * per-page editors. The gap values are computed by the surrounding layout
 * (measured page break plan) and read through `getGaps`; signal the plugin with the
 * `paginationGapKey` meta after they change (`refreshPageBreakGaps`, or as one of the kinds in
 * `TextFlowEditor` の合図まとめ).
 */
export const PageBreakGapExtension = Extension.create<PageBreakGapOptions>({
  name: "paginationGap",

  addOptions() {
    return {
      getGaps: () => ({}),
      getBreakBeforeIds: () => [],
      getBreakBeforeKind: () => "pageBreak",
      getBreakBeforeKinds: () => ({}),
      // 既定は種別名そのもの。configure を忘れると画面に `pageBreak` と出るので、
      // 「文言が要る面は必ず渡す」ことをテストと型で担保している。
      getBreakBeforeLabel: (kind) => kind,
      getRemoveBreakLabel: (kind) => `Remove ${kind}`,
      getRemoveBreakButtonLabel: () => "Remove",
      onRemoveBreak: () => {},
      isReplicaSurface: () => false,
      getBreakBeforeMarkerLayouts: () => ({}),
    };
  },

  addProseMirrorPlugins() {
    const getGaps = () => this.options.getGaps();
    const getBreakBeforeIds = () => new Set(this.options.getBreakBeforeIds());
    const getBreakBeforeKind = () => this.options.getBreakBeforeKind();
    const getBreakBeforeKinds = () => this.options.getBreakBeforeKinds();
    const getBreakBeforeLabel = (kind: PageBreakMarkerKind) => this.options.getBreakBeforeLabel(kind);
    const getRemoveBreakLabel = (kind: PageBreakMarkerKind) => this.options.getRemoveBreakLabel(kind);
    const getRemoveBreakButtonLabel = () => this.options.getRemoveBreakButtonLabel();
    const getBreakBeforeMarkerLayouts = () => this.options.getBreakBeforeMarkerLayouts();
    const isReplicaSurface = () => this.options.isReplicaSurface();

    const build = (doc: ProseMirrorNode) => createPageBreakDecorations(
      doc,
      getGaps(),
      getBreakBeforeIds(),
      {
        markerKind: getBreakBeforeKind(),
        markerKinds: getBreakBeforeKinds(),
        markerLayouts: getBreakBeforeMarkerLayouts(),
        markerLabel: getBreakBeforeLabel,
        removeLabel: getRemoveBreakLabel,
        removeButtonLabel: getRemoveBreakButtonLabel,
        onRemove: isReplicaSurface() ? undefined : this.options.onRemoveBreak,
      },
    );

    return [
      new Plugin<DecorationSet>({
        key: paginationGapKey,
        // 装飾は plugin state に持つ。`props.decorations` に直接書くと、装飾とは無関係な
        // transaction (選択移動・他プラグインの再描画合図) のたびに文書を丸ごと歩き直す。
        // ここで消しているのはその「無関係な走査」だけで、**文書が変われば必ず作り直す**。
        state: {
          init: (_config, state) => build(state.doc),
          apply: (transaction, decorations) => shouldRebuildPageBreakDecorations(transaction)
            ? build(transaction.doc)
            : decorations,
        },
        props: {
          decorations: (state) => paginationGapKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

/**
 * 作り直すか、前回の装飾をそのまま使うか。
 *
 * **文書が変わったら必ず作り直す**。写像 (`DecorationSet.map`) で済ませたくなるが、この装飾に
 * 関しては 2 つの理由で成立しない:
 *
 * 1. `setContent` は文書全体を覆う 1 本の ReplaceStep なので、内部の位置が全部潰れて spacer と
 *    改ページ印が**丸ごと消える**。undo/redo は全ユニットがこの経路を通る。ページ割りは
 *    「いま描かれている spacer」を DOM から読む (`page-canvas/applied-gaps.ts`) ので、黙って
 *    消えた spacer はそのまま「同じ文書に自己整合な別のレイアウト」に化ける。
 * 2. 写像は widget を**別のブロックの上へ運ぶ**。余白付きブロックの先頭で Enter を打つと、
 *    id は中身のある側に残るのに widget は新しくできた空段落の前に居座る。逆に先頭で
 *    Backspace すると、印が段落の途中 (インライン位置) へ移る。
 *
 * 余白と改ページ印の値は外 (レイアウト計算) から来るので、その更新は meta で知らせてもらう。
 */
export function shouldRebuildPageBreakDecorations(transaction: Transaction): boolean {
  return transaction.docChanged || transaction.getMeta(paginationGapKey) !== undefined;
}

export interface PageBreakDecorationOptions {
  /** 上書きの無いブロックの区切り種別。 */
  markerKind?: PageBreakMarkerKind;
  /** ブロックごとの種別の上書き (入れ子の段区切りなど)。 */
  markerKinds?: Record<string, PageBreakMarkerKind>;
  markerLayouts?: Record<string, PageBreakMarkerLayout>;
  /** 種別 → 表示文言。**表示言語はここだけが知っている**ので必須。 */
  markerLabel: (kind: PageBreakMarkerKind) => string;
  removeLabel?: (kind: PageBreakMarkerKind) => string;
  removeButtonLabel?: () => string;
  onRemove?: (blockId: string) => void;
}

export function createPageBreakDecorations(
  doc: ProseMirrorNode,
  gaps: Record<string, number>,
  breakIds: ReadonlySet<string>,
  {
    markerKind = "pageBreak",
    markerKinds = {},
    markerLayouts = {},
    markerLabel,
    removeLabel,
    removeButtonLabel,
    onRemove,
  }: PageBreakDecorationOptions,
): DecorationSet {
  const decorations: Decoration[] = [];

  // Markers walk the whole document, not just the top level: a manual break can sit on a
  // block nested inside a box or a layout section, and without this the user gets no visible
  // sign that a break exists there at all (and nothing to right-click to remove it).
  countDecorationBlockWalk();
  doc.descendants((node, pos) => {
    // 改ページ印はブロックに付く。textblock の中身 (テキスト・数式) に降りても用は無い。
    const descend = !node.isTextblock && !node.isLeaf;
    const id = typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : null;
    if (!id || !breakIds.has(id)) {
      return descend;
    }

    // `sigmaDocId` は教材が決める任意の文字列なので、素のオブジェクトを id で引くと
    // `constructor` や `toString` という id のブロックが `Object.prototype` の中身を掴む
    // (印のラベルが関数のソースになる・配置が NaN になる)。持ち主かどうかを必ず確かめる。
    const layout = own(markerLayouts, id);
    const layoutKey = layout
      ? `${Math.round(layout.x)}:${Math.round(layout.y)}:${Math.round(layout.width)}`
      : "inline";
    const resolvedMarkerKind = own(markerKinds, id) ?? markerKind;
    const resolvedMarkerLabel = markerLabel(resolvedMarkerKind);
    if (resolvedMarkerKind === "columnBreak") {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "manual-column-break-before",
        }),
      );
    }
    decorations.push(
      Decoration.widget(pos, () => createPageBreakMarker(
        id,
        resolvedMarkerLabel,
        removeLabel?.(resolvedMarkerKind),
        removeButtonLabel?.(),
        onRemove,
        layout,
      ), {
        blockId: id,
        kind: "page-break-marker",
        // key に種別ではなく**表示文言**を混ぜる。言語を切り替えたとき、
        // ProseMirror に「別の widget だ」と分からせて描き直させるため。
        key: `page-break-marker-${id}-${resolvedMarkerKind}-${resolvedMarkerLabel}-${layoutKey}`,
        markerKind: resolvedMarkerKind,
        markerLabel: resolvedMarkerLabel,
        side: -2,
      }),
    );
    return descend;
  });

  // Spacers stay top-level only. A nested layout-section break is realized by the
  // `manual-column-break-before` node decoration in CSS columns.
  countDecorationBlockWalk();
  doc.forEach((node, offset) => {
    const id = typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : null;
    const gap = id ? Math.round(own(gaps, id) ?? 0) : 0;
    if (!id || gap <= 0) {
      return;
    }
    decorations.push(
      Decoration.widget(offset, () => createPageBreakSpacer(id, gap), {
        blockId: id,
        gap,
        kind: "page-break-spacer",
        key: `page-break-spacer-${id}-${gap}`,
        side: -1,
      }),
    );
  });

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/** 自前のキーだけを読む (`__proto__` / `constructor` という id への保険)。 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function createPageBreakMarker(
  blockId: string,
  labelText: string,
  removeLabel: string | undefined,
  removeButtonLabel: string | undefined,
  onRemove: ((blockId: string) => void) | undefined,
  layout?: PageBreakMarkerLayout,
): HTMLElement {
  const marker = document.createElement("div");
  marker.className = "page-break-marker";
  marker.contentEditable = "false";
  marker.setAttribute("data-page-break-marker", "");
  marker.setAttribute("data-page-break-block-id", blockId);
  if (layout) {
    marker.classList.add("positioned");
    marker.style.left = `${Math.round(layout.x)}px`;
    marker.style.top = `${Math.round(layout.y)}px`;
    marker.style.width = `${Math.round(layout.width)}px`;
  }

  createPageBreakMarkerContent(marker, {
    labelText,
    removeLabel,
    removeButtonLabel,
    onRemove: onRemove ? () => onRemove(blockId) : undefined,
  });
  return marker;
}

function createPageBreakSpacer(blockId: string, gap: number): HTMLElement {
  const spacer = document.createElement("div");
  spacer.className = "page-break-spacer";
  spacer.contentEditable = "false";
  spacer.setAttribute("aria-hidden", "true");
  spacer.setAttribute("data-page-break-spacer", "");
  spacer.setAttribute("data-page-break-block-id", blockId);
  spacer.style.height = `${Math.max(0, gap)}px`;
  return spacer;
}

/**
 * Force the decoration plugin to recompute after the gap map changes (no doc change).
 *
 * 本文の編集器は装飾の合図を 1 本の transaction にまとめるので、そちらは `paginationGapKey` の
 * meta を直接載せる (`TextFlowEditor` の `dispatchTextFlowDecorationRefresh`)。この関数は
 * 「合図を 1 つだけ打ちたい」呼び出し元のための入口。
 */
export function refreshPageBreakGaps(view: EditorView | null | undefined): void {
  if (!view) {
    return;
  }
  view.dispatch(view.state.tr.setMeta(paginationGapKey, Date.now()));
}
