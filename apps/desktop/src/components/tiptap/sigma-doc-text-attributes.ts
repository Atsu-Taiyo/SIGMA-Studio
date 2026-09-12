import { Extension } from "@tiptap/core";

import {
  BLOCK_SPACE_AFTER_CSS_VARIABLE,
  blockSpaceAfterFromStyleValue,
  blockSpaceAfterStyleAttr,
  listItemSpaceAfterStyleAttr,
  normalizeLineHeight,
} from "@/features/document";
import { normalizeTextAlign } from "@/features/text-editing";

export const SigmaDocTextAttrs = Extension.create({
  name: "sigmaDocTextAttrs",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "bulletList", "orderedList"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => element.style.textAlign || null,
            renderHTML: (attributes) => {
              const align = normalizeTextAlign(attributes.textAlign);
              return align ? { style: `text-align: ${align}` } : {};
            },
          },
          lineHeight: {
            default: null,
            parseHTML: (element) => element.style.lineHeight || null,
            renderHTML: (attributes) => {
              const lineHeight = normalizeLineHeight(attributes.lineHeight);
              return lineHeight ? { style: `line-height: ${lineHeight}` } : {};
            },
          },
          // ブロック下余白。`pagination` と違って **DOM へ出す** — 編集面・静的描画・印刷/PDF が
          // 同じインライン custom property を読んで `document-surface.css` の padding になる。
          // (`mergeAttributes` は同じ `style` キーを "; " で繋ぐので textAlign / lineHeight と共存する)
          spaceAfterPx: {
            default: null,
            // Enter で割ったとき後半へ複製しない。「このブロックの下の余白」なので前半が持つ。
            keepOnSplit: false,
            parseHTML: (element) => blockSpaceAfterFromStyleValue(
              element.style.getPropertyValue(BLOCK_SPACE_AFTER_CSS_VARIABLE),
            ),
            renderHTML: (attributes) => blockSpaceAfterStyleAttr(attributes.spaceAfterPx),
          },
          sigmaDocId: {
            default: null,
            renderHTML: (attributes) => {
              const id = typeof attributes.sigmaDocId === "string" ? attributes.sigmaDocId : undefined;
              return id ? { id, "data-sigma-doc-id": id } : {};
            },
          },
          sigmaDocType: {
            default: null,
            renderHTML: (attributes) => {
              const type = typeof attributes.sigmaDocType === "string" ? attributes.sigmaDocType : undefined;
              return type ? { "data-sigma-doc-type": type } : {};
            },
          },
        },
      },
      {
        // The persisted value remains on a non-rendering leading-paragraph attribute because that
        // paragraph owns the list-item id and survives split/reconciliation. The `li` gets a
        // dedicated layout variable: continuations belong above the adjustable edge, while a
        // nested list belongs below it.
        types: ["listItem"],
        attributes: {
          spaceAfterPx: {
            default: null,
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: (attributes) => listItemSpaceAfterStyleAttr(attributes.spaceAfterPx),
          },
        },
      },
      {
        types: ["paragraph", "heading"],
        attributes: {
          // Persistence-only list-item field. It must not render the ordinary block spacing
          // variable on the leading paragraph, or the same item space is drawn twice.
          listItemSpaceAfterPx: {
            default: null,
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
          // Temporary editor projection ownership. SigmaDoc remains canonical through
          // layout.columnStartIds; this survives deletion of a column-start block in PM.
          layoutColumnIndex: {
            default: null,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
          // View-only: the SigmaDoc body is larger than the layout engine can shape.
          // `tiptapToTextFlow` restores the stored body from the previous block.
          editorLayoutCapped: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.hasAttribute("data-editor-layout-capped") ? true : null,
            renderHTML: (attributes: Record<string, unknown>) => (
              attributes.editorLayoutCapped
                ? {
                    "data-editor-layout-capped": "",
                    ...(typeof attributes.editorLayoutCharCount === "number"
                      ? { "data-editor-layout-chars": String(attributes.editorLayoutCharCount) }
                      : {}),
                  }
                : {}
            ),
          },
          editorLayoutCharCount: {
            default: null,
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
      {
        types: ["bulletList", "orderedList", "quote", "codeBlock", "divider", "boxBlock", "problem"],
        attributes: {
          layoutColumnIndex: {
            default: null,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
      {
        // 改ページ / 改段 / keep 系。SigmaDoc のブロック属性であって見た目ではないので、DOM へは
        // 出さず (描画は page-break-gap-extension の decoration が SigmaDoc から作る)、PM の doc に
        // 載せるのはコピー&ペーストで運ぶためだけ。slice がこれを持たないと、貼り付け先では
        // 新しいブロック id になるので id 一致による復元が効かず、改ページが黙って消える。
        types: ["paragraph", "heading", "bulletList", "orderedList", "boxBlock", "layoutSection"],
        attributes: {
          pagination: {
            default: null,
            // Enter でブロックを割ったとき、後半へ改ページが複製されないようにする
            // (break は「このブロックの前で改ページ」の意味なので、前半だけが持つ)。
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
      {
        // 囲み枠・段組は下余白を **描かない** (padding は枠の内側に入ってしまうため) が、値は
        // PM の doc に載せて往復させる — 載せないと編集のたびに attrs から落ちて黙って消える。
        types: ["boxBlock", "layoutSection", "problem"],
        attributes: {
          spaceAfterPx: {
            default: null,
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
      {
        // Ordered lists only: `markerStyle` is meaningless on paragraphs, headings, and bullets.
        // The attribute name matches `ListNode.markerStyle`; the DOM attribute is what
        // `document-surface.css` selects on, so the editor and the static renderer agree.
        types: ["orderedList"],
        attributes: {
          markerStyle: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-list-marker"),
            renderHTML: (attributes) => (
              attributes.markerStyle === "paren" ? { "data-list-marker": "paren" } : {}
            ),
          },
        },
      },
    ];
  },
});
