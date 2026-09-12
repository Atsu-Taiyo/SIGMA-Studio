import {
  Extension,
  InputRule,
  mergeAttributes,
  Node as TiptapNode,
  nodeInputRule,
  wrappingInputRule,
  type ChainedCommands,
} from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

import {
  BLOCK_SPACE_AFTER_CSS_VARIABLE,
  blockSpaceAfterFromStyleValue,
  blockSpaceAfterStyleAttr,
  normalizeCodeBlockTheme,
  rendersBlockSpaceAfter,
} from "@/features/document";
import { normalizeCodeLanguage } from "@/features/rendering/adapters";
import { createId } from "@/lib/id";

/**
 * 本文へ足せるブロック（引用・コード・区切り線）と、それを作る入力ルール。
 *
 * 要点は「SigmaDoc に無いノードは編集面のスキーマにも入れない」こと。かつては StarterKit の
 * `blockquote` / `codeBlock` / `horizontalRule` が有効なまま残っていて、`> ` と打つと引用ができ、
 * 次の同期で **中身ごと黙って消えて** いた（`tiptapToTextFlow` が知らない種別を捨てるため）。
 * `createRichTextEngineExtensions` がその 3 つを外し、代わりにここが SigmaDoc へ往復できる形で
 * 同じ書き味を与える。
 *
 * 3 つとも **本物のブロック** で、段落に属性を足したものではない。特にコードは「1 ブロック＝
 * 1 つの箱・中の行間は一定」でなければならず、段落を積み上げて隣接 CSS で箱に見せる作りは
 * チャンク境界・改ページウィジェット・段組の絶対配置が間に入った瞬間に破綻する。
 */

const PARAGRAPH_NODE_NAME = "paragraph";

export const QUOTE_NODE_NAME = "quote";
export const CODE_BLOCK_NODE_NAME = "codeBlock";
export const DIVIDER_NODE_NAME = "divider";

/**
 * 引用ブロック。中に本文ブロックを持てる入れ物。
 *
 * `defining` にしてあるので、中身を全部選んで貼り替えても入れ物が残る（囲み枠と同じ規約）。
 * `isolating` にはしない — 引用の先頭で Backspace を押したら前のブロックへ抜けられるのが自然で、
 * 囲み枠のように「中と外を完全に切る」入れ物ではないため。
 */
export const QuoteBlockExtension = TiptapNode.create({
  name: QUOTE_NODE_NAME,
  group: "block",
  content: `(${PARAGRAPH_NODE_NAME} | heading | bulletList | orderedList | ${CODE_BLOCK_NODE_NAME} | ${DIVIDER_NODE_NAME})+`,
  defining: true,

  addAttributes() {
    return sigmaDocBlockAttributes(QUOTE_NODE_NAME);
  },

  parseHTML() {
    return [{ tag: "blockquote" }];
  },

  renderHTML({ HTMLAttributes }) {
    // 静的描画（TextFlowStaticBlock）と同じ形。クリップボードの HTML もこれになるので、
    // 外へ貼っても引用として渡る。`data-sigma-doc-id` は他の本文ブロックと同じく出す
    // (落とすと `[data-sigma-doc-id]` を引く経路から引用だけが見えなくなる)。
    return ["blockquote", mergeAttributes(HTMLAttributes, { class: "print-quote" }), 0];
  },

  addInputRules() {
    return [wrappingInputRule({ find: /^\s*>\s$/, type: this.type })];
  },
});

/**
 * コードブロック。改行を含む 1 つのテキストブロック。
 *
 * `code: true` にはしない。すると PM の Enter が `newlineInCode` になり、改行が **生の `\n`
 * 文字**として入る一方、保存を往復した後は `hardBreak` ノードになる。同じ見た目で DOM だけが
 * 「打った直後」と「開き直した後」で違う、というのはこのリポジトリが最も嫌う形なので、
 * 改行は本文の他の場所と同じ `hardBreak` に統一して Enter を自前で割り当てる。
 *
 * `whitespace: "pre"` は貼り付け時に字下げの空白を落とさないため。表示側の折り返しは
 * `document-surface.css` の `white-space: pre-wrap` が持つ。
 */
export const CodeBlockExtension = TiptapNode.create({
  name: CODE_BLOCK_NODE_NAME,
  group: "block",
  content: "inline*",
  // 文字単位の書式（フォント・大きさ・色・太字）を効かせたいので mark を落とさない。
  marks: "_",
  defining: true,
  whitespace: "pre",

  addAttributes() {
    return {
      ...sigmaDocBlockAttributes(CODE_BLOCK_NODE_NAME),
      language: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeCodeLanguage(element.getAttribute("data-code-language")) ?? null,
        renderHTML: (attributes: Record<string, unknown>) => {
          const language = normalizeCodeLanguage(attributes.language);
          return language ? { "data-code-language": language } : {};
        },
      },
      theme: {
        default: "light",
        parseHTML: (element: HTMLElement) => normalizeCodeBlockTheme(element.getAttribute("data-code-theme")) ?? "light",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-code-theme": normalizeCodeBlockTheme(attributes.theme) ?? "light",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "pre", preserveWhitespace: "full" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["pre", { ...HTMLAttributes, class: "print-code" }, 0];
  },

  addInputRules() {
    return [
      codeBlockFenceInputRule(this.type),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Enter は改行。ただし空行の上でもう一度押したら、その空行を消してブロックの外へ出る
      // （リストの「空項目で Enter を押すと抜ける」と同じ発想で、出口を覚えなくてよくする）。
      Enter: () => {
        if (!this.editor.isActive(CODE_BLOCK_NODE_NAME)) {
          return false;
        }
        // `commands.first` は使わない。あれは 1 つの transaction を共有して候補を順に
        // 試すので、先頭が「消してから挿す」ような複数ステップだと、後続の候補が
        // 途中の doc を前提に走って壊れる。単独で呼べば片方しか動かない。
        return this.editor.commands.command(exitCodeBlockOnTrailingEmptyLine)
          || this.editor.commands.setHardBreak();
      },
      // 空行を作らずに抜ける手。Word / VS Code どちらの手癖でも出られるように両方置く。
      "Mod-Enter": () => this.editor.isActive(CODE_BLOCK_NODE_NAME)
        && this.editor.commands.command(exitCodeBlock),
      "Shift-Enter": () => this.editor.isActive(CODE_BLOCK_NODE_NAME)
        && this.editor.commands.setHardBreak(),
    };
  },
});

/**
 * Markdown の fence を打ち始めた段落をコードブロックへ変える。
 *
 * 既定の `textblockTypeInputRule` では fence の後へ空白を打ったときしか発火しない。
 * そのため空白なしの fence は段落の文字として残り、後からツールバーでコードへ
 * 変えると backtick まで本文になっていた。4 文字目を入力した時点で fence だけを消し、
 * 空白なら従来どおり捨て、それ以外の文字ならコードの先頭文字として残す。
 */
function codeBlockFenceInputRule(type: NodeType): InputRule {
  return new InputRule({
    find: (text) => {
      const match = /^\s*(`{3,}|~{3,})([\s\S]+)$/.exec(text);
      if (!match || match[2][0] === match[1][0]) {
        return null;
      }
      return {
        text: match[0],
        index: 0,
        data: { suffix: match[2] },
      };
    },
    handler: ({ state, range, match }) => {
      const $start = state.doc.resolve(range.from);
      if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), type)) {
        return null;
      }
      const suffix = typeof match.data?.suffix === "string" ? match.data.suffix : "";
      state.tr
        .delete(range.from, range.to)
        .setBlockType(range.from, range.from, type);
      if (suffix.trim().length > 0) {
        state.tr.insertText(suffix, range.from);
      }
      return undefined;
    },
  });
}

/**
 * 区切り線。中身を持たない唯一の本文ブロック。
 *
 * `atom` なのでキャレットは中へ入らず、選んで Delete すれば消える。
 */
export const DividerExtension = TiptapNode.create({
  name: DIVIDER_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return sigmaDocBlockAttributes(DIVIDER_NODE_NAME);
  },

  parseHTML() {
    return [{ tag: "hr" }];
  },

  renderHTML({ HTMLAttributes }) {
    // 他の本文ブロックと同じく `data-sigma-doc-id` を出す。これが無いと、図形アンカー・
    // コメントアンカー・キャレットの面判定など `[data-sigma-doc-id]` を引く経路から
    // 区切り線だけが見えなくなる。
    return ["hr", mergeAttributes(HTMLAttributes, { class: "print-divider" })];
  },

  addInputRules() {
    return [nodeInputRule({ find: /^(?:---|—-|___\s|\*\*\*\s)$/, type: this.type })];
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    bodyBlocks: {
      /** 選択範囲を引用でくるむ / 外す。 */
      toggleQuoteBlock: () => ReturnType;
      /** 段落とコードブロックを行き来する。 */
      toggleCodeBlock: () => ReturnType;
      /** 区切り線を差し込む / 選んでいる区切り線を外す。 */
      toggleDivider: () => ReturnType;
      /** コードブロックの言語を選び直す。`null` で自動判定へ戻す。 */
      setCodeBlockLanguage: (language: string | null) => ReturnType;
    };
  }
}

export const BodyBlockCommandsExtension = Extension.create({
  name: "bodyBlockCommands",

  addCommands() {
    return {
      toggleQuoteBlock: () => ({ editor, chain }) => (
        editor.isActive(QUOTE_NODE_NAME)
          ? chain().command(unwrapQuoteBlock).run()
          // コードブロックは中身が inline なので、そのままだと引用の content 式に合う。
          // 見出し・リストも引用の中に置けるので、包む前に段落へ倒す必要は無い。
          : chain().wrapIn(QUOTE_NODE_NAME).run()
      ),

      toggleCodeBlock: () => ({ editor, chain }) => (
        editor.isActive(CODE_BLOCK_NODE_NAME)
          ? chain().setNode(PARAGRAPH_NODE_NAME).run()
          // リストの項目からは先に抜ける。リスト項目の中の段落をそのままコードにすると
          // 「マーカーの付いたコードブロック」という誰も望まない形になる。
          : chain()
              .liftListItem("listItem")
              .command(removeLeadingCodeFenceOnConversion)
              .setNode(CODE_BLOCK_NODE_NAME)
              .run()
      ),

      setCodeBlockLanguage: (language) => ({ chain }) => chain()
        .updateAttributes(CODE_BLOCK_NODE_NAME, { language: normalizeCodeLanguage(language) ?? null })
        .run(),

      // 区切り線を選んでいるときは外す。ツールバーのボタンは「付ける」だけでなく
      // 「外す」でもある、という他のボタンと同じ約束にそろえる。
      toggleDivider: () => ({ editor, chain }) => (
        editor.isActive(DIVIDER_NODE_NAME)
          ? chain().deleteSelection().run()
          : insertDividerChain(chain)
      ),
    };
  },
});

/**
 * ツールバーや slash command で段落をコードへ変えるときだけ、先頭の Markdown marker を
 * 操作用の文字として消す。既にコードブロックになっている本文には触れないため、コード例の
 * 内側にある fence や、保存済みの literal な backtick はそのまま残る。
 */
function removeLeadingCodeFenceOnConversion({ state, tr }: RawCommandProps): boolean {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || $from.parent.type.name === CODE_BLOCK_NODE_NAME) {
    return true;
  }
  const text = $from.parent.textBetween(0, $from.parent.content.size, "\n", "￼");
  const fence = /^\s*(?:`{3,}|~{3,})[ \t]?/.exec(text)?.[0];
  if (!fence) {
    return true;
  }
  tr.delete($from.start(), $from.start() + fence.length);
  return true;
}

/**
 * Tiptap 自身の `setHorizontalRule` と同じ手順。区切り線の後ろに何も無いときだけ段落を足すのが
 * 肝で、これが無いと文末に置いた瞬間「その先へ入力できない」行き止まりになる（本文では
 * trailingNode を切ってあるため、誰も直してくれない）。
 */
function insertDividerChain(chain: () => ChainedCommands): boolean {
  return chain()
    .insertContent({ type: DIVIDER_NODE_NAME })
    .command(({ state, tr, dispatch }) => {
      if (!dispatch) {
        return true;
      }
      const { $to } = tr.selection;
      const posAfter = $to.end();
      if ($to.nodeAfter) {
        if ($to.nodeAfter.isTextblock) {
          tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1));
        } else if ($to.nodeAfter.isBlock) {
          tr.setSelection(NodeSelection.create(tr.doc, $to.pos));
        } else {
          tr.setSelection(TextSelection.create(tr.doc, $to.pos));
        }
      } else {
        // 後ろに置く段落には最初から id を振る。この後で「どこへ焦点を戻すか」を
        // 呼び出し側へ返すのに、id の無いブロックだと指し示せない。
        const node = state.schema.nodes[PARAGRAPH_NODE_NAME]?.create({ sigmaDocId: createId("p") });
        if (node) {
          tr.insert(posAfter, node);
          tr.setSelection(TextSelection.create(tr.doc, posAfter + 1));
        }
      }
      tr.scrollIntoView();
      return true;
    })
    .run();
}

/** SigmaDoc のブロックが共通で運ぶ属性。id と改ページ指定だけで、見た目は持たない。 */
function sigmaDocBlockAttributes(sigmaDocType: string) {
  return {
    sigmaDocId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-sigma-doc-id"),
      renderHTML: (attributes: Record<string, unknown>) => {
    const id = typeof attributes.sigmaDocId === "string" ? attributes.sigmaDocId : undefined;
    return id ? { id, "data-sigma-doc-id": id } : {};
      },
    },
    sigmaDocType: {
      default: sigmaDocType,
      renderHTML: () => ({ "data-sigma-doc-type": sigmaDocType }),
    },
    // 改ページ指定は他のブロックと同じ規約で運ぶ。見た目ではないので DOM へは出さない
    // （描画は page-break-gap-extension が SigmaDoc から作る）。
    pagination: {
      default: null,
      keepOnSplit: false,
      parseHTML: () => null,
      renderHTML: () => ({}),
    },
    // ブロック下余白。区切り線だけが DOM へ出す — 引用とコードは枠と背景を持つので
    // padding が枠の内側に入り「下に余白」ではなく「枠が下に伸びる」になる (今回は描かない)。
    // 描かない種別でも値そのものは運ぶ: 落とすと編集のたびに attrs から消える。
    spaceAfterPx: {
      default: null,
      keepOnSplit: false,
      parseHTML: (element: HTMLElement) => (
        rendersBlockSpaceAfter(sigmaDocType)
          ? blockSpaceAfterFromStyleValue(element.style.getPropertyValue(BLOCK_SPACE_AFTER_CSS_VARIABLE))
          : null
      ),
      renderHTML: (attributes: Record<string, unknown>) => (
        rendersBlockSpaceAfter(sigmaDocType) ? blockSpaceAfterStyleAttr(attributes.spaceAfterPx) : {}
      ),
    },
  };
}

interface RawCommandProps {
  state: EditorState;
  tr: Transaction;
  dispatch?: (tr: Transaction) => void;
}

/**
 * 引用を **入れ物ごと** 外して、中身を外側へ戻す。
 *
 * Tiptap の `lift` はキャレットのある段落だけを持ち上げるので、3 行の引用の 2 行目で押すと
 * 引用が 2 つに割れる。ツールバーのボタンは「このブロックを解除する」ものなので、
 * 中身を全部そのまま外へ出す。
 */
function unwrapQuoteBlock({ state, tr, dispatch }: RawCommandProps): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== QUOTE_NODE_NAME) {
      continue;
    }
    if (dispatch) {
      const quote = $from.node(depth);
      tr.replaceWith($from.before(depth), $from.after(depth), quote.content);
      tr.scrollIntoView();
    }
    return true;
  }
  return false;
}

/** コードブロックの直後へ空段落を作って抜ける。 */
function exitCodeBlock({ state, tr, dispatch }: RawCommandProps): boolean {
  const { $from } = state.selection;
  const paragraphType = state.schema.nodes[PARAGRAPH_NODE_NAME];
  if (!paragraphType) {
    return false;
  }
  if (dispatch) {
    const after = $from.after($from.depth);
    tr.insert(after, paragraphType.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    tr.scrollIntoView();
  }
  return true;
}

/**
 * 末尾の空行の上で Enter を押したときだけ、その空行を消してブロックの外へ出る。
 *
 * 「末尾の空行」= キャレットがブロックの末尾にあり、その直前が改行であること。
 * それ以外（途中の空行など）では何もせず、通常の改行に譲る。
 */
function exitCodeBlockOnTrailingEmptyLine({ state, tr, dispatch }: RawCommandProps): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== CODE_BLOCK_NODE_NAME) {
    return false;
  }
  if ($from.parentOffset !== $from.parent.content.size) {
    return false;
  }
  const last = $from.parent.lastChild;
  if (!last || last.type.name !== "hardBreak") {
    return false;
  }

  const paragraphType = state.schema.nodes[PARAGRAPH_NODE_NAME];
  if (!paragraphType) {
    return false;
  }

  if (dispatch) {
    // 「ブロックの直後」は削除する前に決めて、削除ぶんを map で写す。削除後の doc から
    // 位置を取り直すより、元の位置 1 つを写すほうが手数が少なく取り違えようがない。
    const after = $from.after($from.depth);
    const breakStart = $from.pos - last.nodeSize;
    // 末尾の改行を消してから抜ける。残すと「抜けたのに空行だけ増える」になる。
    tr.delete(breakStart, $from.pos);
    const insertAt = tr.mapping.map(after);
    tr.insert(insertAt, paragraphType.create());
    tr.setSelection(TextSelection.create(tr.doc, insertAt + 1));
    tr.scrollIntoView();
  }
  return true;
}
