import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

/**
 * WI-7 の受け入れ条件を実測で固定する:
 * **英語ロケールで AI 編集の全 UI に日本語が残らない**。
 *
 * namespace 単位の検査 (`ai-resolution.test.ts`) は「その辞書の値」しか見ない。面が
 * **別 namespace のキー**を引いていると (この面は `common.*` / `settings.provider.*` /
 * `editor.block.*` を共有している)、そちらの抜けは素通りする。ここは逆向きに、
 * **面のソースが実際に引いているキー**を集めて英語で解決する。
 *
 * 対象ファイル一覧はレビューの代わりにならない (WI-6b の学び) ので、面の側から数える。
 */

const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));
const JAPANESE = /[぀-ヿ一-鿿]/u;

/**
 * AI 編集の面と、そこで使っている「翻訳関数の識別子 → namespace」。
 * 新しい namespace のフックを足したらここも更新する必要がある (下のテストが強制する)。
 */
const SURFACES = {
  "src/components/editor/AiEditPanel.tsx": {
    t: "ai", tAiNow: "ai", tEditor: "editor", tEditorNow: "editor", tCommon: "common", tSettings: "settings",
  },
  "src/components/editor/AiTaskDock.tsx": { t: "ai", tCommon: "common" },
  "src/components/editor/AiConnectionGate.tsx": { t: "ai", tSettings: "settings" },
  "src/components/editor/AiStaleProposalNotice.tsx": { t: "ai" },
  "src/components/editor/ai-run-card-composer.tsx": { t: "ai" },
  "src/components/editor/ai-run-anchor-layer.tsx": { t: "ai", tCommon: "common" },
  "src/components/editor/ChatPromptField.tsx": { t: "ai" },
  "src/features/ai-edit/view/AiEditInlinePreviewCard.tsx": { t: "ai", tEditor: "editor", tCommon: "common" },
  "src/features/ai-edit/view/AiAppliedDocumentDiff.tsx": { t: "ai", tEditor: "editor" },
  "src/features/ai-edit/view/AiSourceReferenceChips.tsx": { t: "ai" },
  "src/features/ai-edit/editor-extensions.tsx": { t: "ai" },
  "src/features/ai-edit/AiPageCanvasEditor.tsx": { t: "ai" },
  "src/features/ai-edit/application/proposal-action-model.ts": { t: "ai", tEditor: "editor" },
  "src/features/ai-edit/application/run-request-model.ts": { t: "ai" },
  "src/features/ai-edit/adapters/tiptap/edit-lock-adapter.ts": { t: "ai" },
  "src/features/ai-edit/model/preview.ts": { t: "ai" },
  "src/lib/ai/ai-agent-activity-label.ts": { t: "ai" },
  "src/lib/ai/ai-connection.ts": { t: "ai", tSettings: "settings" },
  "src/lib/ai/ai-model-catalog.ts": { t: "ai" },
  "src/lib/ai/ai-run-controller.ts": { t: "ai", tAiNow: "ai" },
  "src/lib/ai/ai-edit-reference.ts": { t: "ai", tEditor: "editor" },
  "src/lib/ai/applied-diff-lines.ts": { t: "editor" },
  "src/components/ui/ai/AiProposalActions.tsx": { t: "ai", tCommon: "common" },
  "src/components/ui/ai/AiProposalDecisionButton.tsx": { t: "ai" },
  "src/components/ui/ai/AiAppliedChangeCard.tsx": { t: "ai" },
  /**
   * シェルは AI 文言を「引く」より「ヘルパへ渡す」側。渡し忘れの検査 (下) のために載せる。
   * `ai` 以外の namespace もこの面が持っているので、全部宣言しないと下の突き合わせが落ちる。
   */
  "src/components/editor/EditorShell.tsx": {
    tAi: "ai", tEditor: "editor", t: "chrome", tE: "editor",
    tShapeChrome: "shape", tCommand: "command", tSettings: "settings",
  },
} as const;

type Reference = { file: string; ns: string; key: string };

function read(file: string): string {
  return readFileSync(path.join(desktopRoot, file), "utf8");
}

/** `t(...)` の引数を丸ごと見る。キーは三項演算子の中にも書かれる。 */
function callArgument(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, index);
    }
  }
  return "";
}

function referencesIn(file: string): Reference[] {
  const source = read(file);
  const known = SURFACES[file as keyof typeof SURFACES] as Record<string, string>;
  const out: Reference[] = [];
  for (const match of source.matchAll(/(?<![A-Za-z0-9_.])(t[A-Za-z0-9_]*)\(/gu)) {
    const ns = known[match[1] ?? ""];
    if (!ns) {
      continue;
    }
    const argument = callArgument(source, match.index + match[0].length - 1);
    // 鍵は必ず区切り付き (`section.key`)。`"dismiss"` のような条件側の値は拾わない。
    for (const literal of argument.matchAll(/"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"/gu)) {
      out.push({ file, ns, key: literal[1] ?? "" });
    }
  }
  return out;
}

const REFERENCES = Object.keys(SURFACES).flatMap(referencesIn);

describe("AI edit surfaces in English", () => {
  it("collects a meaningful number of references (a broken scan must not pass silently)", () => {
    expect(REFERENCES.length).toBeGreaterThan(250);
    for (const file of Object.keys(SURFACES)) {
      expect(referencesIn(file).length, file).toBeGreaterThan(0);
    }
  });

  it("declares every translator the surfaces actually use", () => {
    // `useT("…")` を足したのに上の対応表へ書き忘れると、そのフックのキーが検査から
    // 丸ごと漏れる。宣言の側から突き合わせて、漏れをここで落とす。
    const undeclared: string[] = [];
    for (const [file, known] of Object.entries(SURFACES)) {
      const source = read(file);
      const declarations = [
        ...source.matchAll(/const\s+(t[A-Za-z0-9_]*)\s*=\s*useT\(\s*"([a-z]+)"/gu),
        ...source.matchAll(/const\s+(t[A-Za-z0-9_]*)\s*=\s*createNowTranslator\(\s*"([a-z]+)"/gu),
      ];
      for (const match of declarations) {
        const fn = match[1] ?? "";
        const ns = match[2] ?? "";
        if ((known as Record<string, string>)[fn] !== ns) {
          undeclared.push(`${file}: ${fn} = "${ns}"`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("resolves every referenced key in English without falling back to Japanese", () => {
    // `fallbackLng: "ja"` があるので、英語のキーが無くても「引ける」検査は緑のまま
    // 日本語が返る。返り値そのものを見るのが唯一の網。
    const leaked = REFERENCES.filter(({ ns, key }) => {
      const value = createTranslator("en", ns as "ai")(key as never) as unknown as string;
      return typeof value !== "string" || value.length === 0 || value === key || JAPANESE.test(value);
    }).map(({ file, ns, key }) => `${file}: ${ns}.${key}`);
    expect([...new Set(leaked)].sort()).toEqual([]);
  });
});

/**
 * 「表示文言を返すが `t` を省略できる」ヘルパ。
 *
 * 既定を日本語にしてあるのは既存の呼び出しとテストを変えないためだが、**その既定が
 * 罠になる**: 訳した文の中へ `t` を渡し忘れた値を差し込むと、外側だけ英語で中身が
 * 日本語の混ざった文になる (WI-7 で実際に 6 箇所そうなっていた)。辞書のキーは
 * 揃っているので `ai-resolution` でも、面のキーを数える上の検査でも捕まらない。
 *
 * ここは**呼び出しの形**を見る: これらを呼ぶなら翻訳関数を渡すこと。
 */
const MUST_PASS_TRANSLATOR = [
  "formatReasoningEffortLabel",
  "overlayShapeNoun",
  "describeRevertBlockedReason",
  "getReferenceDisplayLabel",
  "aiRunStatusLabel",
  "formatAgentActivityLabel",
  "summarizeRunningActivity",
  "getAiEditInlinePreviewTitle",
  "getAiEditOverlayApprovalTitle",
  "createChatRoomTitle",
  "createEmptyChatRoom",
  "buildAppliedDiffRows",
  "flattenBlockLines",
  // ここから下はシェルが呼ぶ側。**渡し忘れると AI 適用後の状態通知が丸ごと日本語になる**
  // (WI-7 の code-review で実際に 11 箇所そうなっていた)。
  "summarizeAiEditPreviewChanges",
  "groupMcpProposalsForPreview",
  "buildAppliedTurnChangesByTurnId",
  "deriveCommentAiRunEligibility",
  "deriveAiProposalBusyGuardFeedback",
  "deriveAiProposalApplyDecision",
  "deriveAiProposalApprovedFileFeedback",
  "deriveAiProposalDismissEffects",
  "deriveAiStaleProposalDiscardEffects",
  "deriveAiReferenceRequestPlan",
  "buildAiOverlayEditorExtensions",
] as const;

describe("display helpers that default to Japanese", () => {
  it("always receive a translator from the AI surfaces", () => {
    const bare: string[] = [];
    for (const file of Object.keys(SURFACES)) {
      const source = read(file);
      for (const name of MUST_PASS_TRANSLATOR) {
        for (const match of source.matchAll(new RegExp(`(?<![A-Za-z0-9_.])${name}\\(`, "gu"))) {
          const lineStart = source.lastIndexOf("\n", match.index) + 1;
          const line = source.slice(lineStart, source.indexOf("\n", match.index));
          // 宣言そのものと、コメント中の言及は対象外。
          if (/^\s*(export\s+)?(function|const)\s/u.test(line) || /^\s*(\/\/|\*)/u.test(line)) {
            continue;
          }
          const argument = callArgument(source, match.index + match[0].length - 1);
          // 最後の引数が `t` のときは閉じ括弧が `argument` に含まれないので行末も許す。
          // `foo(x, t)` と `foo({ …, t: tAi })` の両方を「渡している」と数える。
          if (!/(?<![A-Za-z0-9_])t[A-Za-z0-9_]*\s*(?:[,)]|$)/u.test(argument)
            && !/(?<![A-Za-z0-9_])t(?:Ai|Editor)?\s*:/u.test(argument)) {
            bare.push(`${file}: ${name}(${argument.slice(0, 60)})`);
          }
        }
      }
    }
    expect(bare, "翻訳関数を渡していない呼び出し").toEqual([]);
  });
});
