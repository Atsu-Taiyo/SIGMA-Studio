/**
 * 自然配置の計測結果。DOM から読んだ値を、ページ割りが与えた変位を差し引いた
 * **自然座標** (ズーム除去済み、`.page-flow` の border box 左上が原点) で持つ。
 *
 * ここは DOM に依存しない純データで、`buildFlowModel` がこれを行モデルへ変換する。
 * 計測はページ割りの結果に左右されない (変位はレイアウトに影響しない `translate` で
 * 与え、計測はそれを差し引く) ので、同じ文書は常に同じ ProbeTree になる。
 */
export interface ProbeRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/** 紙面に描かれる中身の縦区間。行ボックスの文字・行内原子・空行・付属物。 */
export interface ProbeInk {
  top: number;
  bottom: number;
  /**
   * - `text`: 文字列の行片
   * - `atom`: 行内数式・囲み枠などの分割できない行内要素 (子孫の矩形ではなく全体を 1 つ)
   * - `empty`: 空段落・コードの空行
   * - `object`: 区切り線・画像など分割できないブロック
   * - `title`: 文字のある箱タイトル
   */
  kind: "text" | "atom" | "empty" | "object" | "title";
}

/**
 * 上下に**見える**縁 (枠線・背景・タイトル帯) を持つ入れ物。開き側は最初の行と、
 * 閉じ側は最後の行と一緒に収める。見えない padding / margin はここに入れない。
 */
export interface ProbeChromeBox {
  id: string;
  top: number;
  bottom: number;
}

export interface ProbeNode {
  /** 編集面の最上位ブロック (ProseMirror の直下) の sigmaDocId。 */
  id: string;
  rect: ProbeRect;
  ink: readonly ProbeInk[];
  chrome: readonly ProbeChromeBox[];
  /** このブロックの前で手動改ページ (改段) する。 */
  breakBefore: boolean;
  /**
   * ブロックの内側にある手動改ページの位置 (自然座標)。箱の中の子に保存された旧来の
   * 改ページで、その位置でブロックを分割して次のページ (段) から続ける。
   */
  innerBreaks?: readonly number[];
}

export interface ProbeColumn {
  index: number;
  rect: ProbeRect;
  nodes: readonly ProbeNode[];
}

export interface ProbeUnit {
  /** フロー直下のユニットの id。変位を受け持つ外側の要素。 */
  id: string;
  rect: ProbeRect;
  span: "column" | "full";
  /** ユニット単位の手動改ページ (問題そのものに付いた改ページなど)。 */
  breakBefore: boolean;
  /** 編集面の最上位ブロック (文書順)。 */
  nodes: readonly ProbeNode[];
  /** 独立段組 (layoutSection) の各列。あるときは `nodes` は空。 */
  columns?: readonly ProbeColumn[];
  /** ユニットに直接属する付属物 (問題番号)。重なる行に吸収される。 */
  attachments: readonly ProbeInk[];
  /** 編集面の外にある分割できない中身 (拡張の差し込み等)。 */
  objects: readonly ProbeInk[];
  /** ユニットの枠 (枠付き問題文)。複数ユニットにまたがる枠は同じ key を持つ。 */
  frame?: {
    key: string;
    first: boolean;
    last: boolean;
    top: number;
    bottom: number;
    /** 枠片はユニットの padding box 基準で置くので、ユニット自身の枠線幅を持つ。 */
    borderLeft: number;
    borderTop: number;
  };
  /** 最小高さで確保された空白 (中身の下端からユニット下端まで)。 */
  reservation?: { top: number; bottom: number };
  /** 未展開の大量貼り付けなど、中身を持たない概算の空白ユニット。 */
  placeholder?: boolean;
}

export interface ProbeTree {
  units: readonly ProbeUnit[];
}
