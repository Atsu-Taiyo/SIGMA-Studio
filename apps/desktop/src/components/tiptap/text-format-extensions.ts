import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import type { MarkType } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { createTextBlockTypographyPlugin } from "./text-block-typography";

import { parseCssFontSizeToPt } from "@/lib/font-size-units";
import {
  normalizeLineHeight,
  type BoxedVariant,
} from "@/features/document";
import {
  boxedInlineDomSpec,
  cssTextFromDeclarations,
  inlineTextStyleDeclarations,
  BOXED_TEXT_CLASS_NAME,
  UNDERLINE_RUN_CLASS_NAME,
} from "@/features/rendering/adapters";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    underline: {
      setUnderline: () => ReturnType;
      toggleUnderline: () => ReturnType;
      unsetUnderline: () => ReturnType;
    };
    boxedText: {
      toggleBoxedText: () => ReturnType;
      setBoxedTextPaddingY: (paddingY: number) => ReturnType;
      setBoxedTextVariant: (variant: BoxedVariant) => ReturnType;
    };
    styledText: {
      setTextColor: (color: string) => ReturnType;
      setTextBackgroundColor: (color: string) => ReturnType;
      setFontFamily: (fontFamily: string) => ReturnType;
      setFontSize: (fontSize: number) => ReturnType;
      unsetTextColor: () => ReturnType;
      unsetTextBackgroundColor: () => ReturnType;
      unsetFontFamily: () => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

export const UnderlineExtension = Mark.create({
  name: "underline",

  // Outer relative to bold/italic from StarterKit (default priority 100).
  // If underline is nested *inside* em/strong, ProseMirror closes the underline
  // span at every italic boundary, splitting one logical underline into many
  // runs (和文=text-decoration baseline, 数式=border-bottom under ink). That
  // produces stepped underlines for mixed italic text + math such as
  // 「あさ」+ sa^2 + 「ああさ」+ ∑. With underline outermost, one
  // `.sigma-underline-run` wraps the whole sequence.
  priority: 1000,

  parseHTML() {
    return [
      { tag: "u" },
      { tag: `span.${UNDERLINE_RUN_CLASS_NAME}` },
      { tag: "span[data-sigma-doc-underline-text]" },
      {
        style: "text-decoration-line",
        getAttrs: (value) => String(value).includes("underline") && null,
      },
      {
        style: "text-decoration",
        getAttrs: (value) => String(value).includes("underline") && null,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: UNDERLINE_RUN_CLASS_NAME, "data-sigma-doc-underline-text": "true" }), 0];
  },

  addCommands() {
    return {
      setUnderline:
        () =>
        ({ dispatch, state }) =>
          updateInlineMarkInSelection(state, dispatch, this.name, {}, "set"),
      toggleUnderline:
        () =>
        ({ dispatch, state }) =>
          updateInlineMarkInSelection(state, dispatch, this.name, {}, "toggle"),
      unsetUnderline:
        () =>
        ({ dispatch, state }) =>
          updateInlineMarkInSelection(state, dispatch, this.name, {}, "unset"),
    };
  },
});

export const BoxedTextExtension = Mark.create({
  name: "boxed",

  // Ranked between underline (1000) and bold/italic (StarterKit's 100) so the schema nests the
  // boxed span exactly where the static renderer puts it: inside the underline run and the
  // styledText span, outside `<strong>`/`<em>`. See `inline-dom-parity.test.tsx`; a box that sits
  // inside `<strong>` in one projection and outside it in the other is a visible jump on focus.
  priority: 200,

  addAttributes() {
    // None of these render DOM on their own: the mark's `renderHTML` below asks the shared
    // projection for the whole element at once, so the class, the data attributes and the custom
    // properties cannot be assembled differently here than in the static renderer.
    return {
      paddingY: {
        default: null,
        parseHTML: (element) => normalizeBoxedPaddingY(element.getAttribute("data-sigma-doc-boxed-padding-y") ?? element.style.paddingTop),
        renderHTML: () => ({}),
      },
      math: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-sigma-doc-boxed-math") === "true",
        renderHTML: () => ({}),
      },
      variant: {
        default: null,
        parseHTML: (element) => normalizeBoxedVariant(element.getAttribute("data-sigma-doc-boxed-variant")),
        renderHTML: () => ({}),
      },
      tone: {
        default: null,
        parseHTML: (element) => normalizeBoxedTone(element.getAttribute("data-sigma-doc-boxed-tone")),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    // Above the default 50 so these are tried before `styledText`'s catch-all `<span>` rule. Mark
    // *priority* decides nesting, and it puts styledText's rule first in the schema's rule list;
    // since that rule cannot decline a match, the box would be parsed away as an attribute-less
    // styling mark — a copied boxed word came back unboxed on paste.
    return [
      { priority: 60, tag: `span.${BOXED_TEXT_CLASS_NAME}` },
      { priority: 60, tag: "span[data-sigma-doc-boxed-text]" },
    ];
  },

  renderHTML({ HTMLAttributes, mark }) {
    const spec = boxedInlineDomSpec(
      {
        paddingY: mark.attrs.paddingY,
        variant: normalizeBoxedVariant(mark.attrs.variant) ?? undefined,
        tone: normalizeBoxedTone(mark.attrs.tone) ?? undefined,
      },
      { math: mark.attrs.math === true },
    );
    const style = cssTextFromDeclarations(spec.style);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: spec.className,
        ...spec.attrs,
        ...(style ? { style } : {}),
      }),
      0,
    ];
  },

  addCommands() {
    return {
      toggleBoxedText:
        () =>
        ({ dispatch, state }) =>
          updateInlineMarkInSelection(state, dispatch, this.name, {}, "toggle", { mergeAttrs: true, mathAttr: true }),
      setBoxedTextPaddingY:
        (paddingY) =>
        ({ dispatch, state }) => {
          const normalizedPaddingY = normalizeBoxedPaddingY(paddingY) ?? 0;
          return updateInlineMarkInSelection(
            state,
            dispatch,
            this.name,
            { paddingY: normalizedPaddingY },
            "set",
            { mergeAttrs: true, mathAttr: true },
          );
        },
      setBoxedTextVariant:
        (variant) =>
        ({ dispatch, state }) => {
          const normalizedVariant = normalizeBoxedVariant(variant) ?? "frame";
          return updateInlineMarkInSelection(
            state,
            dispatch,
            this.name,
            { variant: normalizedVariant === "frame" ? undefined : normalizedVariant },
            "set",
            { mergeAttrs: true, mathAttr: true },
          );
        },
    };
  },
});

export const StyledTextExtension = Mark.create({
  name: "styledText",

  // Outermost of the inline chrome except the underline run, matching the static renderer: an
  // `em`-based box padding has to scale with the font size the styling sets, so the styled span
  // wraps the box rather than the other way round.
  priority: 300,

  addProseMirrorPlugins() {
    return [createTextBlockTypographyPlugin()];
  },

  addAttributes() {
    // The declarations are emitted together by `renderHTML` below, from the same projection the
    // static renderer uses, so the two cannot order or format them differently.
    return {
      color: {
        default: null,
        parseHTML: (element) => element.style.color || null,
        renderHTML: () => ({}),
      },
      backgroundColor: {
        default: null,
        parseHTML: (element) => element.style.backgroundColor || null,
        renderHTML: () => ({}),
      },
      fontFamily: {
        default: null,
        parseHTML: (element) => element.style.fontFamily || null,
        renderHTML: () => ({}),
      },
      fontSize: {
        default: null,
        parseHTML: (element) => normalizeFontSize(element.style.fontSize),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span" }];
  },

  renderHTML({ HTMLAttributes, mark }) {
    const style = cssTextFromDeclarations(inlineTextStyleDeclarations({
      backgroundColor: asNonEmptyString(mark.attrs.backgroundColor),
      color: asNonEmptyString(mark.attrs.color),
      fontFamily: asNonEmptyString(mark.attrs.fontFamily),
      fontSizePt: normalizeFontSize(mark.attrs.fontSize) ?? undefined,
    }));
    return ["span", mergeAttributes(HTMLAttributes, style ? { style } : {}), 0];
  },

  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      setTextBackgroundColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { backgroundColor: color }),
      setFontFamily:
        (fontFamily) =>
        ({ commands }) =>
          commands.setMark(this.name, { fontFamily }),
      setFontSize:
        (fontSize) =>
        ({ commands }) =>
          commands.setMark(this.name, { fontSize }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.setMark(this.name, { color: null }),
      unsetTextBackgroundColor:
        () =>
        ({ commands }) =>
          commands.setMark(this.name, { backgroundColor: null }),
      unsetFontFamily:
        () =>
        ({ commands }) =>
          commands.setMark(this.name, { fontFamily: null }),
      unsetFontSize:
        () =>
        ({ commands }) =>
          commands.setMark(this.name, { fontSize: null }),
    };
  },
});

export const LineHeightExtension = Extension.create({
  name: "lineHeight",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element) => normalizeLineHeight(element.style.lineHeight) ?? null,
            renderHTML: (attributes) => {
              const lineHeight = normalizeLineHeight(attributes.lineHeight);
              return lineHeight ? { style: `line-height: ${lineHeight}` } : {};
            },
          },
        },
      },
    ];
  },
});

export const TextBlockStyleExtension = Extension.create({
  name: "textBlockStyle",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
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
            parseHTML: (element) => normalizeLineHeight(element.style.lineHeight) ?? null,
            renderHTML: (attributes) => {
              const lineHeight = normalizeLineHeight(attributes.lineHeight);
              return lineHeight ? { style: `line-height: ${lineHeight}` } : {};
            },
          },
        },
      },
    ];
  },
});

function normalizeTextAlign(value: unknown): "left" | "center" | "right" | "justify" | undefined {
  return value === "left" || value === "center" || value === "right" || value === "justify" ? value : undefined;
}

export function updateInlineMarkInSelection(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  markName: string,
  attrs: Record<string, unknown>,
  mode: "set" | "toggle" | "unset",
  options: { mathAttr?: boolean; mergeAttrs?: boolean } = {},
): boolean {
  const markType = state.schema.marks[markName];
  if (!markType) {
    return false;
  }

  const { empty, from, to, $from } = state.selection;
  const shouldRemove = mode === "unset" || (mode === "toggle" && selectionHasMark(state, markType));
  if (dispatch) {
    const tr = state.tr;
    if (empty) {
      const currentMark = markType.isInSet(state.storedMarks ?? $from.marks());
      if (shouldRemove) {
        tr.removeStoredMark(markType);
      } else {
        tr.addStoredMark(markType.create(resolveInlineMarkAttrs(currentMark?.attrs, attrs, false, options)));
      }
    } else {
      state.doc.nodesBetween(from, to, (node, pos, parent) => {
        if (!node.isInline || !inlineNodeAllowsMark(parent?.type.allowsMarkType(markType), node.type.allowsMarkType(markType))) {
          return;
        }

        const markFrom = Math.max(pos, from);
        const markTo = Math.min(pos + node.nodeSize, to);
        if (markFrom >= markTo) {
          return;
        }

        const currentMark = markType.isInSet(node.marks);
        const markAttrs = resolveInlineMarkAttrs(currentMark?.attrs, attrs, node.type.name === "mathInline", options);
        if (shouldRemove) {
          tr.removeMark(markFrom, markTo, markType);
        } else {
          tr.addMark(markFrom, markTo, markType.create(markAttrs));
        }
      });
    }
    dispatch(tr.scrollIntoView());
  }

  return empty || selectionContainsMarkableInlineNode(state, markType);
}

function resolveInlineMarkAttrs(
  currentAttrs: Readonly<Record<string, unknown>> | undefined,
  nextAttrs: Record<string, unknown>,
  math: boolean,
  options: { mathAttr?: boolean; mergeAttrs?: boolean },
): Record<string, unknown> {
  const merged: Record<string, unknown> = options.mergeAttrs ? { ...(currentAttrs ?? {}) } : {};
  for (const [key, value] of Object.entries(nextAttrs)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  if (options.mathAttr && math) {
    merged.math = true;
  }
  return merged;
}

function selectionHasMark(state: EditorState, markType: MarkType): boolean {
  const { empty, from, to, $from } = state.selection;
  if (empty) {
    return markType.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
  }

  let hasMark = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (hasMark) {
      return false;
    }

    if (node.isInline && markType.isInSet(node.marks)) {
      hasMark = true;
    }
    return undefined;
  });
  return hasMark;
}

function selectionContainsMarkableInlineNode(state: EditorState, markType: MarkType): boolean {
  const { empty, from, to, $from } = state.selection;
  if (empty) {
    return $from.parent.type.allowsMarkType(markType);
  }

  let hasMarkableNode = false;
  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (hasMarkableNode) {
      return false;
    }

    if (node.isInline && inlineNodeAllowsMark(parent?.type.allowsMarkType(markType), node.type.allowsMarkType(markType))) {
      hasMarkableNode = true;
    }
    return undefined;
  });
  return hasMarkableNode;
}

function inlineNodeAllowsMark(parentAllowsMark: boolean | undefined, nodeAllowsMark: boolean): boolean {
  return parentAllowsMark ?? nodeAllowsMark;
}

function normalizeFontSize(value: unknown): number | null {
  return parseCssFontSizeToPt(value) ?? null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeBoxedPaddingY(value: unknown): number | null {
  const paddingY = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(paddingY) && paddingY >= 0 ? Math.min(12, Math.round(paddingY * 10) / 10) : null;
}

function normalizeBoxedVariant(value: unknown): BoxedVariant | null {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade"
    ? value
    : null;
}

function normalizeBoxedTone(value: unknown): "gray" | "blue" | "green" | "red" | "yellow" | null {
  return value === "gray" || value === "blue" || value === "green" || value === "red" || value === "yellow"
    ? value
    : null;
}
