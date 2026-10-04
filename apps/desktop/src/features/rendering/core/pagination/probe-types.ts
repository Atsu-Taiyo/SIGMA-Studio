/**
 * 自然配置の計測結果。DOM から読んだ値を、ページ割りが与えた変位を差し引いた
 * **自然座標** (ズーム除去済み、`.page-flow` の border box 左上が原点) で持つ。
 *
 * ここは DOM に依存しない純データで、`buildFlowModel` がこれを行モデルへ変換する。
 * 計測はページ割りの結果に左右されない (変位は兄弟のレイアウトに影響しない相対配置の
 * ずらしで与え、計測はそれを差し引く) ので、同じ文書は常に同じ ProbeTree になる。
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
  /**
   * 編集面の最上位ブロック (ProseMirror の直下) の sigmaDocId。拡張ノードは
   * `data-flow-extension-node-id` の値。
   */
  id: string;
  /**
   * - `block` (既定): 編集面の最上位ブロック。
   * - `extension`: 本文ブロックの後ろに機能が差し込む要素 (フロー内の拡張ノード)。どの入れ物にも
   *   属さない独立した行で、自分の矩形 (border box) を見える縁として最初と最後の行に持つ。
   *   手動改ページ・付属物 (問題番号) は持たない。
   */
  kind?: "block" | "extension";
  rect: ProbeRect;
  ink: readonly ProbeInk[];
  chrome: readonly ProbeChromeBox[];
  /** このブロックの前で手動改ページ (改段) する。 */
  breakBefore: boolean;
  /**
   * ブロックの内側 (引用・箱などの子) にある手動改ページ。その位置でブロックを分割して次の
   * ページ (段) から続ける。最初の行より前にある区切りはブロック自身の前の区切りとして扱う。
   */
  innerBreaks?: readonly ProbeInnerBreak[];
}

export interface ProbeInnerBreak {
  /** 区切りを持つ子の上端 (自然座標)。続きはここから描く。 */
  top: number;
  /**
   * 区切りの前の内容の終わり = 子の前に描かれる改ページの印の上端。印を描かない面 (PDF) は
   * ここで前の片を切る (印の場所を入れ物の縦線・枠の中の空白として残さない)。
   */
  contentEnd: number;
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
  /** 編集面の最上位ブロックと拡張ノード (文書順)。 */
  nodes: readonly ProbeNode[];
  /** 独立段組 (layoutSection) の各列。あるときは `nodes` は空。 */
  columns?: readonly ProbeColumn[];
  /** ユニットに直接属する付属物 (問題番号)。重なる行に吸収される。 */
  attachments: readonly ProbeInk[];
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
