import { z } from "zod";

import {
  isValidOverlaySnapshot,
  prepareOverlaySnapshotForValidation,
  recoverOverlaySnapshot,
  isOverlayAsset,
  SIGMA_COMMENT_AGENT_VENDORS,
  type BoxBlockChildBlock,
  type BoxBlockNode,
  type InlineNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ListItemNode,
  type ListNode,
  type OverlaySnapshot,
  type QuoteBlockNode,
  type ProblemAreaBlock,
  type RichBlock,
  type SigmaBlock,
  type SigmaCommentAnchor,
  type SigmaDocument,
  normalizeBlockSpaceAfterPx,
  normalizeCodeBlockTheme,
  normalizeCodeLanguage,
  normalizeLineHeight,
  expandMarginsForRunningRegions,
  getPageLayoutIssues,
  isWhiteboardPageLayout,
  normalizePageLayout,
} from "@/features/document";
import { FONT_SIZE_UNIT_PT, pxToPt } from "@/lib/font-size-units";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

import { isAllowedOverlayAssetSource } from "@/features/document/asset-source";
import { validateMathTex } from "@/lib/math-tex";

const te = createCurrentLocaleTranslator("error");

const PaginationSchema = z
  .object({
    keepTogether: z.boolean().optional(),
    keepWithNext: z.boolean().optional(),
    break: z.boolean().optional(),
  })
  .optional();

/**
 * ブロック下余白。壊れた値 (負数 / 非数 / 文字列 / 上限超過) は **issue を上げずに落とす**。
 * 見た目の微調整 1 つのために教材が開けなくなる方が損害が大きく、落とせば「未指定」= 従来の
 * 見た目に戻るだけで済む (lineHeight と方針が違うのはそのため — あちらは値が本文の組版を
 * 決めるので、黙って既定へ戻ると読み手が気づけない)。
 */
const BlockSpaceAfterSchema = z
  .number()
  .transform((value) => normalizeBlockSpaceAfterPx(value))
  .catch(() => undefined)
  .optional();

const BaseNodeSchema = z.object({
  id: z.string().min(1),
  pagination: PaginationSchema,
  spaceAfterPx: BlockSpaceAfterSchema,
});

const TextAlignSchema = z.enum(["left", "center", "right", "justify"]).optional();
const LineHeightSchema = z.string().transform((value, context) => {
  const normalized = normalizeLineHeight(value);
  if (!normalized) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "lineHeight must be a unitless number between 0.8 and 3",
    });
    return z.NEVER;
  }
  return normalized;
}).optional();
const BoxedVariantSchema = z.enum(["frame", "thick", "double", "oval", "shade"]).optional();
const BoxedToneSchema = z.enum(["gray", "blue", "green", "red", "yellow"]).optional();

const TextInlineSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  mentionUserId: z.string().min(1).optional(),
  marks: z.array(z.enum(["bold", "italic", "underline", "boxed"])).optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  boxedPaddingY: z.number().min(0).optional(),
  boxedVariant: BoxedVariantSchema,
  boxedTone: BoxedToneSchema,
});

const MathInlineSchema = z.object({
  type: z.literal("mathInline"),
  id: z.string().min(1),
  tex: z.string(),
  display: z.literal("inline"),
  marks: z.array(z.enum(["underline", "boxed"])).optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  boxedPaddingY: z.number().min(0).optional(),
  boxedVariant: BoxedVariantSchema,
  boxedTone: BoxedToneSchema,
  semanticRole: z.enum(["expression", "equation", "variable"]).optional(),
  altText: z.string().optional(),
});

export const InlineNodeSchema: z.ZodType<InlineNode> = z.discriminatedUnion("type", [
  TextInlineSchema,
  MathInlineSchema,
]);

const CommentTextPositionSchema = z.object({
  blockId: z.string().min(1),
  offset: z.number().int().min(0),
});

const CommentAnchorSchema: z.ZodType<SigmaCommentAnchor> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("textRange"),
    start: CommentTextPositionSchema,
    end: CommentTextPositionSchema,
    quote: z.string(),
    mathInlineIds: z.array(z.string().min(1)).optional(),
    mathTex: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("inlineMath"),
    blockId: z.string().min(1),
    mathInlineId: z.string().min(1),
    quote: z.string().optional(),
    tex: z.string().optional(),
  }),
  z.object({
    type: z.literal("block"),
    blockId: z.string().min(1),
    quote: z.string().optional(),
  }),
  z.object({
    type: z.literal("canvasRegion"),
    bounds: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      w: z.number().finite().positive(),
      h: z.number().finite().positive(),
    }),
    quote: z.string().optional(),
  }),
  z.object({
    type: z.literal("overlayShape"),
    shapeIds: z.array(z.string().min(1)).min(1),
    quote: z.string().optional(),
  }),
  z.object({
    type: z.literal("overlayMath"),
    shapeId: z.string().min(1).optional(),
    mathInlineId: z.string().min(1).optional(),
    quote: z.string().optional(),
    tex: z.string().optional(),
  }),
]);

const CommentReactionSchema = z.object({
  id: z.string().min(1),
  emoji: z.string().min(1),
  authorName: z.string().optional(),
  createdAt: z.string(),
});

const CommentAgentSchema = z.object({
  vendor: z.enum(SIGMA_COMMENT_AGENT_VENDORS),
  model: z.string().min(1).optional(),
});

const CommentMessageSchema = z.object({
  id: z.string().min(1),
  authorName: z.string().optional(),
  agent: CommentAgentSchema.optional(),
  body: z.array(InlineNodeSchema),
  reactions: z.array(CommentReactionSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

const CommentThreadSchema = z.object({
  id: z.string().min(1),
  anchor: CommentAnchorSchema,
  messages: z.array(CommentMessageSchema).min(1),
  reactions: z.array(CommentReactionSchema).optional(),
  resolved: z.boolean().optional(),
  color: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

const SectionNodeSchema = BaseNodeSchema.extend({
  type: z.literal("section"),
  title: z.string(),
  align: TextAlignSchema,
  lineHeight: LineHeightSchema,
});

const HeadingNodeSchema = BaseNodeSchema.extend({
  type: z.literal("heading"),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  children: z.array(InlineNodeSchema),
  align: TextAlignSchema,
  lineHeight: LineHeightSchema,
});

const ParagraphNodeSchema = BaseNodeSchema.extend({
  type: z.literal("paragraph"),
  children: z.array(InlineNodeSchema),
  align: TextAlignSchema,
  lineHeight: LineHeightSchema,
});

const CodeBlockNodeSchema = BaseNodeSchema.extend({
  type: z.literal("codeBlock"),
  children: z.array(InlineNodeSchema),
  // 読めない言語は「自動判定」へ落とす。色が付かないだけで本文は残る。
  language: z.unknown().transform(normalizeCodeLanguage).optional(),
  // 未知の値は従来のライト背景へ戻し、本文そのものは開けるようにする。
  theme: z.unknown().transform(normalizeCodeBlockTheme).optional(),
});

const DividerNodeSchema = BaseNodeSchema.extend({
  type: z.literal("divider"),
});

const ListNodeSchema: z.ZodType<ListNode> = z.lazy(() => BaseNodeSchema.extend({
  type: z.literal("list"),
  listType: z.enum(["bullet", "ordered"]),
  start: z.number().int().positive().optional(),
  markerStyle: z.enum(["decimal", "paren"]).optional(),
  items: z.array(ListItemNodeSchema).min(1),
}));

const ListItemNodeSchema: z.ZodType<ListItemNode> = z.lazy(() => z.object({
  type: z.literal("listItem"),
  id: z.string().min(1),
  children: z.array(InlineNodeSchema),
  align: TextAlignSchema,
  spaceAfterPx: BlockSpaceAfterSchema,
  continuations: z.array(z.union([
    HeadingNodeSchema,
    ParagraphNodeSchema,
    DividerNodeSchema,
  ])).optional(),
  nested: z.array(ListNodeSchema).optional(),
}));

/**
 * 引用ブロック。中身は `QuoteChildBlock` だけ。空配列は受け付けない — 中身の無い入れ物は
 * 編集面のスキーマ (content 式が `+`) でも作れないので、保存側でも同じ形を強制する。
 */
const QuoteBlockNodeSchema: z.ZodType<QuoteBlockNode> = z.lazy(() => BaseNodeSchema.extend({
  type: z.literal("quote"),
  blocks: z.array(z.union([
    HeadingNodeSchema,
    ParagraphNodeSchema,
    ListNodeSchema as never,
    CodeBlockNodeSchema,
    DividerNodeSchema,
  ])).min(1),
}));

export const RichBlockSchema: z.ZodType<RichBlock> = z.union([
  HeadingNodeSchema,
  ParagraphNodeSchema,
  ListNodeSchema,
]);

const BoxSpacingPxSchema = z.object({
  top: z.number().nonnegative(),
  right: z.number().nonnegative(),
  bottom: z.number().nonnegative(),
  left: z.number().nonnegative(),
});

const BoxDecorationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cornerSquares"),
    sizePx: z.number().positive(),
    color: z.string(),
  }),
  z.object({
    type: z.literal("doubleRule"),
    offsetPx: z.number().nonnegative(),
    widthPx: z.number().positive().optional(),
    color: z.string().optional(),
  }),
  z.object({
    type: z.literal("titleDoubleRule"),
    ruleWidthPx: z.number().positive().optional(),
    ruleColor: z.string().optional(),
    guideColor: z.string().optional(),
  }),
  z.object({
    type: z.literal("titleBand"),
    heightPx: z.number().positive().optional(),
    backgroundColor: z.string().optional(),
    ruleWidthPx: z.number().nonnegative().optional(),
    ruleColor: z.string().optional(),
  }),
  z.object({
    type: z.literal("titleTab"),
    heightPx: z.number().positive().optional(),
    radiusPx: z.number().nonnegative().optional(),
    offsetXPx: z.number().optional(),
    paddingPx: BoxSpacingPxSchema.optional(),
    backgroundColor: z.string().optional(),
  }),
  z.object({
    type: z.literal("titlePlate"),
    borderColor: z.string().optional(),
    radiusPx: z.number().nonnegative().optional(),
    paddingPx: BoxSpacingPxSchema.optional(),
  }),
  z.object({
    type: z.literal("leftBar"),
    widthPx: z.number().positive(),
    color: z.string(),
  }),
  z.object({
    type: z.literal("shadow"),
    offsetXPx: z.number(),
    offsetYPx: z.number(),
    blurPx: z.number().nonnegative().optional(),
    spreadPx: z.number().optional(),
    color: z.string(),
  }),
  z.object({
    type: z.literal("horizontalRules"),
    widthPx: z.number().positive().optional(),
    color: z.string().optional(),
  }),
  z.object({
    type: z.literal("notebookRules"),
    baseBodyWidthPx: z.number().positive().optional(),
    frameLeftPx: z.number().nonnegative().optional(),
    frameHeightPx: z.number().positive().optional(),
    frameStrokeOpacity: z.number().min(0).max(1).optional(),
    lineColor: z.string().optional(),
    lineGapPx: z.number().positive().optional(),
    lineWidthPx: z.number().positive().optional(),
    lineOffsetPx: z.number().nonnegative().optional(),
    bindingColor: z.string().optional(),
    bindingWidthPx: z.number().positive().optional(),
    bindingXPx: z.number().nonnegative().optional(),
    bindingStrokeOpacity: z.number().min(0).max(1).optional(),
    ringColor: z.string().optional(),
    ringWidthPx: z.number().positive().optional(),
    ringHeightPx: z.number().positive().optional(),
    ringStrokePx: z.number().positive().optional(),
    ringGapPx: z.number().positive().optional(),
    ringTopPx: z.number().nonnegative().optional(),
    ringCount: z.number().int().positive().optional(),
    ringLeftOverhangPx: z.number().nonnegative().optional(),
    minHeightPx: z.number().positive().optional(),
  }),
]);

export const BoxFrameSchema = z.object({
  borderWidthPx: z.number().nonnegative().optional(),
  borderColor: z.string().optional(),
  borderStyle: z.enum(["solid", "dashed", "dotted", "double", "none"]).optional(),
  backgroundColor: z.string().optional(),
  titleBackgroundColor: z.string().optional(),
  titleColor: z.string().optional(),
  titleAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  titlePosition: z.enum(["l", "c", "r"]).optional(),
  titleFontWeight: z.enum(["normal", "bold"]).optional(),
  titleFontFamily: z.string().optional(),
  titleFontSizePx: z.number().positive().optional(),
  titleLineHeight: z.string().optional(),
  bodyColor: z.string().optional(),
  bodyAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  bodyFontFamily: z.string().optional(),
  bodyFontSizePx: z.number().positive().optional(),
  bodyLineHeight: z.string().optional(),
  cornerStyle: z.enum(["sharp", "round"]).optional(),
  radiusPx: z.number().nonnegative().optional(),
  paddingPx: BoxSpacingPxSchema.optional(),
  decorations: z.array(BoxDecorationSchema).optional(),
}).optional();

const BoxBlockChildBlockSchema: z.ZodType<BoxBlockChildBlock> = z.lazy(() => z.union([
  SectionNodeSchema,
  HeadingNodeSchema,
  ParagraphNodeSchema,
  ListNodeSchema,
  QuoteBlockNodeSchema,
  CodeBlockNodeSchema,
  DividerNodeSchema,
  BoxBlockNodeSchema,
  LayoutSectionNodeSchema,
  ProblemNodeSchema,
]));

const BoxBlockNodeSchema: z.ZodType<BoxBlockNode> = z.lazy(() => BaseNodeSchema.extend({
  type: z.literal("boxBlock"),
  styleId: z.string().min(1),
  title: z.array(InlineNodeSchema).optional(),
  blocks: z.array(BoxBlockChildBlockSchema).min(1),
  frame: BoxFrameSchema,
}));

const LayoutSectionChildBlockSchema: z.ZodType<LayoutSectionChildBlock> = z.lazy(() => z.union([
  SectionNodeSchema,
  HeadingNodeSchema,
  ParagraphNodeSchema,
  ListNodeSchema,
  QuoteBlockNodeSchema,
  CodeBlockNodeSchema,
  DividerNodeSchema,
  BoxBlockNodeSchema,
]));

const ProblemAreaLayoutSchema = z.object({
  minHeightMm: z.number().nonnegative().optional(),
  columnSpan: z.enum(["column", "full"]).optional(),
});

const ProblemAreaBlockSchema: z.ZodType<ProblemAreaBlock> = z.lazy(() => z.union([
  RichBlockSchema,
  QuoteBlockNodeSchema,
  CodeBlockNodeSchema,
  DividerNodeSchema,
  LayoutSectionNodeSchema,
  BoxBlockNodeSchema,
]));

const ProblemNodeSchema = BaseNodeSchema.extend({
  type: z.literal("problem"),
  tags: z.array(z.string()),
  lead: z.array(ProblemAreaBlockSchema).optional().default([]),
  prompt: z.array(ProblemAreaBlockSchema),
  answer: z
    .object({
      type: z.enum(["math", "text"]),
      expected: z.string(),
    })
    .optional(),
  solution: z.array(ProblemAreaBlockSchema),
  hints: z.array(ProblemAreaBlockSchema),
  areaLayout: z
    .object({
      lead: ProblemAreaLayoutSchema.optional(),
      prompt: ProblemAreaLayoutSchema.optional(),
      solution: ProblemAreaLayoutSchema.optional(),
      hints: ProblemAreaLayoutSchema.optional(),
    })
    .optional(),
  numbering: z
    .object({
      enabled: z.boolean().optional(),
      fontSize: z.number().positive().optional(),
      value: z.number().int().positive().optional(),
    })
    .optional(),
  frame: z
    .object({
      enabled: z.boolean().optional(),
      styleId: z.string().min(1).optional(),
    })
    .optional(),
});

const ColumnRuleSchema = z.object({
  style: z.enum(["none", "solid", "dashed", "dotted", "double"]),
  widthPx: z.number().min(0.5).max(8),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});

const LayoutSectionNodeSchema: z.ZodType<LayoutSectionNode> = z.lazy(() => BaseNodeSchema.extend({
  type: z.literal("layoutSection"),
  layout: z.object({
    columnCount: z.number().int().min(1).max(4),
    columnGapMm: z.number().nonnegative().optional(),
    columnRule: ColumnRuleSchema.optional(),
    columnStartIds: z.array(z.string().min(1)).min(1).max(4).optional(),
    columnWidths: z.array(z.number().positive()).min(1).max(4).optional(),
  }),
  children: z.array(LayoutSectionChildBlockSchema).min(1),
}));

/**
 * 本文ブロックの種別。`SigmaBlockSchema` の唯一の出典で、テストが「旧 `z.union` と
 * 新 `z.discriminatedUnion` の受理集合が同一」を確かめるためにここから両方を組む。
 */
export const SIGMA_BLOCK_SCHEMA_MEMBERS = [
  SectionNodeSchema,
  HeadingNodeSchema,
  ParagraphNodeSchema,
  CodeBlockNodeSchema,
  DividerNodeSchema,
  // 再帰のため `z.lazy` + `z.ZodType<T>` 注釈で定義されている 3 種だけ、型の上で
  // discriminator を失う (実行時は zod v4 が lazy を解決して読める)。
  // **この 3 つだけ**を通し、残り 4 つは型検査を効かせたままにする — 配列ごと通すと、
  // 将来 `type` リテラルを失ったメンバーが混ざっても気付けない (そして zod は
  // `safeParse` の中から素の Error を投げるので、壊れた教材の失敗画面にすら乗らない)。
  ListNodeSchema as never,
  QuoteBlockNodeSchema as never,
  ProblemNodeSchema,
  LayoutSectionNodeSchema as never,
  BoxBlockNodeSchema as never,
] as const;

/**
 * `type` で分岐する。`z.union` は候補を順に試すので、末尾の種別ほど「手前の 6 つを
 * 全部失敗させてから」通っていた (1,500 ブロックの教材ではこれが開く時間に出る)。
 * `InlineNodeSchema` は元から discriminatedUnion で、同じ規約に揃えた形。
 *
 * 受理集合は変わらない — `lib/sigma-doc-schema.union-parity.test.ts` が
 * 旧 union と本スキーマの `success` をリポジトリ内の全 fixture で突き合わせている。
 * zod v4 は `z.lazy` のメンバーも discriminator を解決できる (実測で確認済み)。
 */
export const SigmaBlockSchema: z.ZodType<SigmaBlock> = z.discriminatedUnion(
  "type",
  SIGMA_BLOCK_SCHEMA_MEMBERS,
);

const OverlaySnapshotSchema: z.ZodType<OverlaySnapshot> = z.preprocess(
  prepareOverlaySnapshotForValidation,
  z.custom<OverlaySnapshot>(isValidOverlaySnapshot),
);

const PageOverlaySchema = z.object({
  overlaySnapshot: OverlaySnapshotSchema.optional(),
  updatedAt: z.string().optional(),
});

const PageFlowSchema = z.object({
  type: z.literal("columns").optional(),
  columnCount: z.number().int().min(1).max(4).optional(),
  columnGapMm: z.number().nonnegative().optional(),
    columnRule: ColumnRuleSchema.optional(),
});

const PageRunningRegionSchema = z.object({
  enabled: z.boolean().optional(),
  heightMm: z.number().positive().optional(),
  offsetMm: z.number().nonnegative().optional(),
  showOnFirstPage: z.boolean().optional(),
  blocks: z.array(RichBlockSchema).optional(),
  overlay: PageOverlaySchema.optional(),
});

const PageLayoutSchema = z
  .object({
    preset: z.enum(["A4", "A3", "B5", "B4", "custom", "whiteboard"]).optional(),
    orientation: z.enum(["portrait", "landscape"]).optional(),
    pageSize: z
      .object({
        widthMm: z.number().positive().optional(),
        heightMm: z.number().positive().optional(),
      })
      .optional(),
    marginsMm: z
      .object({
        top: z.number().nonnegative().optional(),
        right: z.number().nonnegative().optional(),
        bottom: z.number().nonnegative().optional(),
        left: z.number().nonnegative().optional(),
      })
      .optional(),
    flow: PageFlowSchema.optional(),
    header: PageRunningRegionSchema.optional(),
    footer: PageRunningRegionSchema.optional(),
    overlay: PageOverlaySchema.optional(),
    // zod の既定は unknown key を strip する。ここに足さないと保存 → 読み直しで背景が消える。
    background: z.enum(["grid", "dots", "none"]).optional(),
  })
  .transform((layout) => expandMarginsForRunningRegions(normalizePageLayout(layout)))
  .superRefine((layout, context) => {
    for (const issue of getPageLayoutIssues(layout)) {
      context.addIssue({
        code: "custom",
        message: issue,
      });
    }
  });

const SigmaDocumentInputSchema = z.object({
  version: z.literal("2.0"),
  docId: z.string().min(1),
  metadata: z.object({
    title: z.string(),
    source: z.object({
      format: z.string().optional(),
      layoutMode: z.literal("fixedOverlay").optional(),
      printFlowContent: z.boolean().optional(),
      originalFileName: z.string().optional(),
      importedAt: z.string().optional(),
      slideCount: z.number().int().nonnegative().optional(),
      pageSize: z.object({
        widthPx: z.number().nonnegative().optional(),
        heightPx: z.number().nonnegative().optional(),
        widthMm: z.number().nonnegative().optional(),
        heightMm: z.number().nonnegative().optional(),
      }).optional(),
    }).optional(),
    styleUnits: z.object({
      fontSize: z.literal("pt").optional(),
    }).optional(),
    mathFractionSizing: z.enum(["uniform", "texDefault"]).optional(),
    headingNumbering: z.object({
      enabled: z.boolean(),
      style: z.enum(["decimal", "sectionSign", "chapterJa"]).optional(),
      depth: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    }).optional(),
    texPreamble: z.string().max(20_000).optional(),
  }),
  content: z.array(SigmaBlockSchema),
  outputProfiles: z.object({
    student: z.object({
      showSolutions: z.boolean().optional(),
      showHints: z.boolean().optional(),
      includeAnswers: z.boolean().optional(),
      onlySolutions: z.boolean().optional(),
      includeComments: z.boolean().optional(),
    }),
    teacher: z.object({
      showSolutions: z.boolean().optional(),
      showHints: z.boolean().optional(),
      includeAnswers: z.boolean().optional(),
      onlySolutions: z.boolean().optional(),
      includeComments: z.boolean().optional(),
    }),
    answerBook: z.object({
      showSolutions: z.boolean().optional(),
      showHints: z.boolean().optional(),
      includeAnswers: z.boolean().optional(),
      onlySolutions: z.boolean().optional(),
      includeComments: z.boolean().optional(),
    }),
  }),
  comments: z.array(CommentThreadSchema).optional(),
  pageLayout: PageLayoutSchema.optional(),
  updatedAt: z.string().optional(),
}).superRefine((document, context) => {
  if (isWhiteboardPageLayout(document.pageLayout) && document.content.length > 0) {
    context.addIssue({
      code: "custom",
      message: te("schemaRecovery.whiteboardContent"),
      path: ["content"],
    });
  }
  if (isWhiteboardPageLayout(document.pageLayout)) {
    const invalidAnchorIndex = document.pageLayout?.overlay?.overlaySnapshot?.shapes.findIndex(
      (shape) => shape.anchor !== undefined && shape.anchor.type !== "shape",
    ) ?? -1;
    if (invalidAnchorIndex >= 0) {
      context.addIssue({
        code: "custom",
        message: te("schemaRecovery.whiteboardAnchor"),
        path: ["pageLayout", "overlay", "overlaySnapshot", "shapes", invalidAnchorIndex, "anchor"],
      });
    }
  }
});

export const SigmaDocumentSchema: z.ZodType<SigmaDocument> = SigmaDocumentInputSchema.transform((document) => ({
  ...document,
  version: "2.0",
  metadata: {
    ...document.metadata,
    styleUnits: {
      ...document.metadata.styleUnits,
      fontSize: FONT_SIZE_UNIT_PT,
    },
  },
  pageLayout: normalizePageLayout(document.pageLayout),
}));

// 短期間存在した chapter モデル (PR #160 で content へ revert) で保存された教材を救出する。
// `chapters` だけを持ち `content` が無い旧教材を、章の content を連結して content 形式へ正規化する。
// これが無いと旧教材は parse に失敗し「読み込めませんでした」になる。
function normalizeLegacyChapters(input: unknown): unknown {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray((input as { content?: unknown }).content) ||
    !Array.isArray((input as { chapters?: unknown }).chapters)
  ) {
    return input;
  }
  const { chapters, ...rest } = input as { chapters: unknown[] };
  const content = chapters.flatMap((chapter) =>
    chapter && typeof chapter === "object" && Array.isArray((chapter as { content?: unknown }).content)
      ? (chapter as { content: unknown[] }).content
      : [],
  );
  return { ...rest, content };
}

export function parseSigmaDocument(input: unknown): SigmaDocument {
  return SigmaDocumentSchema.parse(normalizeFontSizeUnits(normalizeLegacyChapters(input)));
}

// Re-exported so read-only consumers (the viewer package) can drop
// independently-broken overlay shapes/assets the same way Sigma Studio's own
// file-open path already does, instead of rejecting an otherwise-valid document.
export { recoverOverlaySnapshot };

export type SigmaDocumentRecoveryIssueKind =
  | "overlayShape"
  | "overlayAsset"
  | "overlaySnapshot"
  | "block"
  | "inlineNode"
  | "comment"
  | "commentMessage"
  | "commentReaction";

export interface SigmaDocumentRecoveryIssue {
  kind: SigmaDocumentRecoveryIssueKind;
  path: Array<string | number>;
  id?: string;
  type?: string;
  message: string;
}

/**
 * 「要素を捨てても救えなかった」ときに、どこがスキーマに合わなかったのかを
 * 人間とAIの両方が読める形にした1件分の記録。UI の失敗画面と、そこから
 * コピーする修復プロンプトの素材になる。
 */
export interface SigmaDocumentSchemaFailure {
  /** 例: "pageLayout.preset" / "content[3].children[0].type"。ルート自体なら "(root)"。 */
  path: string;
  message: string;
  code?: string;
  /** 期待値の要約 (enum候補・literal・型名など)。 */
  expected?: string;
  /** 実際に入っていた値のJSONプレビュー (長い値は切り詰める)。 */
  received?: string;
}

export type SigmaDocumentRecoveryResult =
  | { ok: true; document: SigmaDocument; issues: SigmaDocumentRecoveryIssue[] }
  | { ok: false; error: string; failures: SigmaDocumentSchemaFailure[] };

const MAX_SCHEMA_FAILURES = 12;
const MAX_RECEIVED_PREVIEW_LENGTH = 240;

/** zod のバージョン差に依存しないよう、必要なフィールドだけを構造的に受け取る。 */
type SchemaIssueLike = {
  code?: string;
  message: string;
  path?: ReadonlyArray<string | number | symbol>;
  expected?: string;
  values?: readonly unknown[];
  keys?: readonly string[];
  /** z.union が失敗したとき、各候補の内訳 (zod v4)。 */
  errors?: ReadonlyArray<readonly SchemaIssueLike[]>;
};

function formatSchemaFailurePath(path: ReadonlyArray<string | number | symbol>): string {
  if (path.length === 0) {
    return "(root)";
  }
  return path.reduce<string>((text, segment) => {
    if (typeof segment === "number") {
      return `${text}[${segment}]`;
    }
    const key = String(segment);
    return text === "" ? key : `${text}.${key}`;
  }, "");
}

function readValueAtPath(root: unknown, path: ReadonlyArray<string | number | symbol>): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "symbol") {
      return undefined;
    }
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
      continue;
    }
    if (isRecord(current)) {
      current = current[String(segment)];
      continue;
    }
    return undefined;
  }
  return current;
}

function previewSchemaValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return undefined;
  }
  return text.length > MAX_RECEIVED_PREVIEW_LENGTH
    ? `${text.slice(0, MAX_RECEIVED_PREVIEW_LENGTH)}…`
    : text;
}

function describeSchemaExpectation(issue: SchemaIssueLike): string | undefined {
  if (issue.values && issue.values.length > 0) {
    return issue.values.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (issue.keys && issue.keys.length > 0) {
    return te("schemaRecovery.disallowedKeys", { keys: issue.keys.join(", ") });
  }
  return issue.expected;
}

/**
 * ZodError を失敗記録の一覧へ変換する。union の内訳 (errors) は候補ごとに
 * 潜って展開し、同じ path/message は 1 件に畳む。
 */
export function describeSigmaDocumentSchemaFailures(
  issues: ReadonlyArray<unknown>,
  candidate: unknown,
): SigmaDocumentSchemaFailure[] {
  const failures: SigmaDocumentSchemaFailure[] = [];
  const seen = new Set<string>();

  const visit = (
    list: ReadonlyArray<SchemaIssueLike>,
    prefix: ReadonlyArray<string | number | symbol>,
  ) => {
    for (const issue of list) {
      if (!issue || typeof issue.message !== "string") {
        continue;
      }
      const path = [...prefix, ...(issue.path ?? [])];
      if (Array.isArray(issue.errors) && issue.errors.length > 0) {
        for (const nested of issue.errors) {
          if (Array.isArray(nested)) {
            visit(nested, path);
          }
        }
        continue;
      }
      const formattedPath = formatSchemaFailurePath(path);
      const key = `${formattedPath}\u0000${issue.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      failures.push({
        path: formattedPath,
        message: issue.message,
        code: typeof issue.code === "string" ? issue.code : undefined,
        expected: describeSchemaExpectation(issue),
        received: previewSchemaValue(readValueAtPath(candidate, path)),
      });
    }
  };

  visit(issues as ReadonlyArray<SchemaIssueLike>, []);
  return failures.slice(0, MAX_SCHEMA_FAILURES);
}

/**
 * ファイル読み込み専用の寛容な入口。独立して検証できる要素だけを除外し、
 * 最後は必ず通常の SigmaDocumentSchema を通して正規データへ戻す。
 */
export function recoverSigmaDocument(input: unknown): SigmaDocumentRecoveryResult {
  const normalized = normalizeFontSizeUnits(normalizeLegacyChapters(input));

  // 健全な文書はここで終わる。
  //
  // 以前は必ず `recoverDocumentCandidate` を通していたので、壊れていない教材でも
  // **ブロック 1 つずつ** safeParse してから全体をもう一度 safeParse していた
  // (1,500 ブロックの教材で 1,501 回 / 34.4ms。全体 1 回だけなら 10.8ms)。
  //
  // 速い道に乗せてよいのは「落とされるものが何も無い」文書だけ。
  //
  // 受理集合そのものは広がりも狭まりもしない (通る文書は復旧経路でも同じ結果になり、
  // 通らない文書は下の従来経路へそのまま落ちる) が、**issues は黙って空になり得る**:
  // `prepareOverlaySnapshotForValidation` は許可外の `src` を持つ素材を検証の前段で
  // 黙って捨てるので、全体スキーマは成功してしまう。そのまま速い道で返すと
  //  - 「素材を除外した」警告がユーザーに出ない (`formatDocumentRecoveryStatus`)
  //  - 元のバイト列の復旧バックアップ (.bak) が作られない (`issues.length > 0` が条件)
  // となり、`file://` / `https://` を仕込まれた教材を開いた痕跡が残らない。
  // 落ちる素材がある文書は速い道に乗せず、従来どおり復旧経路に報告させる。
  const fastPath = SigmaDocumentSchema.safeParse(normalized);
  if (fastPath.success && !hasDroppableOverlayAsset(normalized)) {
    return { ok: true, document: fastPath.data, issues: [] };
  }

  const issues: SigmaDocumentRecoveryIssue[] = [];
  const candidate = recoverDocumentCandidate(normalized, issues);
  const parsed = SigmaDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const failures = describeSigmaDocumentSchemaFailures(parsed.error.issues, candidate);
    const firstFailure = failures[0];
    const location = firstFailure && firstFailure.path !== "(root)" ? ` (${firstFailure.path})` : "";
    return {
      ok: false,
      error: te("schemaRecovery.requiredStructure", {
        location,
        detail: firstFailure?.message ?? te("schemaRecovery.invalidFormat"),
      }),
      failures,
    };
  }
  return { ok: true, document: parsed.data, issues };
}

function recoverDocumentCandidate(
  value: unknown,
  issues: SigmaDocumentRecoveryIssue[],
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const next: Record<string, unknown> = { ...value };
  if (Array.isArray(value.content)) {
    next.content = recoverBlockArray(value.content, ["content"], SigmaBlockSchema, issues);
  }
  if (Array.isArray(value.comments)) {
    next.comments = recoverCommentArray(value.comments, ["comments"], issues);
  } else if (value.comments !== undefined) {
    delete next.comments;
    issues.push(createRecoveryIssue("comment", ["comments"], value.comments, te("schemaRecovery.dropped.commentList")));
  }
  if (isRecord(value.pageLayout)) {
    next.pageLayout = recoverPageLayout(value.pageLayout, ["pageLayout"], issues);
  }
  return next;
}

function recoverBlockArray(
  values: unknown[],
  path: Array<string | number>,
  schema: z.ZodTypeAny,
  issues: SigmaDocumentRecoveryIssue[],
): unknown[] {
  return values.flatMap((value, index) => {
    const itemPath = [...path, index];
    const candidate = recoverBlockCandidate(value, itemPath, issues);
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      return [parsed.data];
    }
    issues.push(createRecoveryIssue("block", itemPath, value, te("schemaRecovery.dropped.block")));
    return [];
  });
}

function recoverBlockCandidate(
  value: unknown,
  path: Array<string | number>,
  issues: SigmaDocumentRecoveryIssue[],
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const next: Record<string, unknown> = { ...value };
  if ((value.type === "heading" || value.type === "paragraph") && Array.isArray(value.children)) {
    next.children = recoverInlineArray(value.children, [...path, "children"], issues);
  }
  if (value.type === "list" && Array.isArray(value.items)) {
    next.items = value.items.flatMap((item, index) => {
      const itemPath = [...path, "items", index];
      if (!isRecord(item)) {
        issues.push(createRecoveryIssue("block", itemPath, item, te("schemaRecovery.dropped.listItem")));
        return [];
      }
      const nextItem: Record<string, unknown> = { ...item };
      if (Array.isArray(item.children)) {
        nextItem.children = recoverInlineArray(item.children, [...itemPath, "children"], issues);
      }
      if (Array.isArray(item.nested)) {
        nextItem.nested = recoverBlockArray(item.nested, [...itemPath, "nested"], ListNodeSchema, issues);
      }
      const parsed = ListItemNodeSchema.safeParse(nextItem);
      if (parsed.success) {
        return [parsed.data];
      }
      issues.push(createRecoveryIssue("block", itemPath, item, te("schemaRecovery.dropped.listItem")));
      return [];
    });
  }
  if (value.type === "boxBlock") {
    if (Array.isArray(value.title)) {
      next.title = recoverInlineArray(value.title, [...path, "title"], issues);
    }
    if (Array.isArray(value.blocks)) {
      next.blocks = recoverBlockArray(value.blocks, [...path, "blocks"], BoxBlockChildBlockSchema, issues);
    }
  }
  if (value.type === "layoutSection" && Array.isArray(value.children)) {
    next.children = recoverBlockArray(value.children, [...path, "children"], LayoutSectionChildBlockSchema, issues);
  }
  if (value.type === "problem") {
    for (const key of ["lead", "prompt", "solution", "hints"] as const) {
      if (Array.isArray(value[key])) {
        next[key] = recoverBlockArray(value[key], [...path, key], ProblemAreaBlockSchema, issues);
      }
    }
  }
  return next;
}

function recoverInlineArray(
  values: unknown[],
  path: Array<string | number>,
  issues: SigmaDocumentRecoveryIssue[],
): unknown[] {
  return values.flatMap((value, index) => {
    const parsed = InlineNodeSchema.safeParse(value);
    if (parsed.success) {
      return [parsed.data];
    }
    issues.push(createRecoveryIssue("inlineNode", [...path, index], value, te("schemaRecovery.dropped.inlineNode")));
    return [];
  });
}

function recoverCommentArray(
  values: unknown[],
  path: Array<string | number>,
  issues: SigmaDocumentRecoveryIssue[],
): unknown[] {
  return values.flatMap((value, index) => {
    const threadPath = [...path, index];
    if (!isRecord(value)) {
      issues.push(createRecoveryIssue("comment", threadPath, value, te("schemaRecovery.dropped.comment")));
      return [];
    }
    const next: Record<string, unknown> = { ...value };
    if (Array.isArray(value.messages)) {
      next.messages = value.messages.flatMap((message, messageIndex) => {
        const messagePath = [...threadPath, "messages", messageIndex];
        if (!isRecord(message)) {
          issues.push(createRecoveryIssue("commentMessage", messagePath, message, te("schemaRecovery.dropped.commentBody")));
          return [];
        }
        const nextMessage: Record<string, unknown> = { ...message };
        if (Array.isArray(message.body)) {
          nextMessage.body = recoverInlineArray(message.body, [...messagePath, "body"], issues);
        }
        if (Array.isArray(message.reactions)) {
          nextMessage.reactions = recoverSchemaArray(
            message.reactions,
            [...messagePath, "reactions"],
            CommentReactionSchema,
            "commentReaction",
            te("schemaRecovery.dropped.commentReaction"),
            issues,
          );
        }
        const parsed = CommentMessageSchema.safeParse(nextMessage);
        if (parsed.success) {
          return [parsed.data];
        }
        issues.push(createRecoveryIssue("commentMessage", messagePath, message, te("schemaRecovery.dropped.commentBody")));
        return [];
      });
    }
    if (Array.isArray(value.reactions)) {
      next.reactions = recoverSchemaArray(
        value.reactions,
        [...threadPath, "reactions"],
        CommentReactionSchema,
        "commentReaction",
        te("schemaRecovery.dropped.commentReaction"),
        issues,
      );
    }
    const parsed = CommentThreadSchema.safeParse(next);
    if (parsed.success) {
      return [parsed.data];
    }
    issues.push(createRecoveryIssue("comment", threadPath, value, te("schemaRecovery.dropped.comment")));
    return [];
  });
}

function recoverSchemaArray(
  values: unknown[],
  path: Array<string | number>,
  schema: z.ZodTypeAny,
  kind: SigmaDocumentRecoveryIssueKind,
  message: string,
  issues: SigmaDocumentRecoveryIssue[],
): unknown[] {
  return values.flatMap((value, index) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      return [parsed.data];
    }
    issues.push(createRecoveryIssue(kind, [...path, index], value, message));
    return [];
  });
}

function recoverPageLayout(
  layout: Record<string, unknown>,
  path: Array<string | number>,
  issues: SigmaDocumentRecoveryIssue[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...layout };
  if (isRecord(layout.overlay)) {
    next.overlay = recoverPageOverlay(layout.overlay, [...path, "overlay"], issues);
  }
  for (const key of ["header", "footer"] as const) {
    if (!isRecord(layout[key])) {
      continue;
    }
    const region: Record<string, unknown> = { ...layout[key] };
    if (Array.isArray(layout[key].blocks)) {
      region.blocks = recoverBlockArray(layout[key].blocks, [...path, key, "blocks"], RichBlockSchema, issues);
    }
    if (isRecord(layout[key].overlay)) {
      region.overlay = recoverPageOverlay(layout[key].overlay, [...path, key, "overlay"], issues);
    }
    next[key] = region;
  }
  return next;
}

function recoverPageOverlay(
  overlay: Record<string, unknown>,
  path: Array<string | number>,
  issues: SigmaDocumentRecoveryIssue[],
): Record<string, unknown> {
  if (overlay.overlaySnapshot === undefined) {
    return { ...overlay };
  }
  const recovered = recoverOverlaySnapshot(overlay.overlaySnapshot);
  for (const issue of recovered.issues) {
    const issuePath = issue.kind === "shape"
      ? [...path, "overlaySnapshot", "shapes", issue.index ?? 0]
      : issue.kind === "asset"
        ? [...path, "overlaySnapshot", "assets", issue.key ?? "unknown"]
        : [...path, "overlaySnapshot"];
    issues.push({
      kind: issue.kind === "shape" ? "overlayShape" : issue.kind === "asset" ? "overlayAsset" : "overlaySnapshot",
      path: issuePath,
      id: issue.id,
      type: issue.type,
      message: issue.kind === "shape"
        ? te("schemaRecovery.dropped.overlayShape")
        : issue.kind === "asset"
          ? te("schemaRecovery.dropped.overlayAsset")
          : te("schemaRecovery.dropped.overlayLayer"),
    });
  }
  return { ...overlay, overlaySnapshot: recovered.snapshot };
}

function createRecoveryIssue(
  kind: SigmaDocumentRecoveryIssueKind,
  path: Array<string | number>,
  value: unknown,
  message: string,
): SigmaDocumentRecoveryIssue {
  return {
    kind,
    path,
    id: isRecord(value) && typeof value.id === "string" ? value.id : undefined,
    type: isRecord(value) && typeof value.type === "string" ? value.type : undefined,
    message,
  };
}

function normalizeFontSizeUnits(input: unknown): unknown {
  if (!isRecord(input) || input.version !== "2.0") {
    return input;
  }
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const styleUnits = isRecord(metadata.styleUnits) ? metadata.styleUnits : {};
  if (styleUnits.fontSize === FONT_SIZE_UNIT_PT) {
    return input;
  }

  const migrated = convertLegacyFontSizePxToPt(input);
  if (!isRecord(migrated)) {
    return migrated;
  }
  const migratedMetadata = isRecord(migrated.metadata) ? migrated.metadata : {};
  const migratedStyleUnits = isRecord(migratedMetadata.styleUnits) ? migratedMetadata.styleUnits : {};
  return {
    ...migrated,
    metadata: {
      ...migratedMetadata,
      styleUnits: {
        ...migratedStyleUnits,
        fontSize: FONT_SIZE_UNIT_PT,
      },
    },
  };
}

function convertLegacyFontSizePxToPt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(convertLegacyFontSizePxToPt);
  }
  if (!isRecord(value)) {
    return value;
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "fontSize" && typeof child === "number" && Number.isFinite(child) && child > 0) {
      next[key] = pxToPt(child);
    } else {
      next[key] = convertLegacyFontSizePxToPt(child);
    }
  }
  return next;
}

/**
 * 「構造としては素材だが `src` が許可外」= 前処理で黙って捨てられる素材があるか。
 *
 * 形が壊れている素材は前処理が早期 return するので全体スキーマ側が落ち、復旧経路へ回る。
 * 分岐が要るのは `src` だけが許可外のときで、これは `asset-source.ts` が防いでいる
 * ローカルファイル読み出し・外部ビーコンそのものなので、黙って消してはいけない。
 *
 * 走査するのは `pageLayout` の 3 箇所だけ (本文は見ない) なので、速い道の意味は保たれる。
 */
function hasDroppableOverlayAsset(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.pageLayout)) {
    return false;
  }
  const layout = value.pageLayout;
  const overlays: unknown[] = [layout.overlay];
  for (const key of ["header", "footer"] as const) {
    if (isRecord(layout[key])) {
      overlays.push(layout[key].overlay);
    }
  }
  return overlays.some((overlay) => {
    if (!isRecord(overlay) || !isRecord(overlay.overlaySnapshot)) {
      return false;
    }
    const assets = overlay.overlaySnapshot.assets;
    if (!isRecord(assets)) {
      return false;
    }
    return Object.values(assets).some((asset) => (
      isOverlayAsset(asset) && !isAllowedOverlayAssetSource(asset.props.src)
    ));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getDocumentIssues(document: SigmaDocument): string[] {
  const issues: string[] = [];
  if (isWhiteboardPageLayout(document.pageLayout) && document.content.length > 0) {
    issues.push(te("schemaRecovery.whiteboardContent"));
  }
  if (isWhiteboardPageLayout(document.pageLayout) && document.pageLayout?.overlay?.overlaySnapshot?.shapes.some(
    (shape) => shape.anchor !== undefined && shape.anchor.type !== "shape",
  )) {
    issues.push(te("schemaRecovery.whiteboardAnchor"));
  }
  const ids = new Set<string>();
  const blockIds = new Set<string>();
  const inlineMathIdsByBlockId = new Map<string, Set<string>>();
  const overlayShapeIds = new Set(
    document.pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => shape.id) ?? [],
  );

  const visitProblemAreaBlock = (block: ProblemAreaBlock) => {
    if (block.type === "list") {
      visitList(block);
      return;
    }

    collectId(block.id, block.type);
    blockIds.add(block.id);

    if (block.type === "layoutSection") {
      block.children.forEach(visitLayoutSectionChild);
      return;
    }

    if (block.type === "boxBlock") {
      visitBoxBlock(block);
      return;
    }

    if (block.type === "quote") {
      block.blocks.forEach(visitLayoutSectionChild);
      return;
    }

    if (block.type === "heading" || block.type === "paragraph" || block.type === "codeBlock") {
      visitInline(block.children, block.id);
    }
  };

  const visitRichBlock = (block: RichBlock) => visitProblemAreaBlock(block);

  const visitBoxBlock = (block: BoxBlockNode) => {
    if (block.title) {
      visitInline(block.title, block.id);
    }
    block.blocks.forEach(visitBoxBlockChild);
  };

  const visitLayoutSectionChild = (block: LayoutSectionChildBlock) => {
    if (block.type === "section") {
      collectId(block.id, block.type);
      blockIds.add(block.id);
      return;
    }
    if (block.type === "boxBlock") {
      visitTextFlowBlock(block);
      return;
    }
    if (block.type === "divider") {
      collectId(block.id, block.type);
      blockIds.add(block.id);
      return;
    }
    if (block.type === "quote" || block.type === "codeBlock") {
      visitProblemAreaBlock(block);
      return;
    }
    visitRichBlock(block);
  };

  const visitBoxBlockChild = (block: BoxBlockChildBlock) => {
    if (block.type === "problem") {
      collectId(block.id, block.type);
      blockIds.add(block.id);
      block.lead.forEach(visitProblemAreaBlock);
      block.prompt.forEach(visitProblemAreaBlock);
      block.hints.forEach(visitProblemAreaBlock);
      block.solution.forEach(visitProblemAreaBlock);
      return;
    }
    if (block.type === "layoutSection") {
      collectId(block.id, block.type);
      blockIds.add(block.id);
      block.children.forEach(visitLayoutSectionChild);
      return;
    }
    visitLayoutSectionChild(block);
  };

  const visitTextFlowBlock = (block: Exclude<SigmaDocument["content"][number], { type: "problem" | "layoutSection" }>) => {
    collectId(block.id, block.type);
    blockIds.add(block.id);

    if (block.type === "heading" || block.type === "paragraph") {
      visitInline(block.children, block.id);
    }

    if (block.type === "list") {
      for (const item of block.items) {
        visitListItem(item);
      }
    }

    if (block.type === "boxBlock") {
      visitBoxBlock(block);
    }
  };

  const visitList = (list: ListNode) => {
    collectId(list.id, list.type);
    blockIds.add(list.id);
    for (const item of list.items) {
      visitListItem(item);
    }
  };

  const visitListItem = (item: ListItemNode) => {
    collectId(item.id, item.type);
    blockIds.add(item.id);
    visitInline(item.children, item.id);
    for (const nested of item.nested ?? []) {
      visitList(nested);
    }
  };

  const visitInline = (children: InlineNode[], blockId?: string) => {
    for (const child of children) {
      if ("id" in child) {
        collectId(child.id, child.type);
      }

      if (child.type === "mathInline") {
        if (blockId) {
          const idsForBlock = inlineMathIdsByBlockId.get(blockId) ?? new Set<string>();
          idsForBlock.add(child.id);
          inlineMathIdsByBlockId.set(blockId, idsForBlock);
        }
        issues.push(...getTexIssues(child.tex, child.id));
      }
    }
  };

  const visitCommentBody = (threadId: string, messageId: string, body: InlineNode[]) => {
    if (isInlineBodyEmpty(body)) {
      issues.push(te("schemaRecovery.validation.emptyCommentReply", { threadId, messageId }));
    }
    visitInline(body);
  };

  const collectId = (id: string, type: string) => {
    if (ids.has(id)) {
      issues.push(te("schemaRecovery.validation.duplicateId", { id }));
    }
    ids.add(id);
    if (!id) {
      issues.push(te("schemaRecovery.validation.missingNodeId", { type }));
    }
  };

  for (const block of document.content) {
    collectId(block.id, block.type);
    blockIds.add(block.id);

    if (block.type === "heading" || block.type === "paragraph") {
      visitInline(block.children, block.id);
    }

    if (block.type === "list") {
      for (const item of block.items) {
        visitListItem(item);
      }
    }

    if (block.type === "problem") {
      block.lead.forEach(visitProblemAreaBlock);
      block.prompt.forEach(visitProblemAreaBlock);
      block.solution.forEach(visitProblemAreaBlock);
      block.hints.forEach(visitProblemAreaBlock);
    }

    if (block.type === "layoutSection") {
      block.children.forEach(visitTextFlowBlock);
    }

    if (block.type === "boxBlock") {
      visitBoxBlock(block);
    }
  }

  for (const thread of document.comments ?? []) {
    collectId(thread.id, "commentThread");
    issues.push(...getCommentAnchorIssues(thread.id, thread.anchor, {
      blockIds,
      inlineMathIdsByBlockId,
      overlayShapeIds,
    }));
    for (const message of thread.messages) {
      collectId(message.id, "commentMessage");
      visitCommentBody(thread.id, message.id, message.body);
      for (const reaction of message.reactions ?? []) {
        collectId(reaction.id, "commentReaction");
      }
    }
    for (const reaction of thread.reactions ?? []) {
      collectId(reaction.id, "commentReaction");
    }
  }

  return issues;
}

function getCommentAnchorIssues(
  threadId: string,
  anchor: SigmaCommentAnchor,
  context: {
    blockIds: Set<string>;
    inlineMathIdsByBlockId: Map<string, Set<string>>;
    overlayShapeIds: Set<string>;
  },
): string[] {
  if (anchor.type === "textRange") {
    const issues: string[] = [];
    if (!context.blockIds.has(anchor.start.blockId)) {
      issues.push(te("schemaRecovery.validation.missingCommentStartBlock", {
        threadId,
        blockId: anchor.start.blockId,
      }));
    }
    if (!context.blockIds.has(anchor.end.blockId)) {
      issues.push(te("schemaRecovery.validation.missingCommentEndBlock", {
        threadId,
        blockId: anchor.end.blockId,
      }));
    }
    return issues;
  }

  if (anchor.type === "inlineMath") {
    if (!context.blockIds.has(anchor.blockId)) {
      return [te("schemaRecovery.validation.missingCommentMathBlock", { threadId, blockId: anchor.blockId })];
    }
    if (!context.inlineMathIdsByBlockId.get(anchor.blockId)?.has(anchor.mathInlineId)) {
      return [te("schemaRecovery.validation.missingCommentMath", { threadId, mathId: anchor.mathInlineId })];
    }
    return [];
  }

  if (anchor.type === "block") {
    return context.blockIds.has(anchor.blockId)
      ? []
      : [te("schemaRecovery.validation.missingCommentBlock", { threadId, blockId: anchor.blockId })];
  }

  if (anchor.type === "overlayMath") {
    if (!anchor.shapeId) {
      return [];
    }
    return context.overlayShapeIds.has(anchor.shapeId)
      ? []
      : [te("schemaRecovery.validation.missingOverlayMath", { threadId })];
  }

  if (anchor.type === "canvasRegion") return [];

  return anchor.shapeIds.some((shapeId) => context.overlayShapeIds.has(shapeId))
    ? []
    : [te("schemaRecovery.validation.missingOverlayShape", { threadId })];
}

export function getTexIssues(tex: string, nodeId: string): string[] {
  return validateMathTex(tex).map((issue) => {
    if (issue.code === "unknown-command" && issue.arg) {
      return te("schemaRecovery.validation.unknownTexCommand", { nodeId, command: issue.arg });
    }

    return te("schemaRecovery.validation.texError", { nodeId, code: issue.code });
  });
}

function isInlineBodyEmpty(children: InlineNode[]): boolean {
  return children.every((child) => {
    if (child.type === "text") {
      return child.text.trim().length === 0;
    }
    return child.tex.trim().length === 0;
  });
}
