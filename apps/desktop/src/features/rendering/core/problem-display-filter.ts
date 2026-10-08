import type { ProblemAreaKind } from "@/features/document";

/**
 * 問題を「どこまで見せるか」。教材には書き込まない、表示だけの絞り込み。
 *
 * 利用者の言葉は 問題 / 解答 / コメント の3つ。`lead` (導入文) は問題文と一続きに読むものなので
 * `problem` に含める。`hints` は画面で「コメント」と呼ぶ領域。
 */
export type ProblemDisplayPart = "problem" | "solution" | "hints";

export type ProblemDisplayFilter = Readonly<Record<ProblemDisplayPart, boolean>>;

/** メニューに並べる順。 */
export const PROBLEM_DISPLAY_PARTS: readonly ProblemDisplayPart[] = ["problem", "solution", "hints"];

/** 何も絞らない = いつもの表示。 */
export const FULL_PROBLEM_DISPLAY: ProblemDisplayFilter = Object.freeze({
  problem: true,
  solution: true,
  hints: true,
});

export function problemDisplayPartOf(area: ProblemAreaKind): ProblemDisplayPart {
  return area === "hints" ? "hints" : area === "solution" ? "solution" : "problem";
}

export function isProblemAreaDisplayed(filter: ProblemDisplayFilter, area: ProblemAreaKind): boolean {
  return filter[problemDisplayPartOf(area)];
}

/** 1つでも隠していれば true。 */
export function isProblemDisplayFiltered(filter: ProblemDisplayFilter): boolean {
  return PROBLEM_DISPLAY_PARTS.some((part) => !filter[part]);
}

/**
 * 1つ切り替える。最後の1つは外せない: 全部隠すと問題が紙面から消え、何も無い画面になる。
 * 外せないときは同じ filter をそのまま返す (呼び出し側は state が変わらないので再描画もしない)。
 */
export function toggleProblemDisplayPart(
  filter: ProblemDisplayFilter,
  part: ProblemDisplayPart,
): ProblemDisplayFilter {
  if (filter[part] && PROBLEM_DISPLAY_PARTS.filter((candidate) => filter[candidate]).length === 1) {
    return filter;
  }
  return { ...filter, [part]: !filter[part] };
}
