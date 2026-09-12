/**
 * 選択図形プレビューの添付ファイル名。
 *
 * **これは UI 文言ではなく、モデルと交わしている取り決め**なので翻訳しない。
 * `ai-edit-reference.ts` が組み立てるプロンプトが「選択図形プレビュー-*.png」という
 * 名前で添付されると明言していて、パネル側は同じ名前から図形の件数を読み戻す。
 * 訳した瞬間にプロンプトの記述と食い違い、件数の読み取りも外れる。
 *
 * 画面に出る見出しはこの名前から**別に組み立てる** (`ai.attachment.*`)。
 */
export const SELECTED_SHAPES_ATTACHMENT_PREFIX = "選択図形プレビュー-";

/**
 * `選択図形プレビュー-3件.png` → 3。この名前で作られた添付でなければ null。
 *
 * **これは見た目の手掛かりであって、由来の証明ではない。** 利用者が同じ名前のファイルを
 * 添付すれば、アプリが作ったプレビューと同じ見出しで表示される (表示だけの成りすましで、
 * 実害は無い)。桁数を絞ってあるのは、`99999999999999999999件` のような名前がそのまま
 * 画面に出るのを防ぐため。由来を厳密に見分けたいなら、名前ではなく添付そのものに
 * 印を持たせること。
 */
export function parseSelectedShapesAttachmentCount(name: string): number | null {
  const matched = new RegExp(`^${SELECTED_SHAPES_ATTACHMENT_PREFIX}(\\d{1,4})件(?:\\.[^.]+)?$`, "u").exec(name);
  const parsed = matched ? Number(matched[1]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** 名前に入れる件数の上限。**parser の桁数と必ず揃えること** (揃わないと読み戻せない)。 */
const MAX_NAMED_SHAPE_COUNT = 9999;

/** 添付として送る名前を作る。拡張子は呼び出し側が足す。 */
export function buildSelectedShapesAttachmentName(shapeCount: number): string {
  const clamped = Math.min(MAX_NAMED_SHAPE_COUNT, Math.max(1, Math.trunc(shapeCount)));
  return `${SELECTED_SHAPES_ATTACHMENT_PREFIX}${clamped}件`;
}
