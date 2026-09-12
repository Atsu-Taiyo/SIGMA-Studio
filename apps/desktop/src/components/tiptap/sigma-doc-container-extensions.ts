import { Node as TiptapNodeExtension, type Editor as TiptapEditor } from "@tiptap/core";
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
import { findAncestorNodeDepth } from "./node-queries";
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
  content: "boxBlockTitle boxBlockBody",
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

export const BoxBlockTitleExtension = TiptapNodeExtension.create<BoxBlockTitleOptions>({
  name: "boxBlockTitle",
  content: "inline*",
  defining: true,

  addOptions() {
    return {
      readOnly: false,
    };
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

function moveSelectionFromBoxTitleToBody(editor: TiptapEditor): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  const titleDepth = findAncestorNodeDepth($from, "boxBlockTitle");
  if (titleDepth < 1) {
    return false;
  }

  const boxDepth = titleDepth - 1;
  const boxNode = $from.node(boxDepth);
  const titleNode = boxNode.firstChild;
  if (boxNode.type.name !== "boxBlock" || titleNode?.type.name !== "boxBlockTitle") {
    return false;
  }

  const boxStart = $from.before(boxDepth);
  const bodyStart = boxStart + 1 + titleNode.nodeSize;
  const selection = TextSelection.near(state.doc.resolve(bodyStart + 1), 1);
  editor.view.dispatch(state.tr.setSelection(selection).scrollIntoView());
  return true;
}

function isSelectionInsideBoxTitle(editor: TiptapEditor): boolean {
  return findAncestorNodeDepth(editor.state.selection.$from, "boxBlockTitle") >= 0;
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
  const titleNode = boxNode.firstChild;
  if (boxNode.type.name !== "boxBlock" || titleNode?.type.name !== "boxBlockTitle") {
    return false;
  }

  const boxStart = $from.before(boxDepth);
  const titleEnd = boxStart + titleNode.nodeSize;
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
