import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { readEditorClipboardPayload } from "@/lib/editor-clipboard";

/**
 * inline しか持てない入れ物（コードブロック・箱のタイトル）への貼り付け。
 *
 * この 2 つは中身が inline だけなので、貼るものを段落のまま渡すと ProseMirror は入れ物を
 * **閉じて** 残りを外へ出す。3 行貼ると 1 行目だけコードに入り、2 行目以降がコードの箱の
 * 後ろの段落になる — ユーザーから見れば「コードブロックから溢れ出る」。ここで貼るものを
 * inline へ畳んでから入れることで、貼り付け先の箱の中に収める。
 *
 * 改行は本文の他の場所と同じ `hardBreak` に揃える。テキストの中の `\n` をそのまま入れると
 * 「打った直後」と「保存を往復した後」で DOM が変わる（`body-block-extensions.ts` の Enter が
 * `newlineInCode` を避けているのと同じ理由）。
 */

/**
 * 貼り付けを inline に畳んで中へ入れる入れ物。
 *
 * 段落と見出しは入れない — あれは割れてよいブロックで、複数段落を貼れば段落が増えるのが
 * 正しい。ここに挙げるのは「1 ブロック＝1 つの箱」であることが意味を持つ入れ物だけ。
 */
const INLINE_ONLY_PASTE_BLOCKS = new Set(["codeBlock", "boxBlockTitle"]);

/**
 * 書式を持ち込まず、プレーンテキストとして貼る入れ物。
 *
 * コードは自前で構文の色分けをするので、コピー元（エディタや Web ページ）の文字色・リンクが
 * 一緒に入ってくると自分の色と喧嘩する。どのコードエディタでも貼り付けはプレーンテキスト。
 */
const PLAIN_TEXT_PASTE_BLOCKS = new Set(["codeBlock"]);

/** 選択が inline だけの入れ物の中に収まっているならその入れ物を返す。 */
export function resolveInlinePasteBlock(state: EditorState): ProseMirrorNode | null {
  const { $from, $to } = state.selection;
  if (!$from.parent.isTextblock || $from.parent !== $to.parent) {
    // 入れ物を跨いだ選択（＝入れ物ごと置き換える貼り付け）は通常の経路に任せる。
    return null;
  }
  return INLINE_ONLY_PASTE_BLOCKS.has($from.parent.type.name) ? $from.parent : null;
}

/**
 * 貼り付け先が inline だけの入れ物なら、貼るものを畳んでその中へ入れる。
 * 対象でなければ `false` を返し、通常の貼り付け経路へ譲る。
 */
export function pasteAsInlineContent(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  const target = resolveInlinePasteBlock(view.state);
  if (!target) {
    return false;
  }

  const content = inlinePasteContent(view.state.schema, target, event.clipboardData, slice);
  if (!content) {
    // 文字を持たないクリップボード（画像・ファイル）はここで判断しない。
    return false;
  }

  event.preventDefault();
  view.dispatch(
    view.state.tr
      .replaceSelection(new Slice(content, 0, 0))
      .scrollIntoView()
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste"),
  );
  return true;
}

/**
 * 面ごと inline しか保存できないエディタ（表のセル・コメント・ブロックエディタ）の貼り付け。
 *
 * これらは編集面としては段落を持てるが、保存するとき `tiptapDocToInlineNodes` が **先頭
 * ブロックの中身だけ** を取る。3 行貼ると画面には 3 行出るのに、保存すると 2 行目以降が
 * 黙って消える（実測）。溢れ先が見えないぶんコードブロックより質が悪いので、ここでも
 * 貼るものを 1 ブロックぶんの inline へ畳む。
 */
export function pasteAsSingleBlockInlineContent(
  view: EditorView,
  event: ClipboardEvent,
  slice: Slice,
): boolean {
  const { $from, $to } = view.state.selection;
  if (!$from.parent.isTextblock || $from.parent !== $to.parent) {
    return false;
  }

  const clipboardData = event.clipboardData;
  const payload = clipboardData ? readEditorClipboardPayload(clipboardData) : null;
  if (payload?.kind === "inlineMath") {
    // 数式 1 つのコピーは inline を 1 つ挿すだけで、ブロックは増えない。
    // 数式拡張の貼り付けに任せる（こちらは HTML を持たないので畳みようがない）。
    return false;
  }

  // 数式を含むコピーは PM の HTML ではなく private MIME の slice が正本。text/html は
  // 空の payload div なので、ここで読まないと `$x^2$` という素のテキストに落ちる。
  let pastedSlice = slice;
  if (payload?.kind === "tiptapSlice") {
    try {
      pastedSlice = Slice.fromJSON(view.state.schema, payload.slice as Parameters<typeof Slice.fromJSON>[1]);
    } catch {
      pastedSlice = slice;
    }
  }

  const content = inlinePasteContent(view.state.schema, $from.parent, clipboardData, pastedSlice);
  if (!content) {
    return false;
  }

  event.preventDefault();
  view.dispatch(
    view.state.tr
      .replaceSelection(new Slice(content, 0, 0))
      .scrollIntoView()
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste"),
  );
  return true;
}

/**
 * 入れ物の中へ入れられる inline の並びを作る。
 *
 * コードは外から来たものをクリップボードのプレーンテキストとして読む。ProseMirror が HTML
 * から作った slice は空行を畳んでしまう（段落の切れ目でしか行を分けないため）ので、コードの
 * 空行を保つには生のテキストを行で割るのが唯一確実な手。
 *
 * ただしコードから写したもの（inline だけ、またはコードブロックだけの slice）は slice のまま
 * 入れる。改行は hardBreak で来るので空行はそのまま残り、書式も落ちない — コードの一部を
 * コピーして別のコードへ貼るのに、自分で付けた色が消えるのはおかしい。
 */
export function inlinePasteContent(
  schema: Schema,
  target: ProseMirrorNode,
  clipboardData: Pick<DataTransfer, "getData"> | null,
  slice: Slice,
): Fragment | null {
  const plainText = clipboardData?.getData("text/plain") ?? "";
  const preferPlainText = PLAIN_TEXT_PASTE_BLOCKS.has(target.type.name) && !isCodeShapedSlice(slice);
  const candidates = preferPlainText
    ? [
        () => inlineNodesFromText(schema, plainText),
        () => inlineNodesFromSlice(schema, slice, false),
      ]
    : [
        () => inlineNodesFromSlice(schema, slice, true),
        () => inlineNodesFromText(schema, plainText),
      ];

  for (const buildNodes of candidates) {
    const fragment = Fragment.fromArray(
      buildNodes().map((node) => keepAllowedMarks(target, node)),
    );
    if (fragment.size > 0 && target.type.validContent(fragment)) {
      return fragment;
    }
  }
  return null;
}

/** コードから写した slice か（inline だけ、またはコードブロックだけで出来ているか）。 */
function isCodeShapedSlice(slice: Slice): boolean {
  if (slice.content.size === 0) {
    return false;
  }
  let codeShaped = true;
  slice.content.forEach((child) => {
    if (!child.isInline && !PLAIN_TEXT_PASTE_BLOCKS.has(child.type.name)) {
      codeShaped = false;
    }
  });
  return codeShaped;
}

/** クリップボードの生テキストを行で割る。空行もそのまま 1 行として残す。 */
function inlineNodesFromText(schema: Schema, text: string): ProseMirrorNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return joinLinesWithHardBreak(
    schema,
    lines.map((line) => (line ? [schema.text(line)] : [])),
  );
}

/**
 * ProseMirror が解釈した slice を inline へ畳む。
 *
 * 行を作るのはテキストブロック（段落・見出し・リスト項目の中身）だけ。引用・リスト・箱の
 * ような入れ物は行を作らずに中へ降りるので、「引用の中の 2 段落」は 2 行になる。
 */
function inlineNodesFromSlice(schema: Schema, slice: Slice, keepMarks: boolean): ProseMirrorNode[] {
  const lines: ProseMirrorNode[][] = [[]];
  let textblockSeen = false;
  const pushNode = (node: ProseMirrorNode) => lines[lines.length - 1].push(node);
  const startLine = () => lines.push([]);

  const visitInline = (node: ProseMirrorNode) => {
    if (node.isText) {
      const marks = keepMarks ? node.marks : [];
      (node.text ?? "").split("\n").forEach((part, index) => {
        if (index > 0) {
          startLine();
        }
        if (part) {
          pushNode(schema.text(part, marks));
        }
      });
      return;
    }
    if (node.type.name === "hardBreak") {
      startLine();
      return;
    }
    pushNode(keepMarks ? node : node.mark([]));
  };

  const visit = (fragment: Fragment) => {
    fragment.forEach((child) => {
      if (child.isInline) {
        visitInline(child);
        return;
      }
      if (child.isTextblock) {
        if (textblockSeen) {
          startLine();
        }
        textblockSeen = true;
      }
      visit(child.content);
    });
  };

  visit(slice.content);
  return joinLinesWithHardBreak(schema, lines);
}

function joinLinesWithHardBreak(schema: Schema, lines: ProseMirrorNode[][]): ProseMirrorNode[] {
  const hardBreakType = schema.nodes.hardBreak;
  const nodes: ProseMirrorNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0 && hardBreakType) {
      nodes.push(hardBreakType.create());
    }
    nodes.push(...line);
  });
  return nodes;
}

/** 入れ物が許していない mark は落とす（許されない mark を含む Fragment は挿入自体が弾かれる）。 */
function keepAllowedMarks(target: ProseMirrorNode, node: ProseMirrorNode): ProseMirrorNode {
  const allowed = node.marks.filter((mark) => target.type.allowsMarkType(mark.type));
  return allowed.length === node.marks.length ? node : node.mark(allowed);
}
