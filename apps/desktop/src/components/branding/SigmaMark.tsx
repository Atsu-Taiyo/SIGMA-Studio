import styles from "./SigmaMark.module.css";

/**
 * アプリアイコン (`build/icon.svg`) の Σ。座標系も同じで、字形は x 230..779 / y 179..822。
 * アイコンの字形を変えるときは icon.svg とここを揃える (SigmaMark.test.tsx が突き合わせる)。
 */
export const SIGMA_MARK_PATH =
  "M230 179 H779 V326 L711 258 H373 L615.5 500.5 L373 743 H711 L779 675 V822 H230 V759 L488.5 500.5 L230 242 Z";

interface SigmaMarkProps {
  /** タイルの一辺 (px)。 */
  size?: number;
  className?: string;
}

/** アプリアイコンと同じ、黒い角丸タイルに白い Σ。ワークスペースと編集画面の左上で使う。 */
export function SigmaMark({ size = 34, className }: SigmaMarkProps) {
  return (
    <span
      className={className ? `${styles.mark} ${className}` : styles.mark}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="230 179 549 643" xmlns="http://www.w3.org/2000/svg" className={styles.glyph}>
        <path d={SIGMA_MARK_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}
