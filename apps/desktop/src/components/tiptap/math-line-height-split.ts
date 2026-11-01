import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep, type Mapping } from "@tiptap/pm/transform";

/**
 * Enter で段落を割ったとき、段落の行の高さ (`lineHeight`) は通常どおり後ろへ引き継ぐ。
 * ただし数式を含む段落だけは別扱いにする: 背の高い数式 (分数・指数の入れ子など) に
 * 合わせて広げた行間 (外部教材の取り込みの `lineHeight: "3"` など) が、数式の無い次の行へ
 * そのまま写ると、ふつうの文字の行が数式の行と同じ高さになってしまう。
 *
 * そこで「数式を含む段落を Enter で割った結果、数式を持たない側」だけ `lineHeight` を外して
 * 文書の既定の行の高さへ戻す。数式を持つ側は元の行間のまま残す。
 *
 * 対象は利用者の Enter だけ (キー押下の直後の分割)。undo の逆変換や貼り付け・外部同期が
 * 同じ形の分割を作っても触らない。
 */
export const MathLineHeightSplitExtension = Extension.create({
  name: "mathLineHeightSplit",

  addProseMirrorPlugins() {
    // エディタごとに作られるので、この変数はそのエディタの「直前のキーが Enter か」になる。
    let enterPending = false;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            keydown: (_view, event) => {
              enterPending = event.key === "Enter" && !event.isComposing;
              return false;
            },
          },
        },
        appendTransaction: (transactions, _oldState, newState) => {
          if (!enterPending) {
            return null;
          }
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null;
          }
          enterPending = false;
          return releaseInheritedMathLineHeight(transactions, newState);
        },
      }),
    ];
  },
});

/**
 * `transactions` の中の段落分割 (`tr.split` が作る空の開いた slice の挿入) を探し、分割の
 * 両側の段落で、数式を含まない側が数式を含む側と同じ `lineHeight` を持っていれば外す。
 */
export function releaseInheritedMathLineHeight(
  transactions: readonly Transaction[],
  newState: EditorState,
): Transaction | null {
  const splitPoints: Array<{ before: number; after: number }> = [];
  transactions.forEach((transaction, transactionIndex) => {
    transaction.steps.forEach((step, stepIndex) => {
      if (!isTextBlockSplitStep(step)) {
        return;
      }
      const rest = remainingMapping(transactions, transactionIndex, stepIndex);
      splitPoints.push({
        before: rest.map(step.from, -1),
        after: rest.map(step.from + step.slice.size, 1),
      });
    });
  });
  if (splitPoints.length === 0) {
    return null;
  }

  const { doc } = newState;
  const releases = new Map<number, ProseMirrorNode>();
  splitPoints.forEach(({ before, after }) => {
    const first = textBlockAt(doc, before);
    const second = textBlockAt(doc, after);
    if (!first || !second || first.pos === second.pos) {
      return;
    }
    const lineHeight = first.node.attrs.lineHeight;
    if (lineHeight == null || second.node.attrs.lineHeight !== lineHeight) {
      return;
    }
    const firstHasMath = containsInlineMath(first.node);
    const secondHasMath = containsInlineMath(second.node);
    if (firstHasMath === secondHasMath) {
      return;
    }
    const plain = firstHasMath ? second : first;
    releases.set(plain.pos, plain.node);
  });
  if (releases.size === 0) {
    return null;
  }

  const tr = newState.tr;
  releases.forEach((node, pos) => {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight: null }, node.marks);
  });
  // 打った文字の書式 (storedMarks) は setNodeMarkup で消えるので戻す。
  if (newState.storedMarks) {
    tr.setStoredMarks(newState.storedMarks);
  }
  return tr;
}

function isTextBlockSplitStep(step: unknown): step is ReplaceStep {
  if (!(step instanceof ReplaceStep)) {
    return false;
  }
  const { from, to, slice } = step as ReplaceStep & { from: number; to: number };
  if (from !== to || slice.openStart < 1 || slice.openStart !== slice.openEnd) {
    return false;
  }
  // tr.split は「閉じる側・開く側」の空の写しだけを入れる (中身の文字は持たない)。
  return slice.content.childCount === 2 && slice.content.textBetween(0, slice.content.size) === ""
    && slice.content.firstChild?.type === slice.content.lastChild?.type;
}

function remainingMapping(
  transactions: readonly Transaction[],
  transactionIndex: number,
  stepIndex: number,
): Pick<Mapping, "map"> {
  const mappings = [
    transactions[transactionIndex].mapping.slice(stepIndex + 1),
    ...transactions.slice(transactionIndex + 1).map((transaction) => transaction.mapping),
  ];
  return {
    map: (pos: number, assoc = 1) => mappings.reduce((current, mapping) => mapping.map(current, assoc), pos),
  };
}

function textBlockAt(doc: ProseMirrorNode, pos: number): { node: ProseMirrorNode; pos: number } | null {
  if (pos < 0 || pos > doc.content.size) {
    return null;
  }
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.depth === 0) {
    return null;
  }
  return { node: $pos.parent, pos: $pos.before() };
}

function containsInlineMath(node: ProseMirrorNode): boolean {
  let found = false;
  node.forEach((child) => {
    if (child.type.name === "mathInline") {
      found = true;
    }
  });
  return found;
}
