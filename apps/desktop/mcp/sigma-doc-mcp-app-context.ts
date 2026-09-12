import { renderAttachedPdfPages, type AttachedPdfPages } from "../electron/ai-edit-pdf";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  loadAiEditRunContext,
  type AiEditRunContext,
  type AiEditRunContextProvider,
} from "../electron/ai-edit-run-context";
import { parseAttachedFileDataUrl, parseAttachedImageDataUrl } from "../electron/ai-edit-image";
import { parseMcpProposalProvider } from "../electron/local-sigma-doc-proposal-store";
import type { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { SIGMA_STUDIO_MCP_PROVIDER_ENV } from "../electron/sigma-studio-mcp-launch";
import { recordMentionedDocuments } from "./sigma-doc-mcp-source-ledger";
import {
  executeSigmaDocAgentReadTool,
  type AiEditMentionedDocumentContext,
  type SigmaDocAgentSession,
  type SigmaDocAgentReadToolName,
} from "@/lib/ai/sigma-doc-agent-tools";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import { getFileMetadata, loadDocumentForFile } from "./sigma-doc-mcp-store";
import {
  resolveRunContextDirectory,
  sanitizeMcpFileComponent,
  writeRunContextPreviewFile,
} from "./sigma-doc-mcp-files";

const NO_APP_CONTEXT_MESSAGE = "アプリの実行コンテキストがありません。デスクトップアプリのAIチャットから実行してください。";
const NO_APP_CONTEXT_FILE_MESSAGE = "コンテキストの教材が見つかりません。デスクトップアプリで教材を開き直してから実行してください。";
const MAX_ATTACHED_FILE_CONTENT = 4;
const TEXT_ATTACHMENT_MIME_TYPE_PATTERN = /^(?:text\/|application\/(?:json|ld\+json|xml|javascript|x-javascript|yaml|x-yaml)$)/i;

type JsonObject = Record<string, unknown>;

export interface AppContextToolDeps {
  env: Record<string, string | undefined>;
  loadSigmaDocStore: () => LocalSigmaDocStore;
}

export interface AppContextToolOutcome {
  payload: JsonObject;
  extraContent: CallToolResult["content"];
}

function noAppContextOutcome(detail?: string): AppContextToolOutcome {
  return {
    payload: {
      ok: true,
      hasAppContext: false,
      message: NO_APP_CONTEXT_MESSAGE,
      ...(detail ? { detail } : {}),
    },
    extraContent: [],
  };
}

function parseMentionedDocuments(context: AiEditRunContext): {
  mentionedDocuments: AiEditMentionedDocumentContext[];
  warnings: string[];
} {
  const mentionedDocuments: AiEditMentionedDocumentContext[] = [];
  const warnings: string[] = [];
  for (const item of context.mentionedDocuments) {
    try {
      mentionedDocuments.push({
        ...item,
        document: parseSigmaDocument(item.document),
      });
    } catch (error) {
      warnings.push(
        `教材「${item.title || item.fileId}」のSigmaDocが不正なため除外しました: ${
          error instanceof Error ? error.message : "不明なエラー"
        }`,
      );
    }
  }
  return { mentionedDocuments, warnings };
}

function basePayload(context: AiEditRunContext, currentRevision: number): JsonObject {
  return {
    ok: true,
    hasAppContext: true,
    fileId: context.fileId,
    contextRevision: context.fileRevision,
    currentRevision,
    revisionMatched: context.fileRevision === currentRevision,
  };
}

// get_attached_media / get_mentioned_sigma_docs は run-context の attachments / mentionedDocuments
// だけで完結する読み取りで、対象教材のcontentを参照しない。対象教材のフル読み込み
// (loadDocumentForFile によるparse・agent session構築)は不要なので、revision確認用に
// getFileMetadata だけ呼び、ここで直接結果を組み立てる。
async function runAttachedMediaTool(deps: AppContextToolDeps, context: AiEditRunContext, args: JsonObject): Promise<AppContextToolOutcome> {
  const store = deps.loadSigmaDocStore();
  let currentRevision: number;
  try {
    currentRevision = (await getFileMetadata(store, context.fileId)).revision;
  } catch {
    return noAppContextOutcome(NO_APP_CONTEXT_FILE_MESSAGE);
  }

  const extraContent: CallToolResult["content"] = [];
  const warnings: string[] = [];
  const runContextDirectory = resolveRunContextDirectory(deps.env);
  const includeImageContent = context.provider !== "chatgpt";
  const selectedAttachments = context.attachments.filter((attachment) => !args.attachmentId || attachment.id === args.attachmentId);
  const attachments: Array<{
    id: string;
    name: string;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    fileSize: number | null;
    sourceReferenceKey: string | null;
    hasImageData: boolean;
    imageContentIncluded: boolean;
    contentIncluded: boolean;
    contentType: "image" | "resource" | "pdf" | null;
    filePath: string | null;
    pdf?: AttachedPdfPages;
    error?: string;
  }> = selectedAttachments.map((attachment) => {
    const attachedImage = parseAttachedImageDataUrl(attachment.dataUrl);
    const parsedImage = includeImageContent && extraContent.length < MAX_ATTACHED_FILE_CONTENT
      ? attachedImage
      : null;
    const parsedFile = !attachedImage && extraContent.length < MAX_ATTACHED_FILE_CONTENT
      ? parseAttachedFileDataUrl(attachment.dataUrl)
      : null;
    let contentType: "image" | "resource" | null = null;
    if (parsedImage) {
      extraContent.push({
        type: "image",
        data: parsedImage.base64,
        mimeType: parsedImage.mimeType,
      });
      contentType = "image";
    } else if (parsedFile && !(parsedFile.mimeType === "application/pdf" && context.provider !== "claude")) {
      const uri = `attachment:///${encodeURIComponent(attachment.name || attachment.id)}?id=${encodeURIComponent(attachment.id)}`;
      extraContent.push({
        type: "resource",
        resource: TEXT_ATTACHMENT_MIME_TYPE_PATTERN.test(parsedFile.mimeType)
          ? {
              uri,
              mimeType: parsedFile.mimeType,
              text: Buffer.from(parsedFile.base64, "base64").toString("utf8"),
            }
          : {
              uri,
              mimeType: parsedFile.mimeType,
              blob: parsedFile.base64,
            },
      });
      contentType = "resource";
    }
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      fileSize: attachment.fileSize ?? null,
      sourceReferenceKey: attachment.sourceReferenceKey ?? null,
      hasImageData: attachment.dataUrl.startsWith("data:image/"),
      imageContentIncluded: Boolean(parsedImage),
      contentIncluded: contentType !== null,
      contentType,
      filePath: null,
    };
  });

  // Write attachment files after building the lightweight payload. Keeping
  // writes separate lets one malformed attachment be reported without
  // preventing other attachments from reaching the agent.
  for (const [index, attachment] of selectedAttachments.entries()) {
    const item = attachments[index];
    if (!item || !runContextDirectory) {
      continue;
    }
    try {
      const decoded = decodeDataUrl(attachment.dataUrl);
      if (!decoded) {
        throw new Error("data URLをデコードできませんでした。");
      }
      const extension = extensionForMimeType(decoded.mimeType);
      item.filePath = await writeRunContextPreviewFile(
        runContextDirectory,
        `${context.provider}-${context.runId}-attachments`,
        `attachment-${sanitizeMcpFileComponent(attachment.id)}${extension}`,
        decoded.bytes,
      );
      if (decoded.mimeType === "application/pdf" && context.provider !== "claude") {
        item.pdf = await renderAttachedPdfPages(decoded.bytes, {
          pageStart: typeof args.pageStart === "number" ? args.pageStart : 1,
          writePage: (pageNumber, png) => writeRunContextPreviewFile(
            runContextDirectory,
            `${context.provider}-${context.runId}-attachments`,
            `attachment-${sanitizeMcpFileComponent(attachment.id)}-page-${pageNumber}.png`,
            png,
          ),
          onPageImage: includeImageContent ? (pageNumber, png) => {
            extraContent.push({ type: "text", text: `${attachment.name} — page ${pageNumber}` });
            extraContent.push({ type: "image", mimeType: "image/png", data: png.toString("base64") });
          } : undefined,
        });
        item.contentIncluded = true;
        item.contentType = "pdf";
        item.imageContentIncluded = includeImageContent;
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : "不明なエラー";
      warnings.push(`添付「${attachment.name || attachment.id}」の読み取りに失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`);
    }
  }

  return {
    payload: {
      ...basePayload(context, currentRevision),
      message: context.provider === "claude"
        ? "添付メディアを取得しました。画像はimage content、PDFはこのturnのdocument contentまたはresource contentを読んでください。"
        : includeImageContent
        ? "添付メディアを取得しました。PDFはpdf.pagesのテキストとページ順のimage contentを読んでください。pdf.nextPageStartがあれば、同じrunIdとattachmentId、pageStart=nextPageStartでget_attached_mediaを再度呼び、残りのページも確認してください。"
        : "添付メディアを取得しました。画像はfilePathをview_imageで開きます。PDFはpdf.pagesのtextを読み、各previewFileをview_imageで開いて図表やスキャンも確認してください。PDF原本のfilePathをview_imageに渡してはいけません。pdf.nextPageStartがあれば、同じrunIdとattachmentId、pageStart=nextPageStartでget_attached_mediaを再度呼んでください。",
      ...(warnings.length > 0 ? { warnings } : {}),
      data: { attachments },
    },
    extraContent,
  };
}

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const match = dataUrl.match(/^data:([^;,]+)?((?:;[^,]*)?),([\s\S]*)$/i);
  if (!match) {
    return null;
  }
  const mimeType = match[1] || "application/octet-stream";
  const metadata = match[2] ?? "";
  const body = match[3] ?? "";
  try {
    return {
      mimeType,
      bytes: metadata.toLowerCase().includes(";base64")
        ? Buffer.from(body, "base64")
        : Buffer.from(decodeURIComponent(body), "utf8"),
    };
  } catch {
    return null;
  }
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/svg+xml") return ".svg";
  return ".bin";
}

async function runMentionedSigmaDocsTool(deps: AppContextToolDeps, context: AiEditRunContext): Promise<AppContextToolOutcome> {
  const store = deps.loadSigmaDocStore();
  let currentRevision: number;
  try {
    currentRevision = (await getFileMetadata(store, context.fileId)).revision;
  } catch {
    return noAppContextOutcome(NO_APP_CONTEXT_FILE_MESSAGE);
  }

  const { mentionedDocuments, warnings } = parseMentionedDocuments(context);

  // ユーザーが明示的にメンションした教材は、読まれたかに関わらず参照元として扱う (WI-3)。
  recordMentionedDocuments(
    context.runId,
    mentionedDocuments.map((item) => ({ fileId: item.fileId, title: item.title })),
  );

  return {
    payload: {
      ...basePayload(context, currentRevision),
      message: "メンションされたSigmaDocを取得しました。",
      ...(warnings.length > 0 ? { warnings } : {}),
      data: {
        documents: mentionedDocuments.map((item) => ({
          id: item.id,
          fileId: item.fileId,
          title: item.title,
          documentPath: item.documentPath,
          revision: item.revision,
          excerpt: item.excerpt,
          document: item.document,
        })),
      },
    },
    extraContent: [],
  };
}

async function runDocumentBackedReadTool(
  deps: AppContextToolDeps,
  toolName: SigmaDocAgentReadToolName,
  context: AiEditRunContext,
  args: JsonObject,
): Promise<AppContextToolOutcome> {
  const store = deps.loadSigmaDocStore();
  let currentRevision: number;
  let document: Awaited<ReturnType<typeof loadDocumentForFile>>["document"];
  try {
    const loaded = await loadDocumentForFile(store, context.fileId);
    currentRevision = loaded.file.revision;
    document = loaded.document;
  } catch {
    return noAppContextOutcome(NO_APP_CONTEXT_FILE_MESSAGE);
  }

  // These app-context routes dispatch only SigmaDocAgentReadToolName handlers. Build the read
  // session around the revision-checked parsed document directly; createSigmaDocAgentSession
  // intentionally re-parses/clones for mutable draft tools, which would discard the load cache's
  // parse saving on every get_neighbor_blocks/get_selected_block call.
  const session: SigmaDocAgentSession = {
    baseDocument: document,
    draftDocument: document,
    selectedId: context.selectedId,
    references: context.references as unknown as AiEditReference[],
    attachments: context.attachments,
    mentionedDocuments: [],
    materials: [],
    operations: [],
    operationResults: [],
    mutationOperations: [],
    changedIds: [],
    toolEvents: [],
  };

  const toolResult = executeSigmaDocAgentReadTool(session, toolName, args);

  return {
    payload: {
      ...basePayload(context, currentRevision),
      ok: toolResult.ok,
      message: toolResult.message,
      ...(toolResult.data !== undefined ? { data: toolResult.data } : {}),
    },
    extraContent: [],
  };
}

// Codex (app-server) と Antigravity は常駐/固定設定のMCPサーバーを全runで共有するため、
// run-context ファイルパスは起動時に env へ焼き込まれた1本の静的パスしか知らない。
// エージェントへのプロンプトでrunIdを伝え、tool呼び出しに乗せてもらうことで、
// 同じ静的パスの隣にある <provider>-<runId>.run-context.json を狙い撃ちできる
// (loadAiEditRunContext 側でディレクトリを静的パスから逆算する)。providerは
// 起動時に一緒に焼き込まれる SIGMA_STUDIO_MCP_PROVIDER から得る。
function resolveRunContextProviderFromEnv(env: Record<string, string | undefined>): AiEditRunContextProvider | undefined {
  return parseMcpProposalProvider(env[SIGMA_STUDIO_MCP_PROVIDER_ENV]) ?? undefined;
}

async function runContextReadTool(
  deps: AppContextToolDeps,
  toolName: SigmaDocAgentReadToolName,
  args: JsonObject,
  runId?: string,
): Promise<AppContextToolOutcome> {
  const loadResult = loadAiEditRunContext(deps.env, {
    runId,
    provider: resolveRunContextProviderFromEnv(deps.env),
  });
  if (loadResult.state === "none") {
    return noAppContextOutcome();
  }
  if (loadResult.state === "invalid") {
    return noAppContextOutcome(loadResult.error);
  }

  const context = loadResult.context;

  if (toolName === "get_attached_media") {
    return runAttachedMediaTool(deps, context, args);
  }
  if (toolName === "get_mentioned_sigma_docs") {
    return runMentionedSigmaDocsTool(deps, context);
  }
  return runDocumentBackedReadTool(deps, toolName, context, args);
}

export interface RunAppContextToolArgs {
  attachmentId?: string;
  pageStart?: number;
  targetId?: string;
  /**
   * The calling agent's runId (see MCP_EDIT tool schema `runId` param). Used
   * to resolve the per-run run-context file for providers sharing one MCP
   * server process across concurrent runs (Codex, Antigravity). Optional so
   * older prompts / models that omit it still fall back to the static
   * provider-level file.
   */
  runId?: string;
}

export interface AppContextToolDefinition {
  name: string;
  title: string;
  description: string;
  withTargetId: boolean;
  toolName: SigmaDocAgentReadToolName;
}

export const APP_CONTEXT_TOOL_TABLE: AppContextToolDefinition[] = [
  {
    name: "get_selected_block",
    title: "選択中ブロックを取得(アプリ実行時)",
    description: "アプリで選択中のブロックIDと内容を返します。「これを修正」の対象確定に使い、文字範囲やmathInline単体の選択詳細はget_active_referenceも読みます。fileIdは不要。runIdはプロンプトの値を渡します。アプリ実行外ではhasAppContext:falseを返します。",
    withTargetId: true,
    toolName: "get_selected_block",
  },
  {
    name: "get_insertion_candidates",
    title: "挿入候補を取得(アプリ実行時)",
    description: "選択ブロック付近で挿入に使えるtargetId候補と位置関係を返します。「この下に追加」など挿入位置が指示とIDだけで決めにくいときに使います。fileIdは不要。runIdはプロンプトの値を渡します。アプリ実行外ではhasAppContext:falseを返します。",
    withTargetId: true,
    toolName: "get_insertion_candidates",
  },
  {
    name: "get_neighbor_blocks",
    title: "前後ブロックを取得(アプリ実行時)",
    description: "選択ブロックの前後を返します。文体・論理のつながりを保って修正する場合や、挿入前に重複内容がないか確認する場合に使います。fileIdは不要。runIdはプロンプトの値を渡します。アプリ実行外ではhasAppContext:falseを返します。",
    withTargetId: true,
    toolName: "get_neighbor_blocks",
  },
  {
    name: "get_active_reference",
    title: "参照コンテキストを取得(アプリ実行時)",
    description: "ユーザーが指定した参照の一覧(複数可)を返します。各参照は文字範囲、mathInline TeX、overlay図形などのkind/targetId/詳細を持ちます。「この式」「選択部分だけ」を解釈するときはget_selected_blockより優先して参照します。fileIdは不要。runIdはプロンプトの値を渡します。アプリ実行外ではhasAppContext:falseを返します。",
    withTargetId: false,
    toolName: "get_active_reference",
  },
  {
    name: "get_attached_media",
    title: "添付ファイルを取得(アプリ実行時)",
    description: "ユーザーの添付ファイルメタデータ、run-scopedな絶対filePath、実内容を最大4件返します。PNG/JPEG/GIF/WEBPはimage content、その他の形式はresource contentです。ChatGPTではinline image contentを省略するため、画像はfilePathをview_imageで開きます。PDFはChatGPT/Antigravity向けにpdf.pages(ページ番号・text・previewFile)、pageCount、nextPageStartを返します。Antigravityにはページ画像もimage contentで返します。続きはattachmentIdとpageStart=nextPageStartを指定します(1回最大4ページ)。添付があるturnでは編集前に呼び、ファイル名や@参照だけで内容を推測しません。fileIdは不要。runIdはプロンプトの値を渡します。アプリ実行外ではhasAppContext:falseを返します。",
    withTargetId: false,
    toolName: "get_attached_media",
  },
  {
    name: "get_mentioned_sigma_docs",
    title: "メンションされた教材を取得(アプリ実行時)",
    description: "ユーザーが@メンションした他教材のfileId/タイトル/SigmaDocを返します。「この教材を参考に」の内容取得に使い、参照して書き込むときはsourceReferencesにtype:\"document\"とfileId/blockIdを添えます。fileIdは不要。runIdはプロンプトの値を渡します。アプリ実行外ではhasAppContext:falseを返します。",
    withTargetId: false,
    toolName: "get_mentioned_sigma_docs",
  },
];

export async function runAppContextToolByName(
  deps: AppContextToolDeps,
  name: string,
  args: RunAppContextToolArgs = {},
): Promise<AppContextToolOutcome> {
  const definition = APP_CONTEXT_TOOL_TABLE.find((item) => item.name === name);
  if (!definition) {
    throw new Error(`未知のアプリコンテキストtoolです: ${name}`);
  }
  return runContextReadTool(
    deps,
    definition.toolName,
    definition.name === "get_attached_media"
      ? { attachmentId: args.attachmentId, pageStart: args.pageStart }
      : definition.withTargetId ? { targetId: args.targetId } : {},
    args.runId,
  );
}

// 以下はテスト・既存呼び出し向けの薄いラッパー。公開tool名/挙動は
// APP_CONTEXT_TOOL_TABLE 経由のdispatch (runAppContextToolByName) と同一。
export async function runGetSelectedBlock(
  deps: AppContextToolDeps,
  args: RunAppContextToolArgs = {},
): Promise<AppContextToolOutcome> {
  return runAppContextToolByName(deps, "get_selected_block", args);
}

export async function runGetInsertionCandidates(
  deps: AppContextToolDeps,
  args: RunAppContextToolArgs = {},
): Promise<AppContextToolOutcome> {
  return runAppContextToolByName(deps, "get_insertion_candidates", args);
}

export async function runGetNeighborBlocks(
  deps: AppContextToolDeps,
  args: RunAppContextToolArgs = {},
): Promise<AppContextToolOutcome> {
  return runAppContextToolByName(deps, "get_neighbor_blocks", args);
}

export async function runGetActiveReference(
  deps: AppContextToolDeps,
  args: RunAppContextToolArgs = {},
): Promise<AppContextToolOutcome> {
  return runAppContextToolByName(deps, "get_active_reference", args);
}

export async function runGetAttachedMedia(
  deps: AppContextToolDeps,
  args: RunAppContextToolArgs = {},
): Promise<AppContextToolOutcome> {
  return runAppContextToolByName(deps, "get_attached_media", args);
}

export async function runGetMentionedSigmaDocs(
  deps: AppContextToolDeps,
  args: RunAppContextToolArgs = {},
): Promise<AppContextToolOutcome> {
  return runAppContextToolByName(deps, "get_mentioned_sigma_docs", args);
}
