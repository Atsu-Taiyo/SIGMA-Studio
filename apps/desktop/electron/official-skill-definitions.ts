/**
 * アプリ同梱の公式スキルの定義(canonicalなAI向けメタデータ)。
 *
 * ここの日本語は保存され、そのままモデルの文脈に入る。表示言語では変えない
 * (画面に出す名前だけが `lib/ai/ai-resource-display.ts` で翻訳される)。
 * `description` は各SKILL.mdのfrontmatterと同じ文にする (official-skills.test.ts が確かめる)。
 * 本文は SKILL_CONTENT_MAX_LENGTH 以内にする。
 */

/* eslint-disable no-restricted-syntax -- Canonical AI-facing metadata is persisted and must not follow the UI locale. */

export const OFFICIAL_IMAGE_MATERIAL_SKILL_ID = "official-image-material";
export const OFFICIAL_GRAPH_SKILL_ID = "official-graph";
export const OFFICIAL_SVG_FIGURE_SKILL_ID = "official-svg-figure";

export interface OfficialSkillDefinition {
  id: string;
  title: string;
  sourcePath: string;
  description: string;
  tags: string[];
  bundledPath: string;
}

export const OFFICIAL_SKILL_DEFINITIONS: readonly OfficialSkillDefinition[] = [
  {
    id: OFFICIAL_SVG_FIGURE_SKILL_ID,
    title: "図・イラストをSVGで挿入する",
    sourcePath: "skills/sigma-svg-figure/SKILL.md",
    description: "図・図解・模式図・イラスト・挿絵・フローチャート・幾何の作図・物理や化学の図を、静的SVG1枚として教材へ挿入・修正するときに使う。画像や図が必要になったら最初に検討する。",
    tags: ["SVG", "図解", "イラスト", "挿絵"],
    bundledPath: "sigma-svg-figure/SKILL.md",
  },
  {
    id: OFFICIAL_IMAGE_MATERIAL_SKILL_ID,
    title: "画像からSigma Studio教材を作成",
    sourcePath: "skills/sigma-image-material-reconstruction/SKILL.md",
    description: "画像、写真、スクリーンショット、手書きラフ、PDFの1ページを基に、本文・数式・問題・表・グラフ・図を編集可能なSigma Studio教材として再構成するときに使う。",
    tags: ["画像", "教材再構成", "OCR", "図解"],
    bundledPath: "sigma-image-material-reconstruction/SKILL.md",
  },
  {
    id: OFFICIAL_GRAPH_SKILL_ID,
    title: "グラフを挿入・更新する",
    sourcePath: "skills/sigma-graph-editing/SKILL.md",
    description: "Sigma Studio教材で関数グラフ、座標平面、数直線、不等式の領域図を挿入・更新し、軸・曲線・点・ラベルまで検証するときに使う。座標で値や関係を読ませる図が対象。",
    tags: ["グラフ", "Graph2D", "関数", "座標"],
    bundledPath: "sigma-graph-editing/SKILL.md",
  },
  {
    id: "official-graph3d",
    title: "立体（3Dグラフ）を挿入・更新する",
    sourcePath: "skills/sigma-graph3d-editing/SKILL.md",
    description: "立体・回転体・曲面・断面・立体どうしの共通部分を3Dグラフとして教材へ挿入・更新するときに使う。空間座標、球・円柱・円錐・多面体、回転体の体積の図が対象。",
    tags: ["3D", "立体", "回転体", "断面"],
    bundledPath: "sigma-graph3d-editing/SKILL.md",
  },
  {
    id: "official-problem",
    title: "問題・解答・解説を作成・更新する",
    sourcePath: "skills/sigma-problem-authoring/SKILL.md",
    description: "問題文・導入文・解答・解説・ヒント（コメント）をSigmaDocの problem として作成・更新するときに使う。問題の追加、解説の書き足し、小問の構成、既存問題の一部修正が対象。",
    tags: ["問題", "解答", "解説", "ヒント"],
    bundledPath: "sigma-problem-authoring/SKILL.md",
  },
  {
    id: "official-body",
    title: "本文・数式・囲み枠を書く",
    sourcePath: "skills/sigma-body-authoring/SKILL.md",
    description: "見出し・段落・箇条書き・数式・囲み枠・コードなど、教材の本文を新しく書く、または既存の文章を最小の差分で直すときに使う。書式（フォント・文字サイズ・囲み）の変更や本文の並べ替えも含む。",
    tags: ["本文", "数式", "箇条書き", "囲み枠"],
    bundledPath: "sigma-body-authoring/SKILL.md",
  },
  {
    id: "official-table",
    title: "表・増減表を挿入・更新する",
    sourcePath: "skills/sigma-table-editing/SKILL.md",
    description: "教材に表や増減表を挿入・更新するときに使う。対応表、集計表、値の一覧、関数の増減表の作成と、既存の表のセル単位の修正が対象。",
    tags: ["表", "増減表", "セル"],
    bundledPath: "sigma-table-editing/SKILL.md",
  },
  {
    id: "official-page-layout",
    title: "ページ設定・段組み・改ページを整える",
    sourcePath: "skills/sigma-page-layout/SKILL.md",
    description: "教材の用紙サイズ・向き・余白・段組み（文書全体または本文の一部）・改ページ／改段を変更するときに使う。A4からB5への変更、横向き、2段組み、本文の途中だけ段組み、次のページから始める指定が対象。",
    tags: ["ページ", "段組み", "改ページ", "余白"],
    bundledPath: "sigma-page-layout/SKILL.md",
  },
  {
    id: "official-proofreading",
    title: "校正・言い換え・表記ゆれを直す",
    sourcePath: "skills/sigma-proofreading/SKILL.md",
    description: "教材の誤字脱字・表記ゆれ・文体の不統一・言い回しを、既存の書式や数式を壊さずに最小の差分で校正・言い換えるときに使う。選択範囲だけ、または教材全体の校正が対象。",
    tags: ["校正", "言い換え", "表記ゆれ"],
    bundledPath: "sigma-proofreading/SKILL.md",
  },
  {
    id: "official-shape",
    title: "図形・矢印・注記を編集する",
    sourcePath: "skills/sigma-shape-editing/SKILL.md",
    description: "個別に動かせる図形・矢印・補助線・吹き出し・文字注記（TeX数式つき）を挿入・更新・整列するとき、SVG図やグラフの上に数式ラベルを重ねるとき、既存の図形やSVG画像の位置・大きさを直すときに使う。",
    tags: ["図形", "矢印", "注記", "吹き出し"],
    bundledPath: "sigma-shape-editing/SKILL.md",
  },
  {
    id: "official-material-library",
    title: "素材・過去教材・公開問題を再利用する",
    sourcePath: "skills/sigma-material-library/SKILL.md",
    description: "保存済みの素材、過去の教材、メンションされた教材、公開されている問題を探して、再利用・参照するときに使う。ゼロから作る前に似たものがないか確かめたいとき、過去の教材の作りに合わせたいときが対象。",
    tags: ["素材", "過去教材", "検索"],
    bundledPath: "sigma-material-library/SKILL.md",
  },
  {
    id: "official-document-management",
    title: "教材・フォルダを作成・整理する",
    sourcePath: "skills/sigma-document-management/SKILL.md",
    description: "教材ライブラリの中で、教材やフォルダを新規作成・名前変更・移動・削除するときに使う。教材の整理、フォルダ分け、新しい教材ファイルの用意が対象。本文の編集は含まない。",
    tags: ["教材管理", "フォルダ", "整理"],
    bundledPath: "sigma-document-management/SKILL.md",
  },
];
