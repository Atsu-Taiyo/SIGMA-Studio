/**
 * 却下理由をエージェントへ返す指示文。
 *
 * **これは画面に出ない文言で、モデルへ渡るプロンプト**なので `ai` namespace
 * (AI 編集 UI) には入れない。WI-7 が UI 文言を辞書へ移したときも、ここだけは
 * 日本語のまま据え置いてある — プロンプトの言語をどうするか (教材の言語に合わせるのか、
 * UI の言語に合わせるのか) は WI-8 の D2 が決めることで、UI と同じ判断ではないため。
 *
 * 多言語化するときは `prompt` namespace へ移すこと。この 1 関数だけを別ファイルに
 * してあるのは、`ai-run-controller.ts` を「未翻訳の日本語」検査の対象に入れたまま
 * にするため (あちらはもう UI 文言を持っていない)。
 */
export function buildRejectionFeedbackInstruction(reason: string, proposalSummaries: string[]): string {
  const target = proposalSummaries.map((summary) => summary.trim()).filter(Boolean).join(" / ") || "対象の編集案";
  return `ユーザーが提案を却下しました。理由: ${reason.trim()}。対象: ${target}。理由を踏まえて修正した提案を作り直してください。`;
}
