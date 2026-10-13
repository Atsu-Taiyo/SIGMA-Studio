/**
 * PDF に写す 1 ページの文書で、使っているフォントが読み込み終わるまで待つ。
 *
 * フォントは、それを使う文字が描かれる (スタイルとレイアウトが解かれる) ときに初めて読み込みが
 * 始まる。`document.write` の直後はまだ何も描いていないので、その時点の `document.fonts.ready` は
 * 読み込みが始まる前に解決しうる。数式のフォント (KaTeX / MathLive) は届くまで字を描かない設定
 * なので、印刷に間に合わないと数式が欠けたり別の字形になったりする。先にレイアウトさせてから、
 * 読み込み中のフォントが無くなるまで待つ (ファイルの読み込みが遅い環境ほど効く)。
 *
 * 読み込みが終わらない (`fonts.ready` が解決しない) ときは、時間の上限で `timeoutMessage` の
 * エラーにして書き出しを止める。読み終わらないまま印刷すると、数式の崩れた PDF が黙って出るため。
 *
 * 書き出し用のウィンドウの中で main プロセスが評価するので文字列で持つ。テストもこの同じ文字列を動かす。
 */
export const SETTLE_DOCUMENT_FONTS_SOURCE = `((doc, maxRounds, timeoutMs, timeoutMessage) => {
  const fonts = doc.fonts;
  if (!fonts) return Promise.resolve(0);
  const nextFrame = () => new Promise((resolve) => {
    const view = doc.defaultView;
    if (view && typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
  const settle = (round) => {
    if (doc.body) doc.body.getBoundingClientRect();
    return Promise.resolve(fonts.ready).then(nextFrame).then(() => {
      if (doc.body) doc.body.getBoundingClientRect();
      const loading = Array.from(fonts).some((face) => face.status === "loading");
      return loading && round + 1 < maxRounds ? settle(round + 1) : round + 1;
    });
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    settle(0).then(
      (rounds) => { clearTimeout(timer); resolve(rounds); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
})`;

/** 待つ回数の上限。読み込みが次々に始まり続けても、そこで待つのをやめて印刷へ進む。 */
export const SETTLE_DOCUMENT_FONTS_MAX_ROUNDS = 20;

/** 1 ページで待つ時間の上限 (ミリ秒)。2 ページ目からはフォントが読み込み済みなので、ほぼ待たない。 */
export const SETTLE_DOCUMENT_FONTS_TIMEOUT_MS = 20_000;
