export interface MeasureFrameScheduler {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
}

export interface SettlingMeasureScheduler {
  /** Ask for a measurement. Several requests in one frame collapse into a single pass. */
  refresh: () => void;
  destroy: () => void;
}

/** 「装飾が入った DOM を読み直す」ための追いパスは 1 回で足りる。 */
const MAX_OWED_PASSES = 1;

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

  const refresh = () => {
    owedPassesLeft = MAX_OWED_PASSES;
    scheduleMeasure();
  };

  const scheduleMeasure = () => {
    if (destroyed || measuring) {
      return;
    }
    if (measureFrameId !== null) {
      return;
    }
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
      for (const id of [measureFrameId, releaseFrameId, settleFrameId]) {
        if (id !== null) {
          frames.cancel(id);
        }
      }
      measureFrameId = null;
      releaseFrameId = null;
      settleFrameId = null;
      owesAnotherPass = false;
      owedPassesLeft = 0;
      measuring = false;
    },
  };
}
