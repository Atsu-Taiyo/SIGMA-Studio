import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { normalizeBlockSpaceAfterPx } from "@/features/document";

/**
 * 図中テキストの「段落の下の余白」つまみが扱う単位と、その幾何。React には依存しない。
 *
 * 本文のつまみ (`PageCanvasEditor`) は SigmaDoc のブロック id で相手を指す。図中テキストの編集面は
 * ブロック id を DOM に出さない (`overlay-text-block-attrs.ts`) ので、ProseMirror の doc の中の位置で指す。
 * 位置は属性を書き換えるだけの操作 (このつまみ自身) では動かない。構造が変わる編集 (Enter・削除・
 * 取り消し) の後は指し直す — 呼び出し側は {@link isSpaceAfterTransaction} の印が無い docChanged で
 * 掴んでいた相手を手放す。
 */

/** このつまみが起こした transaction の印。構造が変わる編集と区別するのに使う。 */
export const SPACE_AFTER_TRANSACTION_META = "overlayTextSpaceAfter";

export function isSpaceAfterTransaction(transaction: Transaction): boolean {
  return transaction.getMeta(SPACE_AFTER_TRANSACTION_META) === true;
}

/**
 * 余白を持てる単位。本文のつまみと同じ規則 (`rendersBlockSpaceAfter`) で、段落・見出し・区切り線と
 * リストの項目 (入れ子も) だけ。引用・コードは枠の中に余白が入ってしまうので描かない。
 */
export interface TextShapeSpaceAfterUnit {
  /** 単位のノードの doc 内の位置 (`view.nodeDOM` が引ける)。 */
  pos: number;
  kind: "block" | "listItem";
  node: ProseMirrorNode;
}

const BLOCK_NODE_NAMES = new Set(["paragraph", "heading", "divider"]);
const LIST_NODE_NAMES = new Set(["bulletList", "orderedList"]);

/** doc の先頭から順 (深い単位は外側の単位より後) に並べる。 */
export function collectTextShapeSpaceAfterUnits(doc: ProseMirrorNode): TextShapeSpaceAfterUnit[] {
  const units: TextShapeSpaceAfterUnit[] = [];

  const visitList = (list: ProseMirrorNode, listPos: number) => {
    list.forEach((item, offset) => {
      if (item.type.name !== "listItem") {
        return;
      }
      const itemPos = listPos + 1 + offset;
      units.push({ pos: itemPos, kind: "listItem", node: item });
      item.forEach((child, childOffset) => {
        if (LIST_NODE_NAMES.has(child.type.name)) {
          visitList(child, itemPos + 1 + childOffset);
        }
      });
    });
  };

  doc.forEach((child, offset) => {
    if (BLOCK_NODE_NAMES.has(child.type.name)) {
      units.push({ pos: offset, kind: "block", node: child });
    } else if (LIST_NODE_NAMES.has(child.type.name)) {
      visitList(child, offset);
    }
  });
  return units;
}

/** 位置を含む最も内側の単位 (リストの入れ子では内側の項目) の添字。無ければ -1。 */
export function findInnermostTextShapeSpaceAfterUnitIndex(
  units: readonly TextShapeSpaceAfterUnit[],
  pos: number,
): number {
  let found = -1;
  units.forEach((unit, index) => {
    if (unit.pos <= pos && pos < unit.pos + unit.node.nodeSize) {
      found = index;
    }
  });
  return found;
}

/**
 * ポインタの下の要素が属する単位の要素。リストの中なら最も内側の `li`、そうでなければ編集面の直下の
 * 子 (段落・見出し・リスト・引用…)。編集面の外 (余白など) は null。
 * 呼び出し側が `view.nodeDOM` と突き合わせて単位を決める。
 */
export function resolveSpaceAfterUnitElement(target: Element, root: HTMLElement): HTMLElement | null {
  for (let node: Element | null = target; node && node !== root; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.tagName === "LI" || node.parentElement === root)) {
      return node;
    }
  }
  return null;
}

/** 単位が今持っている下余白 (px)。無ければ 0。 */
export function readTextShapeSpaceAfterPx(unit: TextShapeSpaceAfterUnit): number {
  if (unit.kind === "block") {
    return normalizeBlockSpaceAfterPx(unit.node.attrs.spaceAfterPx) ?? 0;
  }
  // 項目の値は先頭の段落が持つ (項目の id もそこにある)。`li` 自身の属性は描画用の写し。
  return normalizeBlockSpaceAfterPx(unit.node.firstChild?.attrs.listItemSpaceAfterPx) ?? 0;
}

/**
 * 単位の下余白を書き込む transaction を `tr` に積む。0 は null (= 未指定) にして、リセットした結果が
 * 「一度も触っていないブロック」と同じ JSON になるようにする (`normalizeBlockSpaceAfterPx`)。
 *
 * ノードの大きさも位置も変えないので、選択 (キャレット) はそのまま残る。
 */
export function setTextShapeSpaceAfter(
  tr: Transaction,
  unit: TextShapeSpaceAfterUnit,
  px: number,
): Transaction {
  const next = normalizeBlockSpaceAfterPx(px) ?? null;
  if (unit.kind === "block") {
    return tr.setNodeMarkup(unit.pos, undefined, { ...unit.node.attrs, spaceAfterPx: next });
  }
  const leading = unit.node.firstChild;
  if (leading) {
    tr.setNodeMarkup(unit.pos + 1, undefined, { ...leading.attrs, listItemSpaceAfterPx: next });
  }
  return tr.setNodeMarkup(unit.pos, undefined, { ...unit.node.attrs, spaceAfterPx: next });
}

/**
 * 余白が描かれる縁の要素。段落・見出し・区切り線は自分自身、リスト項目は最後の所有本文 (継続行、
 * 無ければ先頭行) — 入れ子のリストはその後ろに残る (`document-surface.css` の項目余白の規則)。
 */
export function resolveSpaceAfterEdgeElement(view: EditorView, unit: TextShapeSpaceAfterUnit): HTMLElement | null {
  const dom = view.nodeDOM(unit.pos);
  if (!(dom instanceof HTMLElement)) {
    return null;
  }
  if (unit.kind === "block") {
    return dom;
  }
  const owned = Array.from(dom.children).filter((child): child is HTMLElement => (
    child instanceof HTMLElement && child.tagName !== "UL" && child.tagName !== "OL"
  ));
  return owned.at(-1) ?? null;
}

/**
 * `ancestor` の左上を原点にした、要素の下端 (px)。
 *
 * レイアウトの値 (`offsetTop`/`offsetHeight`) だけで測る。図形は回転しているかもしれず、
 * `getBoundingClientRect` は回転すると外接矩形になって元の下端が読めない。レイアウトの値は
 * 回転・ズームの前の局所 px なので、そのまま図形の中に置くつまみの座標になる。
 * `ancestor` が位置指定の祖先 (offsetParent の鎖) に無いときは null。
 */
export function measureBottomWithin(element: HTMLElement, ancestor: HTMLElement): number | null {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return node === ancestor ? top + element.offsetHeight : null;
}

/**
 * ポインタの画面上の移動量を、図形の局所の縦方向の移動量 (論理 px) に直す。
 *
 * 図形は `rotate(θ)` で回り、紙面はズームの `scale` で拡大されるので、画面の (dx, dy) を局所の
 * 縦軸 (回転後は (-sinθ, cosθ)) へ射影して、拡大率で割り戻す。回転 0・等倍なら dy そのもの。
 */
export function projectPointerDeltaToShapeY(
  deltaX: number,
  deltaY: number,
  rotationRad: number,
  scale: number,
): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const rotation = Number.isFinite(rotationRad) ? rotationRad : 0;
  return (-deltaX * Math.sin(rotation) + deltaY * Math.cos(rotation)) / safeScale;
}
