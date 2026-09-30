import { Node as TiptapNodeExtension, type Editor as TiptapEditor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

import type { BoxFrameSpec } from "@/features/document";
import { isRecord } from "@/features/text-editing";
import {
  boxFrameClassName,
  boxFrameDecorationAttributes,
  boxFrameStyleAttribute,
  resolveBoxFrame,
} from "@/lib/box-blocks";
import { createTranslator, getAppLocale } from "@/lib/i18n";
import { createBoxSplitHandlePlugin } from "./box-split-handle";
import { findAncestorNodeDepth, findBoxTitleAncestorDepth, isBoxTitleNodeName } from "./node-queries";
import { NestedProblemExtension, NestedProblemAreaExtension, type NestedProblemOptions } from "./nested-problem-extension";

/**
 * Tiptap の `renderHTML` は React の外で走るので `useT` を呼べない。
 * 表示のたびにロケールストアから引く (言語を変えたあと、その箱が
 * 描き直されたときに追随する)。
 */
function boxActionLabel(): string {
  return createTranslator(getAppLocale(), "editor")("box.actions");
}

export const BoxBlockExtension = TiptapNodeExtension.create<NestedProblemOptions>({
  name: "boxBlock",
  group: "block",
  content: "boxBlockTitle boxBlockSubtitle? boxBlockBody",
  defining: true,
  isolating: true,

  addOptions() { return { getProblemNumbers: () => new Map() }; },

  addExtensions() {
    return [NestedProblemExtension.configure(this.options), NestedProblemAreaExtension];
  },

  addAttributes() {
    return {
      sigmaDocId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-sigma-doc-id"),
      },
      sigmaDocType: {
        default: "boxBlock",
      },
      styleId: {
        default: "fancybox",
        parseHTML: (element) => element.getAttribute("data-box-style") || "fancybox",
      },
      frame: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [{ tag: "section[data-sigma-doc-type='boxBlock']" }];
  },

  renderHTML({ node }) {
    const styleId = typeof node.attrs.styleId === "string" ? node.attrs.styleId : "fancybox";
    const frame = isRecord(node.attrs.frame) ? node.attrs.frame as BoxFrameSpec : undefined;
    const resolvedFrame = resolveBoxFrame({ styleId, frame });
    const decorationAttrs = boxFrameDecorationAttributes(resolvedFrame);
    return [
      "section",
      {
        "data-sigma-doc-id": typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : undefined,
        "data-sigma-doc-type": "boxBlock",
        "data-box-style": styleId,
        class: boxFrameClassName("sigma-doc-box-block", resolvedFrame, styleId),
        style: boxFrameStyleAttribute(resolvedFrame),
        ...decorationAttrs,
      },
      ["span", { class: "sigma-doc-box-corner top-left", contenteditable: "false" }],
      ["span", { class: "sigma-doc-box-corner top-right", contenteditable: "false" }],
      ["span", { class: "sigma-doc-box-corner bottom-left", contenteditable: "false" }],
      ["span", { class: "sigma-doc-box-corner bottom-right", contenteditable: "false" }],
      ["button", {
        type: "button",
        class: "sigma-doc-block-action-button sigma-doc-box-action-button",
        "data-box-action-button": "true",
        contenteditable: "false",
        title: boxActionLabel(),
        "aria-label": boxActionLabel(),
        "aria-haspopup": "dialog",
      }, "⋯"],
      ["div", { class: "sigma-doc-box-content" }, 0],
    ];
  },
});

interface BoxBlockTitleOptions {
  readOnly: boolean;
}

/**
 * 2 つ目のタイトル欄。`titleSplit` を持つ箱だけが持つ (箱の content 式では省略可)。
 * 見た目はタイトルと同じ帯なので `sigma-doc-box-title` も名乗り、地色と余白だけ `-subtitle` が足す。
 */
export const BoxBlockSubtitleExtension = TiptapNodeExtension.create<BoxBlockTitleOptions>({
  name: "boxBlockSubtitle",
  content: "inline*",
  defining: true,

  addOptions() {
    return { readOnly: false };
  },

  parseHTML() {
    return [{ tag: "div[data-box-subtitle-region='true']" }];
  },

  renderHTML() {
    return [
      "div",
      {
        class: "sigma-doc-box-title sigma-doc-box-subtitle",
        "data-box-subtitle-region": "true",
        ...(this.options.readOnly ? {
          contenteditable: "false",
          "aria-readonly": "true",
        } : {}),
      },
      0,
    ];
  },

  // 2 欄の境界つまみ。複製面 (読み取り専用) には置かない。
  addProseMirrorPlugins() {
    return this.options.readOnly ? [] : [createBoxSplitHandlePlugin()];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => (
        this.options.readOnly && isSelectionInsideBoxTitle(this.editor)
      ) || moveSelectionFromBoxTitleToBody(this.editor),
    };
  },
});

export const BoxBlockTitleExtension = TiptapNodeExtension.create<BoxBlockTitleOptions>({
  name: "boxBlockTitle",
  content: "inline*",
  defining: true,

  addOptions() {
    return {
      readOnly: false,
    };
  },

  // 2 つ目のタイトル欄。箱の content 式が参照するので、タイトルを登録すれば必ず一緒に入る。
  addExtensions() {
    return [BoxBlockSubtitleExtension.configure({ readOnly: this.options.readOnly })];
  },

  parseHTML() {
    return [{ tag: "div[data-box-title-region='true']" }];
  },

  renderHTML() {
    return [
      "div",
      {
        class: "sigma-doc-box-title",
        "data-box-title-region": "true",
        ...(this.options.readOnly ? {
          contenteditable: "false",
          "aria-readonly": "true",
        } : {}),
      },
      0,
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => (
        this.options.readOnly && isSelectionInsideBoxTitle(this.editor)
      ) || moveSelectionFromBoxTitleToBody(this.editor),
    };
  },
});

interface BoxBlockBodyOptions {
  titleReadOnly: boolean;
}

export const BoxBlockBodyExtension = TiptapNodeExtension.create<BoxBlockBodyOptions>({
  name: "boxBlockBody",
  content: "(block | boxChild)+",
  defining: true,
  isolating: true,

  addOptions() {
    return {
      titleReadOnly: false,
    };
  },

  parseHTML() {
    return [{ tag: "div.sigma-doc-box-body" }];
  },

  renderHTML() {
    return ["div", { class: "sigma-doc-box-body" }, 0];
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => (
        this.options.titleReadOnly && isSelectionAtBoxBodyStart(this.editor)
      ) || moveSelectionFromBoxBodyStartToTitle(this.editor),
    };
  },
});

/** 箱の中で本文 (`boxBlockBody`) の直前までの大きさ = タイトル欄すべての nodeSize の和。 */
function boxHeaderSize(boxNode: ProseMirrorNode): number {
  let size = 0;
  boxNode.forEach((child) => {
    if (isBoxTitleNodeName(child.type.name)) {
      size += child.nodeSize;
    }
  });
  return size;
}

function moveSelectionFromBoxTitleToBody(editor: TiptapEditor): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  const titleDepth = findBoxTitleAncestorDepth($from);
  if (titleDepth < 1) {
    return false;
  }

  const boxDepth = titleDepth - 1;
  const boxNode = $from.node(boxDepth);
  if (boxNode.type.name !== "boxBlock" || boxNode.firstChild?.type.name !== "boxBlockTitle") {
    return false;
  }

  const boxStart = $from.before(boxDepth);
  const bodyStart = boxStart + 1 + boxHeaderSize(boxNode);
  const selection = TextSelection.near(state.doc.resolve(bodyStart + 1), 1);
  editor.view.dispatch(state.tr.setSelection(selection).scrollIntoView());
  return true;
}

function isSelectionInsideBoxTitle(editor: TiptapEditor): boolean {
  return findBoxTitleAncestorDepth(editor.state.selection.$from) >= 0;
}

function moveSelectionFromBoxBodyStartToTitle(editor: TiptapEditor): boolean {
  if (!isSelectionAtBoxBodyStart(editor)) {
    return false;
  }

  const { state } = editor;
  const { $from } = state.selection;
  const bodyDepth = findAncestorNodeDepth($from, "boxBlockBody");
  const boxDepth = bodyDepth - 1;
  const boxNode = $from.node(boxDepth);
  if (boxNode.type.name !== "boxBlock" || boxNode.firstChild?.type.name !== "boxBlockTitle") {
    return false;
  }

  const boxStart = $from.before(boxDepth);
  const titleEnd = boxStart + boxHeaderSize(boxNode);
  const selection = TextSelection.near(state.doc.resolve(titleEnd), -1);
  editor.view.dispatch(state.tr.setSelection(selection).scrollIntoView());
  return true;
}

function isSelectionAtBoxBodyStart(editor: TiptapEditor): boolean {
  const { state } = editor;
  if (!state.selection.empty) {
    return false;
  }

  const { $from } = state.selection;
  const bodyDepth = findAncestorNodeDepth($from, "boxBlockBody");
  if (bodyDepth < 1) {
    return false;
  }

  const bodyStart = $from.before(bodyDepth);
  const firstBodySelection = TextSelection.findFrom(state.doc.resolve(bodyStart + 1), 1, true);
  return firstBodySelection?.from === state.selection.from;
}

export { LayoutSectionExtension } from "./layout-section-extension";
