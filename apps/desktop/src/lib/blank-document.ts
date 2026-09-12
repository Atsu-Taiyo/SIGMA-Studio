import { createId } from "@/lib/id";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  ensurePageLayout,
  type SigmaDocument,
} from "@/features/document";

const tWorkspace = createCurrentLocaleTranslator("workspace");

/**
 * D3: 題名は**作成した時点の UI 言語で文書へ焼き込む**。既存文書は書き換えない。
 * 既定値は引数なので**呼ばれるたびに評価される** = そのときの言語になる。
 */
export function createBlankDocument(title = tWorkspace("untitledMaterial")): SigmaDocument {
  const now = new Date().toISOString();
  return ensurePageLayout({
    version: "2.0",
    docId: createId("doc"),
    metadata: { title, styleUnits: { fontSize: "pt" } },
    content: [
      {
        type: "paragraph",
        id: createId("p"),
        children: [{ type: "text", text: "" }],
      },
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    updatedAt: now,
  });
}

/**
 * 空の編集用ドキュメント。
 *
 * **定数ではなく関数。** module 直下の定数にすると題名が読み込み時の言語で
 * 焼き付き、言語を切り替えても新規タブの題名だけ元の言語で残る。呼ぶたびに
 * 作り直すので、**共有インスタンスを前提にした比較 (=== ) はできない**。
 */
export function createEmptyEditorDocument(): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: "doc_empty_editor_draft",
    metadata: { title: tWorkspace("untitledMaterial"), styleUnits: { fontSize: "pt" } },
    content: [
      {
        type: "paragraph",
        id: "p_empty_editor_draft",
        children: [{ type: "text", text: "" }],
      },
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
  });
}
