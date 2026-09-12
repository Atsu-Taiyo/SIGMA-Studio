import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { inlineNodesToPlainText } from "@/lib/tiptap-adapter";
import { listItemContinuationInlineNodes } from "@/features/document";
import type { EditableBlock } from "@/lib/document-tree";
import type { AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import { diffArrays, diffInlineNodes, type InlineDiffSegment } from "@/lib/ai/inline-diff";
import type {
  BoxBlockChildBlock,
  BoxBlockNode,
  InlineNode,
  LayoutSectionChildBlock,
  ListItemNode,
  ListNode,
  ProblemAreaBlock,
} from "@/features/document";

/**
 * 適用済み/提案中のAI編集差分を、GitHub風の「行」単位表示に変換する。React/DOMには
 * 依存しない(electron側のサマリー生成からも将来呼べるようにするため)。
 *
 * SigmaDocにはテキストエディタのような「行」概念が無いので、ブロックツリーの葉
 * (見出し/段落全体、リスト項目1件、問題エリアの各リッチブロックなど)を1行として扱う。
 */

export interface DiffLine {
  /** ブロック単位で一意なキー。ブロック自身のidか、タイトルなど合成キー。 */
  key: string;
  /** 問題エリア(導入文/問題文/コメント/解答)など、行が属するグループの見出し。 */
  label?: string;
  nodes: InlineNode[];
}

function textLine(key: string, text: string, label: string | undefined): DiffLine {
  return { key, label, nodes: text.length > 0 ? [{ type: "text", text }] : [] };
}

function flattenListItem(item: ListItemNode, label: string | undefined): DiffLine[] {
  const lines: DiffLine[] = [{ key: item.id, label, nodes: item.children }];
  for (const continuation of item.continuations ?? []) {
    lines.push({ key: continuation.id, label, nodes: listItemContinuationInlineNodes(continuation) });
  }
  for (const nested of item.nested ?? []) {
    lines.push(...flattenList(nested, label));
  }
  return lines;
}

function flattenList(list: ListNode, label: string | undefined): DiffLine[] {
  return list.items.flatMap((item) => flattenListItem(item, label));
}

function flattenBoxBlock(block: BoxBlockNode, label: string | undefined): DiffLine[] {
  const lines: DiffLine[] = [];
  if (block.title && block.title.length > 0) {
    lines.push({ key: `${block.id}:title`, label, nodes: block.title });
  }
  for (const child of block.blocks) {
    lines.push(...flattenBoxBlockChild(child, label));
  }
  return lines;
}

function flattenLayoutSectionChild(block: LayoutSectionChildBlock, label: string | undefined): DiffLine[] {
  if (block.type === "section") {
    return [textLine(`${block.id}:title`, block.title, label)];
  }
  if (block.type === "heading" || block.type === "paragraph") {
    return [{ key: block.id, label, nodes: block.children }];
  }
  if (block.type === "list") {
    return flattenList(block, label);
  }
  // 区切り線には比較する文章が無い。
  if (block.type === "divider") {
    return [];
  }
  if (block.type === "codeBlock") {
    return [{ key: block.id, label, nodes: block.children }];
  }
  if (block.type === "quote") {
    return block.blocks.flatMap((child) => flattenLayoutSectionChild(child, label));
  }
  return flattenBoxBlock(block, label);
}

function flattenBoxBlockChild(block: BoxBlockChildBlock, label: string | undefined): DiffLine[] {
  if (block.type === "problem") return [...block.lead, ...block.prompt, ...block.hints, ...block.solution].flatMap((child) => flattenRichBlock(child, label));
  if (block.type === "layoutSection") {
    return block.children.flatMap((child) => flattenLayoutSectionChild(child, label));
  }
  return flattenLayoutSectionChild(block, label);
}

function flattenRichBlock(block: ProblemAreaBlock, label: string | undefined): DiffLine[] {
  if (block.type === "heading" || block.type === "paragraph") {
    return [{ key: block.id, label, nodes: block.children }];
  }
  if (block.type === "list") {
    return flattenList(block, label);
  }
  if (block.type === "boxBlock") {
    return flattenBoxBlock(block, label);
  }
  if (block.type === "divider") {
    return [];
  }
  if (block.type === "codeBlock") {
    return [{ key: block.id, label, nodes: block.children }];
  }
  if (block.type === "quote") {
    return block.blocks.flatMap((child) => flattenLayoutSectionChild(child, label));
  }
  return block.children.flatMap((child) => flattenLayoutSectionChild(child, label));
}

/** 1つのSigmaDocブロックを、差分比較できる「行」の並びへ平らにする。 */
/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_EDITOR_TRANSLATE = createCurrentLocaleTranslator("editor");

export function flattenBlockLines(
  block: EditableBlock,
  t: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): DiffLine[] {
  if (block.type === "section") {
    return [textLine(`${block.id}:title`, block.title, undefined)];
  }
  if (block.type === "heading" || block.type === "paragraph") {
    return [{ key: block.id, nodes: block.children }];
  }
  if (block.type === "listItem") {
    return flattenListItem(block, undefined);
  }
  if (block.type === "list") {
    return flattenList(block, undefined);
  }
  if (block.type === "layoutSection") {
    return block.children.flatMap((child) => flattenLayoutSectionChild(child, undefined));
  }
  if (block.type === "boxBlock") {
    return flattenBoxBlock(block, undefined);
  }
  if (block.type === "divider") {
    return [];
  }
  if (block.type === "codeBlock") {
    return [{ key: block.id, nodes: block.children }];
  }
  if (block.type === "quote") {
    return block.blocks.flatMap((child) => flattenLayoutSectionChild(child, undefined));
  }
  // problem: 導入文/問題文/コメント/解答の順(紙面描画の PROBLEM_AREA_ORDER と揃える)。
  // 区分の呼び名は `editor.block.problem*` が唯一の出典 (本文編集面と同じ語)。
  const areas: Array<[ProblemAreaBlock[], string]> = [
    [block.lead, t("block.problemLead")],
    [block.prompt, t("block.problemPrompt")],
    [block.hints, t("block.problemHints")],
    [block.solution, t("block.problemSolution")],
  ];
  return areas.flatMap(([blocks, label]) => blocks.flatMap((areaBlock) => flattenRichBlock(areaBlock, label)));
}

function linePlainText(line: DiffLine): string {
  return inlineNodesToPlainText(line.nodes);
}

export interface AppliedDiffContextRow {
  type: "context";
  key: string;
  label?: string;
  nodes: InlineNode[];
}

export interface AppliedDiffChangedRow {
  type: "removed" | "added";
  key: string;
  label?: string;
  segments: InlineDiffSegment[];
}

export interface AppliedDiffCollapsedRow {
  type: "collapsed";
  count: number;
  rows: AppliedDiffContextRow[];
}

export type AppliedDiffRow = AppliedDiffContextRow | AppliedDiffChangedRow | AppliedDiffCollapsedRow;

function pushChangedLinePair(
  rows: AppliedDiffRow[],
  removedLine: DiffLine,
  addedLine: DiffLine,
  inlineDiff = diffInlineNodes(removedLine.nodes, addedLine.nodes),
): void {
  rows.push({
    type: "removed",
    key: removedLine.key,
    label: removedLine.label,
    segments: inlineDiff.removed.length > 0
      ? inlineDiff.removed
      : [{ changed: true, nodes: removedLine.nodes }],
  });
  rows.push({
    type: "added",
    key: addedLine.key,
    label: addedLine.label,
    segments: inlineDiff.added.length > 0
      ? inlineDiff.added
      : [{ changed: true, nodes: addedLine.nodes }],
  });
}

/** 削除前/追加後が同じブロックidを持つ「修正ペア」を、行単位で整列してGitHub風の行にする。 */
function buildRowsForPair(
  removedBlock: EditableBlock,
  addedBlock: EditableBlock,
  t: Translate<"editor">,
): AppliedDiffRow[] {
  const removedLines = flattenBlockLines(removedBlock, t);
  const addedLines = flattenBlockLines(addedBlock, t);
  const ops = diffArrays(removedLines, addedLines, linePlainText);

  const rows: AppliedDiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === "equal") {
      const removedLine = op.a!;
      const addedLine = op.b!;
      // 行のLCSは読みやすい整列のためplain textで取るが、同じ文字列でも装飾だけが
      // 変わることがある。contextと確定する前に、見た目の属性を含むinline差分を確認する。
      const inlineDiff = diffInlineNodes(removedLine.nodes, addedLine.nodes);
      if (inlineDiff.changed) {
        pushChangedLinePair(rows, removedLine, addedLine, inlineDiff);
      } else {
        rows.push({ type: "context", key: removedLine.key, label: removedLine.label, nodes: removedLine.nodes });
      }
      i++;
      continue;
    }

    // 隣り合う削除/追加の連続区間は、git風に「入れ替わった行同士」として index 順にペアリングし、
    // 単語単位のハイライトを出す。片方が余った分はそのまま丸ごと削除/追加の行にする。
    const removedRun: typeof removedLines = [];
    const addedRun: typeof addedLines = [];
    while (i < ops.length && ops[i].type !== "equal") {
      if (ops[i].type === "remove") {
        removedRun.push(ops[i].a!);
      } else {
        addedRun.push(ops[i].b!);
      }
      i++;
    }

    const pairCount = Math.min(removedRun.length, addedRun.length);
    for (let k = 0; k < pairCount; k++) {
      const removedLine = removedRun[k];
      const addedLine = addedRun[k];
      pushChangedLinePair(rows, removedLine, addedLine);
    }
    for (let k = pairCount; k < removedRun.length; k++) {
      rows.push({
        type: "removed",
        key: removedRun[k].key,
        label: removedRun[k].label,
        segments: [{ changed: true, nodes: removedRun[k].nodes }],
      });
    }
    for (let k = pairCount; k < addedRun.length; k++) {
      rows.push({
        type: "added",
        key: addedRun[k].key,
        label: addedRun[k].label,
        segments: [{ changed: true, nodes: addedRun[k].nodes }],
      });
    }
  }

  return rows;
}

// 5行以上連続したcontext行は間を折りたたむ(両端の1行ずつは見えたままにする) —
// サイドバーの狭い幅で、変更の無いブロック全体を延々スクロールさせないため。
const CONTEXT_COLLAPSE_THRESHOLD = 4;

function collapseContextRuns(rows: AppliedDiffRow[]): AppliedDiffRow[] {
  const result: AppliedDiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type !== "context") {
      result.push(row);
      i++;
      continue;
    }
    const run: AppliedDiffContextRow[] = [];
    let j = i;
    while (j < rows.length) {
      const candidate = rows[j];
      if (candidate.type !== "context") break;
      run.push(candidate);
      j++;
    }
    if (run.length > CONTEXT_COLLAPSE_THRESHOLD) {
      const middle = run.slice(1, -1);
      result.push(run[0]);
      result.push({ type: "collapsed", count: middle.length, rows: middle });
      result.push(run[run.length - 1]);
    } else {
      result.push(...run);
    }
    i = j;
  }
  return result;
}

/**
 * 適用済み/提案中のAI編集差分から、GitHub風の統一差分行を組み立てる。同じブロックidを
 * 持つ削除/追加は「修正ペア」として行単位で整列し、単語/数式レベルのハイライトを付ける。
 * ペアの中身が完全に一致する(移動やレイアウト変更だけの)場合は何も出さない。
 */
export function buildAppliedDiffRows(
  diff: Pick<AiAppliedDocumentDiff, "body">,
  t: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): AppliedDiffRow[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const removedById = new Map<string, EditableBlock>();
  const addedById = new Map<string, EditableBlock>();

  for (const entry of diff.body) {
    if (!seen.has(entry.block.id)) {
      seen.add(entry.block.id);
      order.push(entry.block.id);
    }
    if (entry.change === "removed") {
      removedById.set(entry.block.id, entry.block);
    } else {
      addedById.set(entry.block.id, entry.block);
    }
  }

  const rows: AppliedDiffRow[] = [];
  for (const id of order) {
    const removedBlock = removedById.get(id);
    const addedBlock = addedById.get(id);
    if (removedBlock && addedBlock) {
      const pairRows = buildRowsForPair(removedBlock, addedBlock, t);
      if (pairRows.some((row) => row.type !== "context")) {
        rows.push(...pairRows);
      }
      continue;
    }
    if (removedBlock) {
      for (const line of flattenBlockLines(removedBlock, t)) {
        rows.push({ type: "removed", key: line.key, label: line.label, segments: [{ changed: true, nodes: line.nodes }] });
      }
      continue;
    }
    if (addedBlock) {
      for (const line of flattenBlockLines(addedBlock, t)) {
        rows.push({ type: "added", key: line.key, label: line.label, segments: [{ changed: true, nodes: line.nodes }] });
      }
    }
  }

  return collapseContextRuns(rows);
}

/** GitHubの +n/-n に相当する、行単位の実差分集計。context行(折りたたみ内も含む)は数えない。 */
export function countAppliedDiffLines(rows: AppliedDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === "added") {
      added++;
    } else if (row.type === "removed") {
      removed++;
    }
  }
  return { added, removed };
}
