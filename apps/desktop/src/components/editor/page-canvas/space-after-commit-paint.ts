import type { SpaceAfterCommit, SpaceAfterDragSession } from "./space-after-drag-session";

interface SpaceAfterCommitPaintPorts {
  getCanvas(): HTMLElement | null;
  getFlow(): HTMLElement | null;
  onFinished(commit: SpaceAfterCommit, painted: boolean): void;
}

/** Watch the same committed DOM write that removes the translation, before the next paint. */
export function waitForSpaceAfterCommitPaint(
  session: SpaceAfterDragSession,
  { getCanvas, getFlow, onFinished }: SpaceAfterCommitPaintPorts,
): void {
  // **世代の錠**。掴み直し → 即離しで待ちが 2 つ重なると、参照先の ref は 1 つしかないので
  // 前の待ちが新しい確定を「届かなかった」と判定して外しかねない。自分が始めた確定だけを
  // 見る (ref が別物になっていたら、その待ちはもう自分のものではない)。
  const owned = session.pendingCommit;
  if (!owned) {
    return;
  }
  let frames = 0;
  let observer: MutationObserver | null = null;
  let frame: number | null = null;
  let timeout: number | null = null;

  const cleanup = () => {
    observer?.disconnect();
    observer = null;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    if (timeout !== null) {
      window.clearTimeout(timeout);
      timeout = null;
    }
  };

  const isPainted = (): boolean => {
    const element = getCanvas()?.querySelector<HTMLElement>(
      `.page-flow [data-sigma-doc-id="${CSS.escape(owned.blockId)}"]`,
    );
    return element
      ? Math.abs(Number.parseFloat(window.getComputedStyle(element).paddingBottom || "0") - owned.px) < 1
      : false;
  };

  const finish = (painted: boolean) => {
    cleanup();
    session.finishCommit();
    onFinished(owned, painted);
  };

  /** この待ちがまだ有効か (自分の確定が生きているか)。 */
  const stillOwns = (): boolean => {
    if (session.ownsCommit(owned)) {
      return true;
    }
    // 別の確定に差し替わった / 破棄された。後始末だけして手を引く。
    cleanup();
    return false;
  };

  const check = () => {
    if (stillOwns() && isPainted()) {
      finish(true);
    }
  };

  const flow = getFlow();
  if (flow && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(check);
    // 面がノードごと作り直すこともあるので、属性だけでなく子の入れ替えも見る。
    observer.observe(flow, {
      attributeFilter: ["style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  const step = () => {
    frame = null;
    if (!stillOwns()) {
      return;
    }
    frames += 1;
    if (isPainted()) {
      finish(true);
      return;
    }
    if (frames >= MAX_SPACE_AFTER_COMMIT_FRAMES) {
      // 届かないまま終わった (AI ロック等でコミットが弾かれた)。プレビューは残さない。
      finish(false);
      return;
    }
    frame = window.requestAnimationFrame(step);
  };
  frame = window.requestAnimationFrame(step);
  // rAF はタブが背面に回ると止まる。それだけを頼りにすると、離した直後に別タブへ移った
  // ときプレビューと凍結が残り、戻るまで外因の再ページ割りも効かなくなる。時計側にも
  // 打ち切りを置いて、背面でも必ず畳む。
  timeout = window.setTimeout(() => {
    timeout = null;
    if (stillOwns()) {
      finish(isPainted());
    }
  }, MAX_SPACE_AFTER_COMMIT_WAIT_MS);
}

/**
 * 確定した余白が描かれるのを待つ上限 (フレーム)。実測では 1〜2 フレームで届く。ここまで
 * 待って届かないときは弾かれた (AI ロック等) とみなし、プレビューを残さず畳む。
 */
const MAX_SPACE_AFTER_COMMIT_FRAMES = 12;

/**
 * フレームが止まる環境 (背面タブ) でも確実に畳むための時計側の打ち切り。
 *
 * rAF だけに頼ると、離した直後にタブを裏へ回されたときプレビューと再計測の凍結が残り、
 * 戻るまでページ割りが更新されなくなる。
 */
const MAX_SPACE_AFTER_COMMIT_WAIT_MS = 1000;
