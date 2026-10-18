export interface MeasureFrameScheduler {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
}

export interface SettlingMeasureScheduler {
  /**
   * Ask for a measurement. Several requests in one frame collapse into a single pass.
   * `documentChanged`: the request comes from a document change (not from the measurement's own
   * dispatch), so it must not be lost when it lands inside the measuring window.
   */
  refresh: (options?: { documentChanged?: boolean }) => void;
  destroy: () => void;
}

/** 「装飾が入った DOM を読み直す」ための追いパスは 1 回で足りる。 */
const MAX_OWED_PASSES = 1;
/** 計測窓の内側で取りこぼした文書の変更を、依頼が途絶えてから拾い直すまでのフレーム数 (約 130ms)。 */
const MISSED_CHANGE_IDLE_FRAMES = 8;

const animationFrames: MeasureFrameScheduler = {
  request: (callback) => window.requestAnimationFrame(() => callback()),
  cancel: (id) => window.cancelAnimationFrame(id),
};

/**
 * DOM 計測の依頼をフレームでまとめ、計測直後の 2 フレームを「計測窓」として扱うスケジューラ。
 *
 * 計測窓の内側に来た依頼は捨てる。計測が自分で起こした変化 (装飾の dispatch とそれによる DOM
 * 変化) を新しい依頼として取り込み続ける自己再帰を止めるためで、外から来た依頼も次の更新で
 * 拾い直せる。
 *
 * ただし**計測自身が「もう 1 パス要る」と言った時だけは、窓が閉じた直後に 1 回だけ回す**。
 * 「1 回だけ」は上限であって申告の言い値ではない: 申告が永久に true のままになる DOM
 * (解決できない入れ物など) があると、外から何も起きていないのに 3 フレームごとの強制レイアウトが
 * 回り続けてしまう。
 * 「1 パス目の装飾が入った DOM からしか読めない」値 (囲み枠) はこれが無いと永久に来ない —
 * 2 パス目を呼べる合図は必ず窓の内側に着くからである。以前は検索語の再通知や毎レンダーの装飾
 * 更新といった無関係な transaction がたまたま 2 パス目を回していた。判定を計測側に委ねるのは、
 * 「窓の内側の依頼を全部覚える」方式だと連続入力で常に 2 倍のパスを踏むため (実測: 20 文字の
 * 連打が 14ms/文字 → 33ms/文字)。
 *
 * 窓の内側に着いた**文書の変更** (`documentChanged`) だけは捨てきらない。「次の更新で拾い直せる」は
 * 次の更新が来るときだけ正しく、選択バーのメニューで囲みの種類を替えた直後のように、その後に何も
 * 起きないと古い計測 (割れた枠) のまま止まる。すぐには回さず、依頼が `MISSED_CHANGE_IDLE_FRAMES`
 * 途絶えてから 1 回だけ回す。連続入力の途中では次の依頼が普通にパスを回すので、パスは増えない。
 *
 * @param measure 計測本体。`true` を返すと「もう 1 パス要る」の意味になる。
 */
export function createSettlingMeasureScheduler(
  measure: () => boolean | void,
  frames: MeasureFrameScheduler = animationFrames,
): SettlingMeasureScheduler {
  let measuring = false;
  let destroyed = false;
  let owesAnotherPass = false;
  /** 外からの依頼 1 回につき、計測が自分で自分を呼べる回数。 */
  let owedPassesLeft = 0;
  let measureFrameId: number | null = null;
  let releaseFrameId: number | null = null;
  let settleFrameId: number | null = null;
  /** 計測窓の内側に着いて、まだどのパスも読んでいない文書の変更があるか。 */
  let missedDocumentChange = false;
  let idleFrameId: number | null = null;
  let idleFramesLeft = 0;

  const refresh = (options?: { documentChanged?: boolean }) => {
    owedPassesLeft = MAX_OWED_PASSES;
    if (measuring && options?.documentChanged) {
      missedDocumentChange = true;
    }
    scheduleMeasure();
  };

  const cancelIdleWait = () => {
    if (idleFrameId !== null) {
      frames.cancel(idleFrameId);
      idleFrameId = null;
    }
  };

  const waitForIdleThenMeasure = () => {
    idleFramesLeft = MISSED_CHANGE_IDLE_FRAMES;
    if (idleFrameId !== null) {
      return;
    }
    const tick = () => {
      idleFrameId = null;
      if (destroyed || !missedDocumentChange) {
        return;
      }
      idleFramesLeft -= 1;
      if (idleFramesLeft > 0) {
        idleFrameId = frames.request(tick);
        return;
      }
      owedPassesLeft = MAX_OWED_PASSES;
      scheduleMeasure();
    };
    idleFrameId = frames.request(tick);
  };

  const scheduleMeasure = () => {
    if (destroyed || measuring) {
      return;
    }
    if (measureFrameId !== null) {
      return;
    }
    // このパスは最新の文書を読むので、取りこぼした変更はもう無い。
    missedDocumentChange = false;
    cancelIdleWait();
    measureFrameId = frames.request(() => {
      measureFrameId = null;
      measuring = true;
      owesAnotherPass = false;
      try {
        owesAnotherPass = measure() === true;
      } finally {
        releaseFrameId = frames.request(() => {
          releaseFrameId = null;
          settleFrameId = frames.request(() => {
            settleFrameId = null;
            measuring = false;
            if (owesAnotherPass && owedPassesLeft > 0) {
              owesAnotherPass = false;
              owedPassesLeft -= 1;
              scheduleMeasure();
            } else if (missedDocumentChange) {
              waitForIdleThenMeasure();
            }
          });
        });
      }
    });
  };

  return {
    refresh,
    destroy: () => {
      destroyed = true;
      for (const id of [measureFrameId, releaseFrameId, settleFrameId, idleFrameId]) {
        if (id !== null) {
          frames.cancel(id);
        }
      }
      measureFrameId = null;
      releaseFrameId = null;
      settleFrameId = null;
      idleFrameId = null;
      missedDocumentChange = false;
      owesAnotherPass = false;
      owedPassesLeft = 0;
      measuring = false;
    },
  };
}
