import {
  buildMathliveContextPrompt,
  buildSigmaDocContextPrompt,
} from "@/lib/ai/ai-edit-runtime";
import { createTranslator, DEFAULT_LOCALE, type AppLocale, type Translate } from "@/lib/i18n";
import { prompt as jaPrompt } from "@/lib/i18n/dictionaries/ja/prompt";
import type { AiResourceRunContext } from "../../../electron/ai-resource-store";
import { SIGMA_DOC_MCP_SERVER_NAME } from "../../../electron/sigma-studio-mcp-launch";
import { appMcpToolGuidance, type McpToolProfile } from "./mcp-tool-profile";

/** この層のプロンプト文言は全て `prompt` namespace が持つ。 */
type PromptTranslate = Translate<"prompt">;

/**
 * 節のキー。**辞書から導出する** — `string` にすると綴り間違いがコンパイルを通り、
 * i18next はキーをそのまま返すので `mcp.doesNotExist` という文字列がプロンプトへ
 * 混入する (定数だった頃はシンボル名の誤りとして落ちていた: code-review 指摘)。
 */
type McpPromptSectionKey = keyof typeof jaPrompt.mcp;

/**
 * 節の本文。**ここでは出力言語ポリシーを足さない** — 節は互いに合成されるので、
 * 足すと最終プロンプトに同じ一文が何度も並ぶ。
 */
function section(t: PromptTranslate, key: McpPromptSectionKey): string {
  return t(`mcp.${key}`);
}

/**
 * **モデルへ実際に送られるプロンプトの先頭に、出力言語ポリシーを 1 度だけ置く (D2)。**
 *
 * プロンプト自体は UI の表示言語に連動するので、英語 UI では英語の指示が飛ぶ。
 * それだけだとモデルが「英語で書けという意味だ」と読み違えて日本語の教材を英語に
 * 書き換えかねないので、「教材の中身は編集中の教材の言語で書く」を必ず添える。
 *
 * **付けるのは送信の入口だけ** (`buildMcpEditPrompt` / `buildMcpEditTurnPrompt` /
 * `buildMcpEditInvariantGuidance` / `buildMcpRefusedOperationContinuationPrompt`)。
 * 節ビルダーは互いに合成されるので、そちらに付けると同じ一文が何度も並ぶ。
 * どの入口も漏らさないことは `prompt-policy.test.ts` が実測で守る。
 */
function withPolicy(t: PromptTranslate, body: string): string {
  return `${t("documentLanguagePolicy")}\n${body}`;
}

/**
 * 画像からの教材再構成ポリシー。元資料に無い解答を作らないルールがこの節の途中に挟まる。
 * 合成にも単体にも同じものを使う (両者に違いは無い)。
 */
export function buildMcpImageMaterialReconstructionPrompt(t: PromptTranslate): string {
  return [
    section(t, "imageMaterialReconstructionHead"),
    section(t, "imageSourceFidelity"),
    section(t, "imageMaterialReconstructionTail"),
  ].join("\n");
}

export function buildMcpImageSourceFidelityRule(t: PromptTranslate): string {
  return section(t, "imageSourceFidelity");
}

export function buildMcpChatgptVisualPreviewPrompt(t: PromptTranslate): string {
  return section(t, "chatgptVisualPreview");
}

export function buildMcpMaterialReusePrompt(t: PromptTranslate): string {
  return section(t, "materialReuse");
}

export function buildMcpContentToolGuidePrompt(t: PromptTranslate, toolProfile: McpToolProfile = "external"): string {
  return section(t, toolProfile === "app" ? "appContentToolGuide" : "contentToolGuide");
}

export function buildMcpPageLayoutToolGuidePrompt(t: PromptTranslate): string {
  return section(t, "pageLayoutToolGuide");
}

export function buildMcpShapeToolGuidePrompt(t: PromptTranslate): string {
  return section(t, "shapeToolGuide");
}

export function buildMcpGraphToolGuidePrompt(t: PromptTranslate): string {
  return section(t, "graphToolGuide");
}

// Web検索が有効な場合だけ per-turn で注入するポリシー (MCP_EDIT_INVARIANT_GUIDANCE には
// 含めない)。aiWebSearchEnabled は実行時に変わりうる設定なので、静的な invariant
// ガイダンスに焼き込まず BuildMcpEditTurnPromptArgs.webSearchEnabled 経由で毎turn
// 条件付きで送る。出典の提示は MCP_LIBRARY_REFERENCE_PROMPT と同じ sourceReferences 機構。
export function buildMcpWebSearchPrompt(t: PromptTranslate): string {
  return section(t, "webSearch");
}

// AIが自分のskill/設定を書き換えられることをエージェントへ知らせる恒常ガイダンス。
// save_ai_resource / delete_ai_resource / update_ai_settings 自体のtool descriptionにも
// 同様の注意書きがあるが、ここでは「ユーザーがAIの挙動について相談してきたら実際に変更できる」
// という気づきをMCP編集方針全体の一部として常時渡す (per-turn条件分岐は不要な静的ガイダンス)。
export function buildMcpSelfConfigPrompt(t: PromptTranslate): string {
  return section(t, "selfConfig");
}

export function buildMcpLibraryReferencePrompt(t: PromptTranslate): string {
  return section(t, "libraryReference");
}

export function buildMcpReferenceExplorationPrompt(t: PromptTranslate): string {
  return section(t, "referenceExploration");
}

export function buildMcpTableToolGuidePrompt(t: PromptTranslate): string {
  return section(t, "tableToolGuide");
}

// Two long worked examples, split out of MCP_GRAPH_TOOL_GUIDE_PROMPT so they
// are not sent on every turn regardless of whether the current instruction
// involves a graph. Appended to the turn prompt only when the instruction or
// selection reference plausibly involves a graph (see mentionsGraphContext).
export function buildMcpEditGraphExamples(t: PromptTranslate): string {
  return section(t, "editGraphExamples");
}

// Keyword gate for MCP_EDIT_GRAPH_EXAMPLES: only worth the tokens when the
// current turn's instruction or selection reference plausibly involves a
// Graph2D (function plot, coordinate plane, number line, curve).
/**
 * 「グラフの話をしている turn か」を利用者の指示から見る。
 *
 * **日本語の語だけでは英語 UI で当たらない。** プロンプトが英語になると利用者も英語で
 * 指示するので、同じ意味の英語も並べる。訳語ではなく**その言語で実際に打たれる語**を
 * 足すのが要点 (WI-5 の反応語彙と同じ考え方)。
 */
const GRAPH_CONTEXT_KEYWORD_PATTERN =
  // 英語側は**必ず語境界で**囲む。`graph` を裸で並べると `paragraph` に当たり、
  // 「この段落を直して」程度の指示でグラフ例 (900 字) が毎回差し込まれる (code-review 指摘)。
  /グラフ|放物線|関数|曲線|数直線|座標|\b(?:graphs?|parabolas?|functions?|curves?|number lines?|coordinates?|axis|axes|plots?)\b/i;

function mentionsGraphContext(instruction: string, referenceText: string | undefined): boolean {
  return GRAPH_CONTEXT_KEYWORD_PATTERN.test(instruction)
    || (referenceText ? GRAPH_CONTEXT_KEYWORD_PATTERN.test(referenceText) : false);
}

// Shared once-per-composed-output sentences. Both buildMcpEditPrompt (claude)
// and turnPromptHeadLines (codex's per-turn prompt) used to inline their own
// copies of these two rules, so claude's single composed prompt ended up
// containing each sentence twice. They now live here as the single source and
// are referenced (not duplicated) by MCP_EDIT_INVARIANT_GUIDANCE only —
// codex additionally sees them once per thread via developerInstructions.
export function buildMcpEditExpectedRevisionRule(t: PromptTranslate): string {
  return section(t, "editExpectedRevision");
}

export function buildMcpEditAppContextToolGuide(t: PromptTranslate): string {
  return section(t, "editAppContextToolGuide");
}

export function buildMcpOfficialSkillGuide(t: PromptTranslate): string {
  return section(t, "officialSkillGuide");
}

// Short, always-on per-turn rules (see buildMcpEditPrompt/buildMcpEditTurnPrompt
// callers). Kept to ≤6 lines and sent on every turn for every provider so
// these survive even when a resumed session skips the full static guidance
// below (see mcp-edit-shared-runner.ts's slimmed resumed-turn prompt).
export function buildMcpEditTurnHardRules(t: PromptTranslate): string {
  // 末尾の公式スキル案内は同じ行に続ける (元の template literal と同じ並び)。
  return `${section(t, "editTurnHardRules")}${section(t, "officialSkillGuide")}`;
}

// User-facing labels for the operations the app refuses. The app never widens
// this set (see FORBIDDEN_ITEM_TYPES in electron/codex-app-server-client.ts);
// these only name the refused operation in the activity log and in the
// continuation prompt below.
/** 辞書に呼び名がある操作。未知の itemType は id をそのまま出す。 */
export const REFUSED_ITEM_TYPES = [
  "commandExecution", "fileChange", "imageGeneration", "collabAgentToolCall", "webSearch",
] as const;

const REFUSED_ITEM_TYPE_SET: ReadonlySet<string> = new Set(REFUSED_ITEM_TYPES);

export function describeRefusedItemType(itemType: string, t: PromptTranslate): string {
  return REFUSED_ITEM_TYPE_SET.has(itemType)
    ? (t(`refused.item.${itemType}` as never) as unknown as string)
    : t("refused.unknownItem", { replace: { itemType } });
}

/**
 * Sent as the next turn's input after the app refused a forbidden operation
 * (shell execution / direct file edits / connectors / web
 * search while disabled). The refusal never widens what the agent may do; this
 * only keeps the run alive so the remaining work can still be done with MCP
 * tools. The refused operations are named explicitly because "don't retry the
 * same operation" is useless if the agent cannot tell which one was refused.
 */
export function buildMcpRefusedOperationContinuationPrompt(
  refusedItemTypes: readonly string[],
  runId: string | undefined,
  t: PromptTranslate,
): string {
  const refusedLabels = refusedItemTypes.map((itemType) => describeRefusedItemType(itemType, t));
  const refusedSentence = refusedLabels.length > 0
    ? t("refused.named", { replace: { operations: refusedLabels.join(t("refused.separator")) } })
    : t("refused.unnamed");
  return withPolicy(t, [
    refusedSentence,
    t("refused.alwaysUnavailable"),
    t("refused.continueWithMcp"),
    t("refused.explainIfImpossible"),
    ...(runId ? [t("refused.passRunId", { replace: { runId } })] : []),
  ].join("\n"));
}

/**
 * 合成に使う節 (ポリシー無し)。単体で送る版は `buildMcpEditInvariantGuidance`。
 * export してあるのは、合成後のプロンプトに節が入っていることを検査できるようにするため。
 */
export function buildMcpEditInvariantGuidanceSection(t: PromptTranslate, toolProfile: McpToolProfile = "external"): string {
  const guidance = [
    section(t, "editInvariantGuidanceHead"),
    section(t, "svgImageGuidance"),
    section(t, "editExpectedRevision"),
    section(t, "editAppContextToolGuide"),
    section(t, "editInvariantGuidanceMiddle"),
    "",
    buildMcpImageMaterialReconstructionPrompt(t),
    buildMcpContentToolGuidePrompt(t, toolProfile),
    section(t, "pageLayoutToolGuide"),
    section(t, "materialReuse"),
    section(t, "shapeToolGuide"),
    section(t, "graphToolGuide"),
    section(t, "tableToolGuide"),
    section(t, "referenceExploration"),
    section(t, "libraryReference"),
    section(t, "selfConfig"),
  ].join("\n\n");
  return toolProfile === "app" ? appMcpToolGuidance(guidance) : guidance;
}

export function buildMcpEditInvariantGuidance(t: PromptTranslate, toolProfile: McpToolProfile = "external"): string {
  return withPolicy(t, buildMcpEditInvariantGuidanceSection(t, toolProfile));
}

export type McpEditPromptProvider = "claude" | "codex" | "antigravity";

function toolNamespaceLine(provider: McpEditPromptProvider, t: PromptTranslate): string {
  // Claude だけ名前空間つきのツール名を明示する (他の provider は素のツール名で届く)。
  return provider === "claude"
    ? t("turn.toolNamespaceClaude", { replace: { server: SIGMA_DOC_MCP_SERVER_NAME } })
    : t("turn.toolNamespace", { replace: { server: SIGMA_DOC_MCP_SERVER_NAME } });
}

export function formatAiResourcePromptSection(
  context: AiResourceRunContext | undefined,
  t: PromptTranslate,
): string {
  if (!context) {
    return "";
  }
  const contentItems = [...context.always, ...context.explicit].filter((item) => item.content?.trim());
  const resourceSection = contentItems.length > 0
    ? [
        t("turn.aiResources"),
        ...contentItems.map((item) => [
          `--- ${item.kind}: ${item.title} (${item.id}) ---`,
          truncateForPrompt(item.content ?? ""),
        ].join("\n")),
      ].join("\n")
    : "";

  return resourceSection;
}

function truncateForPrompt(value: string, maxLength = 12_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...` : value;
}

export interface BuildMcpEditTurnPromptMentionedDocument {
  title: string;
}

export interface BuildMcpEditTurnPromptAttachment {
  name: string;
  mimeType?: string | null;
}

export interface BuildMcpEditTurnPromptArgs {
  /** Must match the profile of the MCP server started for this agent. */
  toolProfile?: McpToolProfile;
  instruction: string;
  fileId: string;
  selectedId?: string | null;
  aiResources?: AiResourceRunContext;
  mentionedDocuments?: BuildMcpEditTurnPromptMentionedDocument[];
  /** App-chat files available from get_attached_media for this specific turn. */
  attachments?: BuildMcpEditTurnPromptAttachment[];
  /**
   * Pre-formatted selection context (see formatAiEditReferencesForPrompt in
   * ai-edit-reference.ts): selected text / math tex / overlay shape selection
   * the user had active when they issued this instruction. Callers are
   * responsible for calling formatAiEditReferencesForPrompt themselves (this
   * module only truncates and labels the result) so that a bare block id
   * never has to stand in for the user's actual selection.
   */
  referenceText?: string;
  /**
   * This turn's runId (see ai-edit:run IPC). Told to the agent so it can pass
   * it back as the `runId` argument on every app-context tool call
   * (get_selected_block / get_active_reference / get_insertion_candidates /
   * get_neighbor_blocks / get_attached_media / get_mentioned_sigma_docs) as
   * well as every write/visual-session tool (insert_body_content,
   * update_rich_content, begin_visual_edit_session, etc.) so the pending proposals
   * they create are attributed back to this AI session.
   * Codex and Antigravity share one long-lived MCP server process across
   * concurrent runs, so without this the server cannot tell which run-context
   * file belongs to which in-flight run.
   */
  runId?: string;
  /**
   * aiWebSearchEnabled設定の現在値 (main.ts が run ごとに読み直して渡す)。true のとき
   * だけ MCP_WEB_SEARCH_PROMPT を turn プロンプトへ含める。設定は同一会話のturn間でも
   * 変わりうるため、静的ガイダンスではなく意図的に per-turn で送る (resumed turn 含む)。
   */
  webSearchEnabled?: boolean;
}

// 複数参照 (最大8件) の連結分の余裕を持たせる。
const MAX_REFERENCE_PROMPT_CHARS = 6000;

function formatReferenceSection(referenceText: string | undefined, t: PromptTranslate): string {
  if (!referenceText || referenceText.trim().length === 0) {
    return "";
  }
  const bounded = referenceText.length > MAX_REFERENCE_PROMPT_CHARS
    ? `${referenceText.slice(0, MAX_REFERENCE_PROMPT_CHARS)}\n${t("turn.selectionTruncated")}`
    : referenceText;
  return [t("turn.selectionContext"), bounded].join("\n");
}

function turnPromptHeadLines(
  provider: McpEditPromptProvider,
  args: BuildMcpEditTurnPromptArgs,
  t: PromptTranslate,
): string[] {
  const guidance = args.toolProfile === "app" ? appMcpToolGuidance : (text: string) => text;
  return [
    t("turn.assistantIntro"),
    toolNamespaceLine(provider, t),
    t("turn.fileId", { replace: { fileId: args.fileId } }),
    args.runId ? t(args.toolProfile === "app" ? "turn.appRunId" : "turn.runId", { replace: { runId: args.runId } }) : "",
    args.selectedId ? t("turn.selectedId", { replace: { selectedId: args.selectedId } }) : "",
    guidance(section(t, "editTurnHardRules") + section(t, "officialSkillGuide")),
    args.toolProfile === "app" ? section(t, "appToolProfile") : "",
    provider === "codex" ? section(t, "chatgptVisualPreview") : "",
    t("turn.procedure"),
    t("turn.completionReport"),
  ];
}

function formatMentionedDocumentsHint(
  mentionedDocuments: BuildMcpEditTurnPromptMentionedDocument[] | undefined,
  t: PromptTranslate,
): string {
  if (!mentionedDocuments || mentionedDocuments.length === 0) {
    return "";
  }
  const titles = mentionedDocuments.map((doc) => doc.title).join(", ");
  return t("turn.mentionedDocuments", { replace: { count: mentionedDocuments.length, titles } });
}

function formatAttachmentsHint(
  attachments: BuildMcpEditTurnPromptAttachment[] | undefined,
  t: PromptTranslate,
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const names = attachments.map((attachment) => attachment.name).join(", ");
  return [
    t("turn.attachments", { replace: { count: attachments.length, names } }),
    section(t, "imageSourceFidelity"),
  ].join("\n");
}

function turnPromptTailLines(args: BuildMcpEditTurnPromptArgs, t: PromptTranslate): string[] {
  return [
    formatAttachmentsHint(args.attachments, t),
    formatMentionedDocumentsHint(args.mentionedDocuments, t),
    formatAiResourcePromptSection(args.aiResources, t),
    "",
    formatReferenceSection(args.referenceText, t),
    mentionsGraphContext(args.instruction, args.referenceText) ? section(t, "editGraphExamples") : "",
    args.webSearchEnabled ? section(t, "webSearch") : "",
    "",
    t("turn.userInstruction"),
    args.instruction,
  ];
}

export function buildMcpEditTurnPrompt(
  provider: McpEditPromptProvider,
  args: BuildMcpEditTurnPromptArgs,
  locale: AppLocale = DEFAULT_LOCALE,
): string {
  const t = createTranslator(locale, "prompt");
  return withPolicy(t, [...turnPromptHeadLines(provider, args, t), ...turnPromptTailLines(args, t)]
    .filter((line) => line.length > 0)
    .join("\n"));
}

export interface BuildMcpEditPromptArgs extends BuildMcpEditTurnPromptArgs {
  provider: McpEditPromptProvider;
  /**
   * True when this turn resumes an existing agent session/thread (an
   * agentThreadId was passed in). Claude and Antigravity otherwise get the
   * full ~19KB static guidance (SIGMA_DOC_AI_CONTEXT_PROMPT,
   * MATHLIVE_AI_CONTEXT_PROMPT, MCP_EDIT_INVARIANT_GUIDANCE) re-sent on every
   * single turn even though the model already saw it earlier in the same
   * conversation. On a resumed turn we send only the turn-level content
   * (head + hard rules + reference + instruction) via buildMcpEditTurnPrompt,
   * the same shape Codex already sends every turn. The first turn of a
   * session (no agentThreadId yet) still gets the full guidance.
   */
  isResumedTurn?: boolean;
  /**
   * プロンプトを組む言語。**Electron main には React の context が無いので引数で運ぶ。**
   *
   * **必須にしてあるのは、引き回しの漏れを実行時ではなくコンパイル時に落とすため。**
   * 途中の 1 箇所で渡し忘れるだけで英語 UI に日本語のプロンプトが飛ぶが、辞書は英語で
   * 揃っているので辞書側の検査では気づけない (WI-8 で実際に共有ランナーが落としていた)。
   * 教材の中身の言語はこれとは独立で、`documentLanguagePolicy` が文書に従わせる。
   */
  locale: AppLocale;
}

// claude/antigravity は developerInstructions を持たない1回きりのプロンプトなので、共通
// ガイダンスと turn プロンプトを合成して1本にする（ただし resumed turn では合成しない。
// isResumedTurn を参照）。codex は共通ガイダンスをスレッド開始時の developerInstructions
// として一度だけ送り、turnごとには常に buildMcpEditTurnPrompt だけを送る。
export function buildMcpEditPrompt(args: BuildMcpEditPromptArgs): string {
  const { provider, isResumedTurn, locale, ...turnArgs } = args;
  if (isResumedTurn) {
    return buildMcpEditTurnPrompt(provider, turnArgs, locale);
  }
  const t = createTranslator(locale, "prompt");
  return withPolicy(t, [
    ...turnPromptHeadLines(provider, turnArgs, t),
    "",
    buildSigmaDocContextPrompt(t),
    "",
    ...(args.toolProfile === "app" ? [section(t, "appMarkdownBoundary")] : []),
    buildMathliveContextPrompt(t),
    "",
    // 合成する側なのでポリシー無しの節を使う (先頭で 1 度だけ付ける)。
    buildMcpEditInvariantGuidanceSection(t, args.toolProfile),
    ...turnPromptTailLines(turnArgs, t),
  ].filter((line) => line.length > 0).join("\n"));
}
