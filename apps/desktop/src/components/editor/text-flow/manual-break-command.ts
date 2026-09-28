/**
 * 「キャレットの位置で改ページ (改段)」をフォーカス中の本文エディタへ頼む合図。
 * コマンドパレット・再割り当てしたショートカットから出す。本文エディタは自分のキャレットを
 * SigmaDoc の位置へ直してホストに渡し、ホストが文書全体を見て区切りを入れる。
 */
export const INSERT_MANUAL_BREAK_EVENT = "sigma-studio:insert-manual-break";
