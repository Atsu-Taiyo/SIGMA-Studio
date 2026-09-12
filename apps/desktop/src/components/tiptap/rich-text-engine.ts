import { Extension, type Extensions } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";

import {
  BodyBlockCommandsExtension,
  CodeBlockExtension,
  DividerExtension,
  QuoteBlockExtension,
} from "@/components/tiptap/body-block-extensions";
import { CodeHighlightExtension } from "@/components/tiptap/code-highlight-extension";
import { BoxedTextRunHeightExtension } from "@/components/tiptap/boxed-text-run-height";
import { InlineMathExtension } from "@/components/tiptap/inline-math-extension";
import { ListMarkerTypographyExtension } from "@/components/tiptap/list-marker-typography-extension";
import { NativeHistoryGuardExtension } from "@/components/tiptap/native-history-guard";
import { ParenOrderedListExtension } from "@/components/tiptap/paren-ordered-list-extension";
import { SearchHighlightExtension } from "@/components/tiptap/search-highlight-extension";
import {
  BoxedTextExtension,
  LineHeightExtension,
  StyledTextExtension,
  TextBlockStyleExtension,
  UnderlineExtension,
} from "@/components/tiptap/text-format-extensions";
import type { MathFractionSizing } from "@/features/document";
import {
  DEFAULT_MATH_RENDER_ENVIRONMENT,
  type MathRenderEnvironment,
} from "@/lib/math-environment";

const DEFAULT_HEADING_LEVELS: [1, 2, 3] = [1, 2, 3];

interface ListShortcutEditor {
  state?: EditorState;
  isActive: (name: string) => boolean;
  commands: {
    liftListItem: (typeOrName: string) => boolean;
    sinkListItem: (typeOrName: string) => boolean;
  };
}

export function shouldLiftNestedEmptyListItemOnEnter(state: EditorState): boolean {
  const { selection } = state;
  if (!selection.empty || !selection.$from.parent.isTextblock || selection.$from.parent.content.size !== 0) {
    return false;
  }

  let listItemDepth = -1;
  for (let depth = selection.$from.depth - 1; depth > 0; depth -= 1) {
    if (selection.$from.node(depth).type.name === "listItem") {
      listItemDepth = depth;
      break;
    }
  }
  if (listItemDepth < 0 || selection.$from.node(listItemDepth).childCount !== 1) {
    return false;
  }

  for (let depth = listItemDepth - 1; depth > 0; depth -= 1) {
    if (selection.$from.node(depth).type.name === "listItem") {
      return true;
    }
  }
  return false;
}

export function runNestedEmptyListEnter(editor: ListShortcutEditor): boolean {
  return editor.state && shouldLiftNestedEmptyListItemOnEnter(editor.state)
    ? editor.commands.liftListItem("listItem")
    : false;
}

export function runListKeyboardShortcut(editor: ListShortcutEditor, command: "lift" | "sink"): boolean {
  if (!editor.isActive("listItem")) {
    return false;
  }

  if (command === "sink") {
    editor.commands.sinkListItem("listItem");
  } else {
    editor.commands.liftListItem("listItem");
  }

  return true;
}

const ListKeyboardShortcutsExtension = Extension.create({
  name: "listKeyboardShortcuts",
  priority: 110,

  addKeyboardShortcuts() {
    return {
      Enter: () => runNestedEmptyListEnter(this.editor),
      "Shift-Enter": () => this.editor.isActive("listItem")
        ? this.editor.commands.splitBlock()
        : false,
      Tab: () => runListKeyboardShortcut(this.editor, "sink"),
      "Shift-Tab": () => runListKeyboardShortcut(this.editor, "lift"),
    };
  },
});

interface RichTextEngineOptions {
  blockExtensions?: Extensions;
  /**
   * Draw one rectangle per connected boxed run (`BoxedTextRunHeightOptions.drawRunFrames`).
   * Surfaces that swap this editor for a static renderer on blur must leave it off so the box
   * does not change shape with focus.
   */
  drawBoxedRunFrames?: boolean;
  enableMathDelimiters?: boolean;
  heading?: false | { levels?: [1, 2, 3] };
  lineHeight?: boolean;
  /**
   * Draw list markers in the typography of the item's first run.
   *
   * Off by default: only the body surface has a static twin that draws lists. On a surface whose
   * read-only rendering is inline-only, turning this on would make the editing surface differ from
   * what is printed.
   */
  listMarkerTypography?: boolean;
  /**
   * `renderHTML` (クリップボード / HTML シリアライズ) は React の外で走るので数式描画環境の
   * context が使えない。文書の前文マクロと組版スタイルを届けたい面はここで渡す。
   */
  mathEnvironment?: MathRenderEnvironment;
  mathFractionSizing?: MathFractionSizing | null;
  /**
   * 引用・コード・区切り線を本文ブロックとして使えるようにする。
   *
   * 既定は off。判断基準は「この面の変換器がこの 3 つを保存できるか」で、できない面で有効に
   * すると打った内容が保存時に消える (`orderedListMarkerStyles` と同じ理由)。本文と図中テキスト
   * (`overlay-tiptap-adapter.ts` が 3 つとも往復させる) は on、表のセルとブロックエディタは
   * inline だけを保存する変換器なので off のまま。
   */
  bodyBlocks?: boolean;
  /**
   * Turn `(1) ` at the start of a line into an ordered list.
   *
   * Off by default: only the body surface persists list structure. Overlay text shapes, table
   * cells, and block editors save through inline-only converters that would silently drop a list
   * (and with it the user's text), so a marker input rule must never fire there.
   */
  orderedListMarkerStyles?: boolean;
  /**
   * プレースホルダ。文言は関数で遅延評価できるので、表示言語の切り替えでは
   * `useEditor` を作り直さず、装飾の再描画だけで追従させる。
   */
  placeholder?: string | (() => string);
  searchHighlight?: boolean;
  textBlockStyle?: boolean;
}

export function createRichTextEngineExtensions({
  blockExtensions = [],
  drawBoxedRunFrames = true,
  enableMathDelimiters = false,
  heading,
  lineHeight = false,
  bodyBlocks = false,
  listMarkerTypography = false,
  mathEnvironment = DEFAULT_MATH_RENDER_ENVIRONMENT,
  mathFractionSizing,
  orderedListMarkerStyles = false,
  placeholder,
  searchHighlight = false,
  textBlockStyle = false,
}: RichTextEngineOptions = {}): Extensions {
  return [
    // Underline before StarterKit so its schema rank is outer to bold/italic.
    // (Also set priority: 1000 on the mark itself; see UnderlineExtension.)
    UnderlineExtension,
    StarterKit.configure({
      // SigmaDoc に対応するブロックが無い 3 つは、スキーマから外す。
      //
      // 有効なままだと入力ルールが働いて `> ` で引用が、``` でコードブロックができ、
      // `tiptapToTextFlow` がそれを知らない種別として捨てるので、打った文字が黙って消える
      // (実測済み)。代わりを `bodyBlocks` が SigmaDoc へ往復できる形で用意する。
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      heading: heading === false ? false : { levels: heading?.levels ?? DEFAULT_HEADING_LEVELS },
      trailingNode: false,
      undoRedo: false,
      underline: false,
    }),
    ListKeyboardShortcutsExtension,
    // 面ごとの opt-in にしない。**新しい編集面が増えたときに素通しになるのが一番怖い**ので、
    // 共通エンジンを通るものは全部守る (本文・RichTextEditor・図形テキスト・表セル)。
    NativeHistoryGuardExtension,
    // After StarterKit so its own `1. ` ordered-list rule stays untouched.
    ...(orderedListMarkerStyles ? [ParenOrderedListExtension] : []),
    ...(bodyBlocks
      ? [
          QuoteBlockExtension,
          CodeBlockExtension,
          DividerExtension,
          BodyBlockCommandsExtension,
          CodeHighlightExtension,
        ]
      : []),
    ...(listMarkerTypography ? [ListMarkerTypographyExtension] : []),
    ...(placeholder !== undefined ? [Placeholder.configure({ placeholder })] : []),
    ...blockExtensions,
    ...(lineHeight ? [LineHeightExtension] : []),
    ...(textBlockStyle ? [TextBlockStyleExtension] : []),
    BoxedTextExtension,
    BoxedTextRunHeightExtension.configure({ drawRunFrames: drawBoxedRunFrames }),
    StyledTextExtension,
    InlineMathExtension.configure({
      enableDelimiters: enableMathDelimiters,
      mathEnvironment,
      mathFractionSizing,
    }),
    ...(searchHighlight ? [SearchHighlightExtension] : []),
  ];
}
