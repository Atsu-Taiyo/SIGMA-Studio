# SigmaDoc Schema

## Current Version

現在の保存形式は `SigmaDoc` version `2.0` です。

`SigmaDoc` は教材データの正本です。Tiptap JSON、HTML、TeX全文、SVG、PDF、編集UIの一時状態は正本にしません。通常の検証と保存は `src/lib/sigma-doc-schema.ts` の `parseSigmaDocument` を使い、ファイル読み込みだけは `recoverSigmaDocument` で局所的に壊れた要素を除外した後、最後に同じ厳格schemaを通します。編集・保存前には `src/lib/page-layout.ts` の `ensurePageLayout` で `pageLayout` を正規化します。

デスクトップ版では、Electron main process が管理するローカルlibrary内の `documents/<fileId>.sigmadoc.json` にSigmaDoc JSONを保存します。`workspace`、`folder`、`file`、revision、asset参照は文書管理メタデータであり、SigmaDoc本体とは役割を分けます。`fileId` はローカルlibrary上のファイル管理ID、`docId` はSigmaDoc内部IDです。provider固有のtable名、bucket名、policy名はSigmaDoc JSONへ保存しません。

`2.0` の大きな変更点は、本文フローに `list` / `listItem`、`layoutSection`、`boxBlock` をfirst-class nodeとして持つことです。箇条書き・番号付きリスト・入れ子リストは、見た目の記号を付けた段落ではなく、SigmaDocの構造として保持します。単純なTeX風の箱はoverlay図形ではなく `boxBlock` と `BoxFrameSpec` に保存します。コメント、コメントリアクション、問題エリアレイアウト、問題番号、ページ設定、running region、単一の連続overlay snapshotも現行schemaの一部です。本文は `content` の論理順だけを持ち、ページごと、段ごと、図形ごとに分割しません。

読み込みルールは次の扱いです。

- `version: "2.0"` だけを受け付けます。
- `1.x` は受け付けません。読み込み時の移行処理は持ちません。
- 本文ブロック、文中要素、コメント、overlay shape/assetは個別検証し、読めない1件だけを除外して残りを開きます。
- `version`、`docId`、`metadata`、`content`配列、`outputProfiles` などの必須構造が壊れている場合は復旧せず、文書全体の読み込みを中止します。
- 局所復旧が発生したローカル教材は、自動保存前に原文JSONを `data/recovery/` へ保護します。
- 未定義フィールドは、正規データとして保持しません。

## Source Files

schema確認時は次の実装を正とします。

- `src/types/sigma-doc.ts`: 永続データのTypeScript型
- `src/lib/sigma-doc-schema.ts`: Zodによる読み込み検証
- `src/lib/page-layout.ts`: pageLayoutの既定値、正規化、ページメトリクス、ページ分割
- `src/lib/box-blocks.ts`: built-in box style、`BoxFrameSpec` の解決、CSS変数への変換
- `src/lib/print-renderer.ts`: 出力profileごとの本文とoverlayの表示可否
- `src/components/editor/overlay-canvas/types.ts`: overlaySnapshot、shape、table shapeの型
- `src/components/editor/overlay-canvas/store.ts`: overlaySnapshotとshapeの実行時検証

## Top Level

```ts
interface SigmaDocument {
  version: "2.0";
  docId: string;
  metadata: SigmaMetadata;
  content: SigmaBlock[];
  outputProfiles: Record<OutputProfileName, OutputProfile>;
  comments?: SigmaCommentThread[];
  pageLayout?: PageLayout;
  updatedAt?: string;
}
```

各フィールドの役割は次の通りです。

| field | required | role |
| --- | --- | --- |
| `version` | yes | 保存形式。読み込み後は常に `"2.0"` |
| `docId` | yes | 文書ID。空文字不可 |
| `metadata` | yes | 文書メタデータ。現行では `title` のみ |
| `content` | yes | 本文ブロックの論理順 |
| `outputProfiles` | yes | 生徒用、教師用、解答冊子用の出力設定 |
| `comments` | no | コメントスレッド。anchorで本文・数式・ブロック・図形・図中数式へ紐付ける |
| `pageLayout` | no | 用紙、余白、段組み、ヘッダー/フッター、overlay |
| `updatedAt` | no | 保存更新時刻。schema上は文字列 |

`pageLayout` はoptionalですが、読み込み後は `normalizePageLayout` によって既定値つきの `PageLayout` として扱います。新規に保存するデータでは明示的に持たせるのが基本です。

最小構成の例です。

```json
{
  "version": "2.0",
  "docId": "doc_example",
  "metadata": {
    "title": "二次関数の確認"
  },
  "content": [
    {
      "type": "heading",
      "id": "heading_title",
      "level": 1,
      "children": [{ "type": "text", "text": "二次関数の確認" }]
    },
    {
      "type": "paragraph",
      "id": "paragraph_intro",
      "children": [
        { "type": "text", "text": "次の関数のグラフと交点を確認する。" }
      ]
    }
  ],
  "outputProfiles": {
    "student": { "showSolutions": false, "showHints": false, "includeAnswers": false },
    "teacher": { "showSolutions": true, "showHints": true, "includeAnswers": true },
    "answerBook": { "onlySolutions": true, "includeAnswers": true }
  }
}
```

## Metadata

```ts
interface SigmaMetadata {
  title: string;
  styleUnits?: {
    fontSize?: "pt";
  };
}
```

`metadata` は文書タイトルと、保存値の単位など文書全体に関わる軽量メタ情報だけを保持します。`styleUnits.fontSize` は現行では `"pt"` です。`grade`、`subject`、`assets` などは正規schemaのフィールドではありません。教材分類や検索タグが必要な場合は、SigmaDoc本体ではなくホストアプリ側の文書管理メタデータとして扱います。

## Output Profiles

```ts
type OutputProfileName = "student" | "teacher" | "answerBook";

interface OutputProfile {
  showSolutions?: boolean;
  showHints?: boolean;
  includeAnswers?: boolean;
  onlySolutions?: boolean;
  includeComments?: boolean;
}
```

`outputProfiles` は必ず `student`、`teacher`、`answerBook` の3キーを持ちます。各flagはoptionalで、印刷や出力時の表示制御に使います。

- `showSolutions`: `problem.solution` を表示する
- `showHints`: `problem.hints` を表示する
- `includeAnswers`: `problem.answer` を含める
- `onlySolutions`: 解答冊子のように解答・解説中心で出力する
- `includeComments`: 未解決コメントをPDF末尾のコメント一覧に含める

本文データ自体はprofileごとに分岐させません。profileは同じ `content` をどう出力するかの設定です。

## Comments

コメントは `SigmaDocument.comments` にスレッドとして保存します。対象が削除されてもスレッドは削除せず、UIと検証では「対象なし」として扱います。

```ts
interface SigmaCommentThread {
  id: string;
  anchor: SigmaCommentAnchor;
  messages: SigmaCommentMessage[];
  reactions?: SigmaCommentReaction[];
  resolved?: boolean;
  color?: string;
  createdAt: string;
  updatedAt?: string;
}

interface SigmaCommentMessage {
  id: string;
  authorName?: string;
  body: InlineNode[];
  reactions?: SigmaCommentReaction[];
  createdAt: string;
  updatedAt?: string;
}

interface SigmaCommentReaction {
  id: string;
  emoji: string;
  authorName?: string;
  createdAt: string;
}

type SigmaCommentAnchor =
  | { type: "textRange"; start: SigmaCommentTextPosition; end: SigmaCommentTextPosition; quote: string; mathInlineIds?: string[]; mathTex?: string[] }
  | { type: "inlineMath"; blockId: string; mathInlineId: string; quote?: string; tex?: string }
  | { type: "block"; blockId: string; quote?: string }
  | { type: "canvasRegion"; bounds: { x: number; y: number; w: number; h: number }; quote?: string }
  | { type: "overlayShape"; shapeIds: string[]; quote?: string }
  | { type: "overlayMath"; shapeId?: string; mathInlineId?: string; quote?: string; tex?: string };
```

`canvasRegion` はホワイトボードの空領域へ付ける固定アンカーです。`bounds` はズーム・パンに依存しないキャンバス絶対座標（px）で、x/yは負値も許し、w/hは正の有限値に限ります。図形の生成・削除とは独立して保持します。ドラッグ中・保持中の選択矩形自体は文書に保存しません。

`overlayMath` は、図中のテキストラベル、グラフラベル、表セルなどに含まれる数式へコメントするためのアンカーです。`shapeId` や `mathInlineId` が取れる場合は保持しますが、外部由来データや復元不能な対象でも `quote` / `tex` だけでコメントを表示できます。

`reactions` は現在スレッド単位とメッセージ単位の両方を読めます。スレッド単位reactionは、UIでは先頭メッセージのreactionとして扱います。新規データではメッセージ単位reactionを優先します。

## Content Model

`content` は本文の論理順を表す1本の配列です。

```ts
type SigmaBlock = SectionNode | HeadingNode | ParagraphNode | ListNode | QuoteBlockNode | CodeBlockNode | DividerNode | ProblemNode | LayoutSectionNode | BoxBlockNode;
type RichBlock = HeadingNode | ParagraphNode | ListNode;
type ProblemAreaBlock = RichBlock | QuoteBlockNode | CodeBlockNode | DividerNode | LayoutSectionNode | BoxBlockNode;
type LayoutSectionChildBlock = SectionNode | HeadingNode | ParagraphNode | ListNode | QuoteBlockNode | CodeBlockNode | DividerNode | BoxBlockNode;
type BoxBlockChildBlock = LayoutSectionChildBlock | LayoutSectionNode;
type QuoteChildBlock = HeadingNode | ParagraphNode | ListNode | CodeBlockNode | DividerNode;
type ListItemContinuationNode = HeadingNode | ParagraphNode | DividerNode;
```

`RichBlock` に `quote` / `codeBlock` / `divider` が入っていないのは意図です。ヘッダー/フッター
(`PageRunningRegion`) はこの型で組まれていて、ページごとに複製・採寸される領域に入れ物や
中身の無いブロックを通すと、`children` を前提にした経路がそこでも分岐を持つことになります。
ヘッダーに罫線が要るなら図形で引きます。

通常の説明文、問題文、見出し、本文フロー内の箱、数式は `content` に入れます。画像、図形、グラフ、表、位置固定の注釈は本文ブロックではなく `pageLayout.overlay.overlaySnapshot.shapes[]` に入れます。

### Common Node Fields

```ts
interface BaseNode {
  type: string;
  id: string;
  pagination?: PaginationHints;
}

interface PaginationHints {
  break?: boolean;
  keepTogether?: boolean;
  keepWithNext?: boolean;
}
```

すべての本文ブロックは `id` を持ちます。`id` は空文字不可で、同一文書内で重複させません。`getDocumentIssues` は本文ブロック、問題内のrich block、`mathInline` の重複IDを検出します。

`pagination` はページ分割へのヒントです。

- `break`: このブロックから次のページへ送る。段組み内では次の段へ送る
- `keepTogether`: 収まる限りブロック内で分割せず、ブロック全体を次のページまたは段へ送る
- `keepWithNext`: 収まる限り後続ブロックと同じページまたは段に配置する

3項目は編集画面と印刷/PDFのページネーションに反映されます。`keepTogether` または `keepWithNext` の対象全体が1ページ・1段より高い場合は、内容を失わないため制約を緩めて分割します。明示的な `break` はこれらの制約より優先します。

`break` はトップレベルのブロックだけでなく、オブジェクトの内側のブロックでも効きます。段組みのときは改ページではなく改段になります。ただしTeX風の箱は外側のページ・段に対して一つのまとまりなので、`boxBlock.blocks` 直下では手動改ページを指定できません。

- 問題エリア(`problem.lead` / `prompt` / `hints` / `solution`)内のブロック: そのブロックの前で分割します
- 枠付き問題文・`columnSpan: "full"` のエリア: 自動のあふれでは分割せず1つのまとまりとして配置しますが、内側のブロックに `break: true` があるときだけ分割します。枠は分割位置で上下が開いた形で描きます
- `layoutSection.children`: 段内に収まる場合でも分割します
- `boxBlock.blocks`: 直下の `break` は不正です。箱内に複数段の `layoutSection` を置いた場合だけ、その `children` の指定を箱内の改段として扱います
- 長い `boxBlock` は手動指定とは独立して、編集画面・印刷画面がページまたは外側の段へ自動分割します
- エリア/セクションの**先頭**ブロックに付けた `break` は「そのオブジェクトの前で改ページ」として扱い、内部分割には使いません

エディタ画面と印刷/PDFは別のレイアウトエンジンですが、上記の分割位置は一致します(`tests/e2e/object-break-parity.spec.ts` が両者を突き合わせて検証します)。

### Section

```ts
interface SectionNode extends BaseNode {
  type: "section";
  title: string;
  align?: "left" | "center" | "right" | "justify";
  lineHeight?: string; // 0.8〜3 の単位なし倍率
}
```

`section` は教材内の大きな区切りです。本文テキストは `title` に直接持ち、`children` は持ちません。問題番号や章タイトルなど、構造上の見出しとして使います。

### Heading

```ts
interface HeadingNode extends BaseNode {
  type: "heading";
  level: 1 | 2 | 3;
  children: InlineNode[];
  align?: "left" | "center" | "right" | "justify";
  lineHeight?: string; // 0.8〜3 の単位なし倍率
}
```

`heading` は本文フロー内の見出しです。`children` には通常テキストとインライン数式を混在できます。

### Paragraph

```ts
interface ParagraphNode extends BaseNode {
  type: "paragraph";
  children: InlineNode[];
  align?: "left" | "center" | "right" | "justify";
  lineHeight?: string; // 0.8〜3 の単位なし倍率
}
```

`paragraph` は本文の標準ブロックです。説明文、設問文、補足、式変形の1行表示などは原則として `paragraph` に入れます。本文中の数式は `mathInline` を使います。

表示式のように中央配置したい場合も、本文フローに置くなら `paragraph.align: "center"` と単一の `mathInline` で表します。

```json
{
  "type": "paragraph",
  "id": "paragraph_formula",
  "align": "center",
  "pagination": { "keepTogether": true },
  "children": [
    {
      "type": "mathInline",
      "id": "math_formula",
      "tex": "y = x^2 - 5x + 6",
      "display": "inline",
      "semanticRole": "equation"
    }
  ]
}
```

### List

```ts
type OrderedListMarkerStyle = "decimal" | "paren";

interface ListNode extends BaseNode {
  type: "list";
  listType: "bullet" | "ordered";
  start?: number;
  markerStyle?: OrderedListMarkerStyle;
  items: ListItemNode[];
}

interface ListItemNode {
  type: "listItem";
  id: string;
  children: InlineNode[];
  align?: TextAlign;
  continuations?: Array<ParagraphNode | HeadingNode>;
  nested?: ListNode[];
}
```

`list` は箇条書きと番号付きリストの本文ブロックです。`items` は1件以上必要です。各 `listItem` は独立した `id` を持ち、コメント、選択、将来のアンカー対象として扱えます。

`children` は項目の先頭段落、`align` はその段落の文字揃えです。同じマーカーの下に続く本文は `continuations` に通常の段落または見出しとして保持するため、段落ごとに異なる文字揃えを指定できます。入れ子リストは `nested` に `ListNode[]` として保持します。Tiptapの `bulletList` / `orderedList` / `listItem` は編集用の内部表現であり、保存時はこのSigmaDoc構造へ変換します。

`markerStyle` は `listType: "ordered"` の番号マーカーの見せ方だけを表します。未指定は `"decimal"`（`1.`）、`"paren"` は `(1)` 形式です。構造は通常の番号付きリストのままなので、`listType === "ordered"` を見ている処理はそのまま動きます。マーカーの描画は `apps/desktop/src/app/document-surface.css` の `@counter-style` 1箇所だけが出典で、編集画面・印刷・PDF・埋め込みビューアすべてがそこを読みます。`"bullet"` では無視されます。

```json
{
  "type": "list",
  "id": "list_steps",
  "listType": "ordered",
  "start": 1,
  "items": [
    {
      "type": "listItem",
      "id": "li_substitute",
      "children": [
        { "type": "mathInline", "id": "math_substitute", "tex": "x=1", "display": "inline" },
        { "type": "text", "text": " を代入する。" }
      ],
      "nested": [
        {
          "type": "list",
          "id": "list_notes",
          "listType": "bullet",
          "items": [
            {
              "type": "listItem",
              "id": "li_note",
              "children": [{ "type": "text", "text": "途中式を残す。" }]
            }
          ]
        }
      ]
    }
  ]
}
```

### Quote

```ts
interface QuoteBlockNode extends BaseNode {
  type: "quote";
  blocks: QuoteChildBlock[]; // 1つ以上
}
```

`quote` は引用ブロックで、本文ブロックを一段引き込んで見せる入れ物です (HTML の `blockquote` と
同じ位置づけ)。中には見出し・段落・リスト・コード・区切り線を置けます。入れ子の引用と、段組・
囲み枠は入れていません — 引用の中でページ割りの単位をもう一段作る意味がないためです。

**縦棒はブロック 1 つに 1 本引きます。** 段落ごとに引くと、チャンク境界・改ページウィジェット・
段組の絶対配置が間に入った瞬間に繋ぎ目が割れます。

`blocks` は空にできません。空の入れ物は編集面のスキーマ (content 式が `+`) でも作れないので、
保存側でも同じ形を強制しています。

### Code Block

```ts
interface CodeBlockNode extends BaseNode {
  type: "codeBlock";
  children: InlineNode[];
  language?: string; // 未指定 = 自動判定
}
```

`codeBlock` は **改行を含む 1 つの** テキストブロックです。段落の連なりではないので、中の行間は
常に一定で、箱も 1 つです。改行は本文の他の場所と同じ規約で text run の中の `\n` として持ちます
(編集面では `hardBreak`)。

文字単位の書式は `children` の run が持つので、コードの中でもフォント・大きさ・色を変えられます。
明示指定した run の色は構文の色より優先されます。

`language` は色分けにだけ使う値で、highlight.js の登録名です
(`features/rendering/adapters/code-highlight.ts` の一覧)。**色そのものは保存しません** —
トークンは本文と言語から毎回引き直す派生値で、これにより編集中の ProseMirror・静的描画・
印刷/PDF・埋め込みビューアが同じ関数から同じ色を出します。読めない言語は自動判定へ落とします。

自動判定の候補は選べる一覧より狭くしてあります。全部を候補にすると外れるためで、実測では
`function add(a, b) { … }` が CSS と判定されました。詳細と閾値は同ファイルのコメントにあります。

編集面では Enter が改行、末尾の空行でもう一度 Enter を押すとブロックの外へ出ます (`Mod+Enter`
でも出られます)。

### Divider

```ts
interface DividerNode extends BaseNode {
  type: "divider";
}
```

`divider` は水平の区切り線で、中身を持たない唯一の本文ブロックです。`content` 直下・段組セクション
(`layoutSection`)・囲み枠 (`boxBlock`)・問題エリア・引用・**リスト項目の続き**
(`ListItemContinuationNode`) に置けます。ヘッダー/フッターには置けません
(上の `RichBlock` の注記を参照)。

`ListItemContinuationNode` は文章を持たない種別を含むので、項目の中身を読む側は
`listItemContinuationInlineNodes()` を通してください。`children` を直接触ると、区切り線を
1 つ足しただけでその経路が落ちます。

### Layout Section

```ts
interface LayoutSectionNode extends BaseNode {
  type: "layoutSection";
  layout: {
    columnCount: number;
    columnGapMm?: number;
  };
  children: LayoutSectionChildBlock[];
}
```

`layoutSection` は、本文の途中だけを段組みにするためのブロックです。`children` は段落・見出し・リストなどの本文ブロックを論理順で保持し、段ごとの配列には分けません。編集画面・印刷画面が `layout.columnCount` と `layout.columnGapMm` から段への流し込みを派生させます。

- `layout.columnCount` は `1..4` の整数です。UIでは通常2〜4段を作成します。
- `layout.columnGapMm` は段間です。未指定の場合は文書全体の `pageLayout.flow.columnGapMm` に揃えます。
- `layoutSection` はレイアウト目的の範囲指定であり、演習の意味を持つ `problem` の代替ではありません。

### Box Block

```ts
interface BoxBlockNode extends BaseNode {
  type: "boxBlock";
  styleId: string;
  title?: InlineNode[];
  blocks: BoxBlockChildBlock[];
  frame?: BoxFrameSpec;
}

type BoxBlockChildBlock = SectionNode | HeadingNode | ParagraphNode | ListNode | BoxBlockNode | LayoutSectionNode;
```

`boxBlock` は本文フロー内の箱です。`itembox`、`tcolorbox`、`doublebox`、`shadebox`、`leftbar`、`cornerbox` のような単純なTeX風の箱は、overlay shapeではなくこのノードに保存します。

- `styleId`: built-inまたはユーザー定義の箱スタイルID。現行built-inは `src/lib/box-blocks.ts` の `BUILTIN_BOX_STYLES` を正とします。
- `title`: 箱タイトル。通常の `InlineNode[]` なので本文と同じく `mathInline` を含められます。
- `blocks`: 箱の本文。`paragraph`、`heading`、`list`、入れ子 `boxBlock`、箱内 `layoutSection` を保持できます。
- `frame`: その箱を最低限再現するための描画スナップショット。`styleId` が見つからない場合やstyleが変わった場合でも、既存文書を表示できるようにします。

箱の描画は `BoxFrameSpec` からCSS変数と `data-box-*` 属性を作って行います。TeXやTikZを任意実行しません。
箱内の `layoutSection` はTeXで `itembox` 内へ `multicols` を置く構成に相当し、複数段内の `pagination.break: true` は改段として扱います。箱直下の手動改ページは許可しません。

```ts
interface BoxFrameSpec {
  borderWidthPx?: number;
  borderColor?: string;
  borderStyle?: "solid" | "dashed" | "dotted" | "double" | "none";
  backgroundColor?: string;
  titleBackgroundColor?: string;
  titleColor?: string;
  titleAlign?: TextAlign;
  titleFontWeight?: "normal" | "bold";
  titleFontFamily?: string;
  titleFontSizePx?: number;
  titleLineHeight?: string;
  bodyColor?: string;
  bodyAlign?: TextAlign;
  bodyFontFamily?: string;
  bodyFontSizePx?: number;
  bodyLineHeight?: string;
  cornerStyle?: "sharp" | "round";
  radiusPx?: number;
  paddingPx?: BoxSpacingPx;
  decorations?: BoxDecorationSpec[];
}

type BoxDecorationSpec =
  | { type: "cornerSquares"; sizePx: number; color: string }
  | { type: "doubleRule"; offsetPx: number; widthPx?: number; color?: string }
  | { type: "titleDoubleRule"; ruleWidthPx?: number; ruleColor?: string; guideColor?: string }
  | { type: "titleBand"; heightPx?: number; backgroundColor?: string; ruleWidthPx?: number; ruleColor?: string }
  | { type: "titleTab"; heightPx?: number; radiusPx?: number; offsetXPx?: number; paddingPx?: BoxSpacingPx; backgroundColor?: string }
  | { type: "titlePlate"; borderColor?: string; radiusPx?: number; paddingPx?: BoxSpacingPx }
  | { type: "leftBar"; widthPx: number; color: string }
  | { type: "shadow"; offsetXPx: number; offsetYPx: number; blurPx?: number; spreadPx?: number; color: string }
  | { type: "horizontalRules"; widthPx?: number; color?: string }
  | { type: "notebookRules"; ... };
```

`notebookRules` はノート罫、左綴じ罫、リングなどのCSSで安全に再現できるパラメータを持ちます。詳細なフィールドは `src/types/sigma-doc.ts` を正とします。

タイトルに地色を敷く装飾は2種類あります。`titleBand` は枠幅いっぱいの帯で、`ruleWidthPx` を持たせると帯と本文のあいだに罫を引きます。`titleTab` は枠の左上へ差し込む見出しタブで、**枠の内側**に収めます (上へはみ出させると、ブロックを絶対配置で積む印刷経路が出っ張りを勘定できず、前のブロックへ重なるため)。

### Problem

```ts
interface ProblemNode extends BaseNode {
  type: "problem";
  tags: string[];
  lead: ProblemAreaBlock[];
  prompt: ProblemAreaBlock[];
  answer?: AnswerDefinition;
  solution: ProblemAreaBlock[];
  hints: ProblemAreaBlock[];
  areaLayout?: Partial<Record<"lead" | "prompt" | "solution" | "hints", ProblemAreaLayout>>;
  numbering?: ProblemNumbering;
  frame?: ProblemFrame;
}

interface ProblemAreaLayout {
  minHeightMm?: number;
  columnSpan?: "column" | "full";
}

interface ProblemNumbering {
  enabled?: boolean;
  fontSize?: number;
  value?: number;
}

interface ProblemFrame {
  enabled?: boolean;
  styleId?: string;
}
```

`problem` は演習としての意味を持つブロックです。単なる本文の囲みやレイアウト目的では使いません。

- `lead`: 問題番号の右隣から始まる導入文。`heading`、`paragraph`、`list`、`layoutSection`、`boxBlock`
- `prompt`: 問題文。`heading`、`paragraph`、`list`、`layoutSection`、`boxBlock`
- `answer`: 採点や解答表示用の短い正答
- `hints`: コメント。`heading`、`paragraph`、`list`、`layoutSection`、`boxBlock`
- `solution`: 解答。`heading`、`paragraph`、`list`、`layoutSection`、`boxBlock`
- `areaLayout`: 導入文・問題文・コメント・解答エリアの表示用レイアウト
- `numbering`: 問題番号の表示設定。未指定または `enabled: true` は本文順の連番を表示し、`enabled: false` はその問題を採番対象から外す。`fontSize` は番号表示の文字サイズ(pt)、`value` は任意の指定番号
- `frame`: 問題文側の枠線設定。`enabled: true` のときだけ問題文に枠線を表示する。`styleId` は問題枠styleの識別子として使える

`lead`、`solution`、`hint` は独立したtop-level blockではありません。必ず対象の `problem` の内側に置きます。

編集画面と印刷では、`problem` は `lead`、`prompt`、`hints`、`solution` を本文中の連続したエリアとして展開します。エディタ上ではエリア境界を示す紙面外のサイド注とガイド線を表示しますが、このガイドと自動の「問題」「コメント」「解答」ラベルは本文データやPDFには出力しません。紙面に見出しを出したい場合は、ユーザーが各エリア内の本文として書きます。導入文エリアは常に編集可能で、使わない場合は空欄のままにします。空のコメント、解答エリアは編集画面でも既定では表示せず、追加操作で表示します。問題番号はラベルではなく、表示対象の問題に対して本文順で `1`、`2` のように導出し、番号の右隣に導入文を置きます。番号は未指定なら直前の表示番号 + 1、`numbering.value` があればその番号を使い、後続の自動番号は指定番号 + 1 から続けます。`frame.enabled` が `true` の場合のみ、問題文に枠線を表示し、導入文、コメント、解答には枠線を表示しません。

`areaLayout.*.minHeightMm` は、そのエリアの最小高さです。内容が増えた場合は内容の高さが優先され、手動で広げた高さは最小高さとして保持されます。

`areaLayout.*.columnSpan` は、文書全体が段組みのときのエリア幅です。未指定または `"column"` は通常の段内配置、`"full"` は本文幅いっぱいの全幅配置です。

問題エリア内の一部だけを段組みにする場合は、対象ブロックを各エリア内の `layoutSection` にまとめます。段組みは `layoutSection.layout.columnCount` と `layoutSection.layout.columnGapMm` から派生し、問題エリア全体の `areaLayout` には段数を保存しません。

問題エリア内の枠は `boxBlock` として保持し、本文フロー上の枠ID、リッチテキストのタイトル、枠内ブロック、`BoxFrameSpec` をトップレベルの枠と同じ構造で保存します。

```ts
interface AnswerDefinition {
  type: "math" | "text";
  expected: string;
}
```

## Inline Nodes

```ts
type InlineNode = TextInlineNode | MathInlineNode;
```

### Text

```ts
interface TextInlineNode {
  type: "text";
  text: string;
  marks?: ("bold" | "italic" | "underline" | "boxed")[];
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  boxedPaddingY?: number;
  boxedVariant?: "frame" | "oval" | "shade";
  boxedTone?: "gray" | "blue" | "green" | "red" | "yellow";
}
```

通常の文字列です。`fontSize` はpt単位の正の数だけを受け付けます。色やフォントは必要な場合だけ保存します。`boxed` は文字の囲みを表し、`boxedPaddingY` で上下余白を調整します。`boxedVariant` は囲みの形、`boxedTone` は囲みの色調です。

### Math Inline

```ts
interface MathInlineNode {
  type: "mathInline";
  id: string;
  tex: string;
  display: "inline";
  marks?: ("boxed")[];
  boxedPaddingY?: number;
  boxedVariant?: "frame" | "oval" | "shade";
  boxedTone?: "gray" | "blue" | "green" | "red" | "yellow";
  semanticRole?: "expression" | "equation" | "variable";
  altText?: string;
}
```

本文フロー中の数式は必ず `mathInline` です。`display` は現行schemaでは `"inline"` 固定です。大きな式を本文中で中央表示したい場合も、`paragraph.align: "center"` と `mathInline` を使います。

`tex` はMathLive/KaTeXで扱うTeX断片です。`getDocumentIssues` とAI編集の検証では `mathlive` の `validateLatex` を使って未許可コマンドや構文エラーを検出します。

数式そのものを囲む場合は、`mathInline` に `marks: ["boxed"]` を付けます。囲みの形と色調は `boxedVariant` / `boxedTone` で調整できます。太字・斜体・下線などの文字装飾は数式には保存せず、必要な見た目はTeXか専用の数式表示設定として扱います。

現行schemaには `mathBox` という本文ブロックも専用shapeもありません。通常の教材本文は `mathInline` に置きます。軸名、点ラベル、注釈、曲線の式ラベルなど、紙面上で動かせる必要があるグラフ文字は `graph2dShape` のSVG内部に描かず、グラフにshape anchorされた `text` shape として置きます。

## Page Layout

`pageLayout` は用紙、余白、段組み、ヘッダー/フッター、オーバーレイを保持します。

```ts
type PageSizePreset = "A4" | "A3" | "B5" | "B4" | "custom" | "whiteboard";
type PageOrientation = "portrait" | "landscape";

interface PageLayout {
  preset: PageSizePreset;
  orientation: PageOrientation;
  pageSize: { widthMm: number; heightMm: number };
  marginsMm: { top: number; right: number; bottom: number; left: number };
  flow: {
    type: "columns";
    columnCount: number;
    columnGapMm: number;
  };
  header?: PageRunningRegion;
  footer?: PageRunningRegion;
  overlay?: PageOverlay;
}
```

`normalizePageLayout` の既定値は次の通りです。

| field | default |
| --- | --- |
| `preset` | `"A4"` |
| `orientation` | `"portrait"` |
| `pageSize` | A4縦 `210mm x 297mm` |
| `marginsMm` | top/bottom `18mm`, left/right `17mm` |
| `flow.type` | `"columns"` |
| `flow.columnCount` | `1` |
| `flow.columnGapMm` | `8` |
| `header.enabled` | `false` |
| `footer.enabled` | `false` |

標準プリセットは次のJIS系サイズです。

| preset | portrait size |
| --- | --- |
| `A4` | `210mm x 297mm` |
| `A3` | `297mm x 420mm` |
| `B5` | `182mm x 257mm` |
| `B4` | `257mm x 364mm` |

`landscape` は幅と高さを入れ替えた向きとして扱います。`custom` と `whiteboard` では、正の `pageSize.widthMm` / `pageSize.heightMm` を保存値として使います。`A4` などのpresetでは `pageSize` に別値が入っていても、presetとorientationから正規化されます。

`whiteboard` は無限キャンバス（ホワイトボード）用のプリセットです。編集領域の大きさには `pageSize` を使わず、互換性のため正の値を保持します。本文 `content` は必ず空配列とし、通常図形、表、グラフなどの全要素を `pageLayout.overlay` の絶対座標に配置します。本文・ページ anchor は持たず、グラフ所有ラベルなどの shape-to-shape anchor だけを許可します。正規化時は入力値に関わらず余白をすべて0、段数を1、段間を0にし、ヘッダーとフッターを未設定にします。印刷・PDF書き出し時は保存データを変更せず、可視オブジェクトの外接矩形に余白を加えた1枚のカスタム用紙へ変換します。

### Margins And Flow

余白は `marginsMm` にmmで保存します。UI上の「左7割だけ書ける」などの比率プリセットは、保存時には左右余白mmへ変換します。

`pageLayout.flow` の段組みは文書全体に適用します。本文の一部だけを段組みにする場合は、対象段落を `layoutSection` に入れます。

- `flow.type` は正規化後 `"columns"` 固定
- `flow.columnCount` は `1..4` の整数
- `flow.columnGapMm` は0以上
- 本文幅、本文高さ、段幅、段間pxは `getPageMetrics` から派生
- 段ごとの本文配列やページごとの本文配列は保存しない

## Running Regions

ヘッダーとフッターは本文ブロックではなく、ページ装飾として `pageLayout.header` / `pageLayout.footer` に保存します。

```ts
interface PageRunningRegion {
  enabled: boolean;
  heightMm: number;
  offsetMm: number;
  showOnFirstPage: boolean;
  blocks: RichBlock[];
  overlay?: PageOverlay;
}
```

各フィールドの意味は次の通りです。

| field | role |
| --- | --- |
| `enabled` | 出力時に表示するか |
| `heightMm` | ヘッダー/フッター領域の高さ |
| `offsetMm` | 用紙端から領域までの距離 |
| `showOnFirstPage` | 1ページ目にも表示するか |
| `blocks` | 繰り返し表示する本文。`heading` / `paragraph` / `list` |
| `overlay` | running region内で繰り返す図形、画像、自由配置テキスト |

左/中央/右のスロットは正規データに持ちません。配置は `blocks[].align` と `overlay` で表します。

ページ番号やタイトルは通常のテキスト内トークンとして保存します。

- `{title}`: `metadata.title`
- `{page}`: 現在ページ番号
- `{total}`: 総ページ数

現行データでは `header.content.left` / `center` / `right` のようなスロット構造は持ちません。配置は `blocks[].align` と `overlay` で表します。

有効なrunning regionは `ensurePageLayout` / `expandMarginsForRunningRegions` によって本文余白を広げます。たとえば `header.enabled` がtrueで `offsetMm + heightMm` が現在の上余白より大きい場合、`marginsMm.top` はその値まで拡張されます。

## Overlay

図形、画像、グラフ、表、自由配置テキストは `pageLayout.overlay` に保存します。

```ts
interface PageOverlay {
  overlaySnapshot?: OverlaySnapshot;
  updatedAt?: string;
}

interface OverlaySnapshot {
  version: 1;
  shapes: OverlayShape[];
  assets: Record<string, OverlayAsset>;
  extensions?: Record<string, JsonValue>;
}
```

`overlaySnapshot` がoverlayの唯一の正本です。表示・印刷・書き出し用のSVGは常にsnapshotから再生成し、直列化したSVG文字列を文書に保存することはありません。`overlaySnapshot` を持たないoverlayはimport・正規化時に丸ごと破棄します。

将来の追加情報は、ドットまたはハイフンを含む名前空間キー（例: `vendor.feature`）で `extensions` に保存します。値は有限数を含むJSON値だけです。shape・asset・propsに未定義フィールドを足して保持することはせず、読み込み時に正規フィールドだけへ再構築します。旧shape/assetの `meta` は `sigma.legacy.metadata` へ移行します。shape型そのものを変更する場合は `OverlaySnapshot.version` と明示的なmigrationを追加します。

`pageLayout.overlay` はドキュメント全体で1つの連続したオーバーレイです。ページごとの `overlays` mapは正規schemaではありません。複数ページにまたがる場合も、`shapes[]` の `y` 座標が連続キャンバス上の位置を表します。

座標はCSS px相当の数値です。用紙サイズごとのpxは `mmToPx(mm) = mm * 96 / 25.4` で計算します。ページ間には `PAGE_GAP_PX = 36` の視覚ギャップがあります。

例としてA4縦では、おおよそ次の範囲になります。

| page | y range |
| --- | --- |
| 1 | `0..1123` |
| 2 | `1159..2282` |
| 3 | `2318..3441` |

用紙サイズや向きが変わる場合は、固定のA4値ではなく `getPageMetrics(layout).page.heightPx + PAGE_GAP_PX` を使ってページオフセットを求めます。

### Common Shape Fields

すべてのshapeは共通フィールドを持ちます。

```ts
interface OverlayBaseShape<Type extends string, Props> {
  id: string;
  type: Type;
  x: number;
  y: number;
  rotation?: number;
  parentId?: string;
  groupId?: string;
  stackLayer?: "foreground" | "background";
  locked?: boolean;
  hidden?: boolean;
  opacity?: number;
  anchor?: OverlayAnchor;
  props: Props;
}
```

| field | role |
| --- | --- |
| `id` | shape ID。空文字不可 |
| `type` | shape種別 |
| `x`, `y` | 連続キャンバス上のshape原点 |
| `rotation` | 回転角。省略可 |
| `parentId` | 親group shapeのID。省略可 |
| `groupId` | 入力専用のグループ目印。見つかった場合は `group` shape + `parentId` へ正規化されます。新規保存では使いません |
| `stackLayer` | `"background"` は本文背面、`"foreground"` は本文前面。省略時は前景扱い |
| `locked` | 編集ロック。省略可 |
| `hidden` | 非表示。省略可 |
| `opacity` | `0..1`。shape全体の透明度 |
| `anchor` | ページ固定または本文ブロック追従 |
| `props` | shape種別ごとのデータ |

`x`、`y`、`rotation` は有限の数値である必要があります。`opacity` は0以上1以下です。`parentId` は同じ `overlaySnapshot.shapes[]` 内にある `type: "group"` のshapeを指します。存在しない親、groupではない親、循環参照は読み込み時の正規化で解除されます。

グループの表示・出力では、`hidden`、`locked`、`opacity` が子孫shapeに継承されます。`group` shapeそのものは編集用の階層・boundsを表すだけで、印刷/SVGには描画されません。

### Anchors

```ts
type OverlayAnchor =
  | { type: "block"; blockId: string; dy: number; dx?: number; line?: OverlayLineAnchor }
  | { type: "shape"; shapeId: string; dx: number; dy: number; rx?: number; ry?: number }
  | { type: "page" };

interface OverlayLineAnchor {
  index: number;
  dy: number;
}
```

アンカーがないshape、または `{ "type": "page" }` のshapeはページ絶対座標で扱います。`x` と `y` がそのまま連続キャンバス上の位置です。

`block` アンカーのshapeは本文ブロックに追従します。

- `blockId`: 追従する本文ブロックID
- `dy`: ブロック上端からshape原点までの縦オフセット
- `dx`: ブロック左端からshape原点までの横オフセット
- `line`: ブロック内の表示行に追従するための補助情報。`index` は実測された行番号、`dy` は行上端からshape原点までの縦オフセット

表示時は、対応ブロックの測定位置があれば `x = block.left + dx`、`y = block.top + dy` に解決します。`line` があり、対応する表示行も測定できる場合は `y = line.top + line.dy` を優先します。`dx` と `line` は簡潔なtool入力を受けるためoptionalですが、編集時に補完されます。アンカー先ブロックが見つからない場合は保存済みの `x` / `y` にフォールバックします。

`blockId` が `problem.lead`、`problem.prompt`、`problem.hints`、`problem.solution` 内のrich blockを指す場合、そのshapeは該当する問題エリア所属として扱います。専用の `scope` / `owner` fieldは持ちません。例えば解答冊子では `solution` 内rich blockにanchorされたshapeを表示し、生徒版では `solution` や `hints` 内rich blockにanchorされたshapeを非表示にします。`shape` アンカーの子shapeは親shapeの所属と表示可否を継承します。`page` アンカーまたはanchorなしのshapeは文書共通です。

`shape` アンカーのshapeは別のoverlay shapeに追従します。

- `shapeId`: 追従する親shape ID
- `dx` / `dy`: 親shape基準点からshape原点までのオフセット
- `rx` / `ry`: 任意。親shape bounds内の基準点を通常 `0..1` の比率で表します。省略時は親shapeの `x` / `y` が基準点です

表示時は、親shapeが見つかれば `x = parent.x + dx`、`y = parent.y + dy` に解決します。`rx` / `ry` がある場合は `parent bounds` 上の比率位置を基準にするため、親shapeのリサイズにも追従できます。親shapeが見つからない場合は保存済みの `x` / `y` にフォールバックします。親shapeを削除した場合、shapeアンカーでぶら下がる子shapeも一緒に削除します。

本文上部に挿入・削除が起きても図形を問題文や説明文に追従させたい場合は、`block` アンカーを使います。ページ上の固定位置に置きたい背景や装飾は `page` アンカーまたはアンカー省略で表します。

## Overlay Assets

画像shapeは `OverlayAsset` を参照します。

```ts
interface OverlayAsset {
  id: string;
  type: "image";
  props: {
    w: number;
    h: number;
    name: string;
    isAnimated: false;
    mimeType: string | null;
    src: string;
    fileSize: number;
    storage?: OverlayStorageAssetRef;
  };
}

interface OverlayStorageAssetRef {
  kind: "remote-asset";
  storageKey: string;
  assetId: string;
}
```

`overlaySnapshot.assets` はasset IDをキーにした辞書です。`image` shapeの `props.assetId` はこの辞書内のassetを参照します。標準のデスクトップ教材では `src` にdata URLを保持できます。

具体的なbucket名、table名、署名URL、provider側metadataはSigmaDoc JSONに永続保存しません。

## Overlay Shape Reference

現行の `OverlayShape` は次の10種です。

| type | use |
| --- | --- |
| `group` | 複数shapeをまとめる編集用コンテナ |
| `geo` | 矩形、楕円、三角形、ひし形、正5〜12角形、block arrow |
| `arc` | 円弧、楕円弧、扇形 |
| `arrow` | 始点/終点を持つ矢印 |
| `line` | 折れ線、曲線、フリーハンド、ハイライト系 |
| `text` | 自由配置のリッチテキスト |
| `image` | 画像asset |
| `callout` | 吹き出し |
| `graph2dShape` | 2Dグラフ |
| `tableShape` | 表、増減表 |

### Group Shape

```ts
type OverlayGroupShape = OverlayBaseShape<"group", {
  w: number;
  h: number;
  name?: string;
}>;
```

`group` は複数shapeの編集単位です。子shapeは共通フィールドの `parentId` に親groupの `id` を持ちます。`props.w` と `props.h` は子孫の選択範囲から再計算されるboundsで、group自体の見た目を保存するための値ではありません。

正規化では次を行います。

- `groupId` を持つ複数shapeを、正規データの `group` shape と `parentId` へ正規化する
- 親の不存在、親子循環、group以外を親にした参照を解除する
- 子が1つ以下になったgroupを解除する
- group boundsを子shapeから再計算し、groupと子孫が連続するstack順へ並べる

### Geo Shape

```ts
type OverlayGeoShape = OverlayBaseShape<"geo", {
  w: number;
  h: number;
  geo: "rectangle" | "ellipse" | "triangle" | "diamond" | "pentagon" | "regularPolygon" | "blockArrow";
  polygonSides?: 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  apexX?: number;
  headLengthRatio?: number;
  shaftRatio?: number;
  radius?: number;
  fill: "none" | "solid";
  color: string;
  fillColor?: string;
  strokeOpacity?: number;
  fillOpacity?: number;
  labelColor: string;
  dash: "solid" | "dashed" | "dotted";
  size: "s" | "m" | "l" | "xl";
  label?: string;
}>;
```

`w` と `h` は必須です。`fill` は `"none"` または `"solid"` です。`strokeOpacity` と `fillOpacity` は指定する場合 `0..1` です。`blockArrow` は太い矢印型の図形で、`headLengthRatio` と `shaftRatio` で頭部と軸の比率を調整できます。`radius` は角丸矩形用の半径です。

### Arc Shape

```ts
type OverlayArcShape = OverlayBaseShape<"arc", {
  kind?: "arc" | "sector";
  r: number;
  rx?: number;
  ry?: number;
  startAngle: number;
  endAngle: number;
  arrowheadStart?: "none" | "arrow" | "triangle" | "openArrow" | "thinArrow" | "diamond" | "dot" | "bar";
  arrowheadEnd?: "none" | "arrow" | "triangle" | "openArrow" | "thinArrow" | "diamond" | "dot" | "bar";
  fill?: "none" | "solid";
  fillColor?: string;
  fillOpacity?: number;
  color: string;
  strokeOpacity?: number;
  dash: "solid" | "dashed" | "dotted";
  size: "s" | "m" | "l" | "xl";
}>;
```

端点装飾は `arrow`(開いた矢印)・`triangle`(塗りつぶし三角)・`openArrow`(開き角の大きい矢印)・`thinArrow`(細い矢印)・`diamond`(ひし形)・`dot`(丸)・`bar`(バー)で、いずれも線幅に比例して拡大します。

`r` は正の数です。`rx` / `ry` がある場合は楕円弧として扱えます。`kind: "sector"` は扇形です。角度は数値で保存します。`arrowheadStart` / `arrowheadEnd` は開いた円弧の端点にだけ表示します。

### Arrow Shape

```ts
type OverlayArrowShape = OverlayBaseShape<"arrow", {
  start: { x: number; y: number };
  end: { x: number; y: number };
  arrowheadStart?: "none" | "arrow" | "triangle" | "openArrow" | "thinArrow" | "diamond" | "dot" | "bar";
  arrowheadEnd: "none" | "arrow" | "triangle" | "openArrow" | "thinArrow" | "diamond" | "dot" | "bar";
  fill: "none";
  color: string;
  strokeOpacity?: number;
  labelColor: string;
  dash: "solid" | "dashed" | "dotted";
  size: "s" | "m" | "l" | "xl";
  label?: string;
}>;
```

`start` と `end` はshape原点から見たローカル座標です。`fill` は `"none"` 固定です。

### Line Shape

```ts
type OverlayLineShape = OverlayBaseShape<"line", {
  kind?: "polyline" | "curve" | "freehand";
  points: { x: number; y: number }[];
  closed: boolean;
  arrowheadStart?: "none" | "arrow" | "triangle" | "openArrow" | "thinArrow" | "diamond" | "dot" | "bar";
  arrowheadEnd?: "none" | "arrow" | "triangle" | "openArrow" | "thinArrow" | "diamond" | "dot" | "bar";
  fill?: "none" | "solid";
  fillColor?: string;
  fillOpacity?: number;
  color: string;
  strokeOpacity?: number;
  labelColor?: string;
  dash: "solid" | "dashed" | "dotted";
  size: "s" | "m" | "l" | "xl";
  label?: string;
}>;
```

`points` は1点以上が必須です。`kind` が省略された場合は通常の折れ線相当として扱います。`closed` がtrueの場合は終点から始点へ閉じたpathとして扱えます。塗りつぶしは閉じた線やハイライト系の表現に使います。

### Text Shape

```ts
type OverlayTextShape = OverlayBaseShape<"text", {
  w: number;
  h: number;
  blocks: OverlayTextBlock[];
  color: string;
  fontSize?: number;
  size: "s" | "m" | "l" | "xl";
}>;
```

`text` shapeは自由配置の注釈用です。通常の説明文、問題文、解答、見出しをoverlay textに逃がさないでください。それらは本文の `heading` / `paragraph` / `problem` に保存します。
`w` は著者が決める幅で、テキストはこの幅で折り返します。図形をリサイズしても変わるのは `w` だけで、フォントサイズは変わりません。`h` は折り返した内容の実測高さを保持する派生キャッシュで、直接編集しません。

```ts
type OverlayTextBlock = RichBlock; // 本文と同じ heading | paragraph | list
```

図中テキストの中身は本文のブロックそのものです (`heading` / `paragraph` / `list`)。文字・インライン数式・装飾は本文と同じ `InlineNode` で保持し、ブロックは本文と同じく `id` 必須です。Tiptapの `doc` / `content` / `attrs` / object形式の`marks` / `hardBreak` は編集時にadapterが生成する派生表現であり、overlay snapshotには保存しません。文字列内の改行は `TextInlineNode.text` の `\n` で保持します。

### Image Shape

```ts
type OverlayImageShape = OverlayBaseShape<"image", {
  assetId: string;
  w: number;
  h: number;
  crop?: {
    topLeft: { x: number; y: number };
    bottomRight: { x: number; y: number };
  };
}>;
```

`assetId` は `overlaySnapshot.assets` のキーを参照します。`crop` は元画像内の表示範囲を `0..1` の正規化座標で表します。省略時は画像assetの比率を保ったまま、shape枠を満たす中央cover cropとして表示します。

### Callout Shape

```ts
type OverlayCalloutShape = OverlayBaseShape<"callout", {
  w: number;
  h: number;
  radius: number;
  tail: {
    baseStart: { x: number; y: number };
    baseEnd: { x: number; y: number };
    tip: { x: number; y: number };
  };
  blocks: OverlayTextBlock[];
  color: string;
  fontSize?: number;
  size: "s" | "m" | "l" | "xl";
}>;
```

吹き出しは、本文矩形、リッチテキスト、口を単一shapeに保存します。`w` / `h` は本文矩形のサイズ、`radius` は角丸半径(px)です。`tail.baseStart` と `tail.baseEnd` は本文矩形の外周をそれぞれ独立して移動でき、別々の辺にも配置できます。`tail.tip` は自由座標です。3点はいずれも本文矩形左上を原点とする相対座標です。エディタで`tail.tip`をドラッグすると、現在の口幅を保ったまま頂点に最も近い外周位置へ麓2点を移し、角の近くでは別々の辺へ分けます。吹き出し本文はoverlay textと同じsemantic rich text構造を使うため、インライン数式と文字装飾を保持できます。

## Graph Shape

グラフは `graph2dShape` としてoverlayに保存します。本文ブロックには保存しません。関数グラフを手作業の線や矢印で近似するのではなく、`props.spec.curves[].expr` に関数式を持たせます。

```ts
type OverlayGraphShape = OverlayBaseShape<"graph2dShape", {
  w: number;
  h: number;
  boundsMode?: "plot";
  spec: Graph2DSpec;
  // x軸、y軸、原点ラベルをtext shapeとして挿入した場合の参照。
  axisLabelTextShapeIds?: Partial<Record<"x" | "y" | "origin", string>>;
  // 点ラベル、注釈ラベルをtext shapeとして挿入した場合の参照。
  pointLabelTextShapeIdsByPointId?: Record<string, string>;
  annotationTextShapeIdsByAnnotationId?: Record<string, string>;
  // 曲線式ラベルを近くの text shape として挿入した場合の参照。
  labelTextShapeIds?: string[];
  labelTextShapeIdsByCurveId?: Record<string, string>;
}>;
```

```ts
interface Graph2DSpec {
  kind: "cartesian" | "numberLine";
  title: string;
  width: number;
  height: number;
  viewBox: GraphViewBox;
  graphViewBox?: GraphViewBox;
  axes: GraphAxes;
  curves: GraphCurve[];
  points?: GraphPoint[];
  annotations?: GraphAnnotation[];
  fills?: GraphFillRegion[];
  // 現行UIでは曲線の式ラベルはgraph内凡例ではなく、近くのtext shapeとして挿入する。
  showFormulaLabels?: boolean;
}
```

`boundsMode: "plot"` のグラフでは、shapeの `x` / `y` と `props.w` / `props.h` が軸や曲線を描くプロット範囲です。目盛り文字などに必要なSVG余白はこの範囲の外側へ描画し、選択・整列・回転・リサイズの図形範囲には含めません。`spec.width` / `spec.height` は余白を含むレンダリング基準サイズです。`boundsMode` がない旧データは読み込み時に同じ見た目を保ったままプロット範囲基準へ正規化します。

`axisLabelTextShapeIds` は、x軸、y軸、原点ラベル用の text shape を参照します。新規グラフの既定ラベルは `GraphAxes` の固定表示ではなく、`x` / `y` / `\mathrm{O}` の text shape として作られ、`anchor: { type: "shape", shapeId: graphId, ... }` でグラフ本体に追従します。

`pointLabelTextShapeIdsByPointId` と `annotationTextShapeIdsByAnnotationId` は、`GraphPoint.label` / `GraphAnnotation.text` から作った text shape を参照します。座標値や注釈本文はtool入力で受け取れますが、text shapeを作成した時点でspec側のラベル本文は空にし、参照先text shapeだけを保存正本にします。

`labelTextShapeIdsByCurveId` は、グラフ本体の外側または図中へ挿入した曲線式ラベル用の text shape を参照します。ラベル本文は参照先text shapeだけが保存正本です。`GraphAxes` の `xLabel` / `yLabel` / `originLabel` もtool入力では受け取れますが、materialize後は空にします。`update_graph` は更新直前に既存text shapeの本文を一時的な入力specへ投影し、更新後に再びspec側を空にするため、text shapeだけで編集した本文が古いspec値へ戻ることはありません。

### Graph ViewBox

```ts
interface GraphViewBox {
  xMin: string;
  xMax: string;
  yMin: string;
  yMax: string;
}
```

範囲値は文字列です。`"-2*pi"` や `"sqrt(2)"` のような式を保持できるように、数値ではなく文字列にしています。

### Graph Axes

```ts
interface GraphAxes {
  grid: boolean;
  showX?: boolean;
  showY?: boolean;
  showTicks?: boolean;
  xLabel?: string;
  yLabel?: string;
  originLabel?: string;
  xTickStep?: string;
  yTickStep?: string;
  xTickMode?: "number" | "pi";
  yTickMode?: "number" | "pi";
}
```

`grid` は必須です。その他は表示オプションです。tick stepも文字列で、`"1"`、`"0.5"`、`"pi"` などを保存できます。`xLabel` / `yLabel` / `originLabel` はAI/tool入力用に読みますが、新規挿入では graph-owned text shape の初期本文へ移され、グラフ内部SVGには描画しません。

### Graph Curves

```ts
interface GraphCurve {
  id: string;
  expr: string;
  yExpr?: string;
  exprTex?: string;
  yExprTex?: string;
  label?: string;
  color: string;
  mode?: "yOfX" | "xOfY" | "parametric" | "implicit";
  dash?: "solid" | "dashed" | "dotted";
  strokeWidth?: number;
  domain?: {
    min?: string;
    max?: string;
  };
  samples?: number;
}
```

`expr` は評価用の式文字列で、グラフ描画の正本です。`exprTex` / `yExprTex` はユーザーが数式入力 (MathLive) で入力した TeX の投影で、表示・再編集に使います。TeX から評価式への正規化は `src/lib/graph-tex.ts` (`texToGraphExpression`) が担い、TeX が無い既存データでは `graphExpressionToTex` で表示用 TeX を導出します。通常の関数は `mode: "yOfX"` または省略で `y = f(x)` として扱います。横向きの関係を描く場合は `mode: "xOfY"` を使います。媒介変数表示は `mode: "parametric"` とし、`expr` に `x=f(t)`、`yExpr` に `y=g(t)` を保存します。陰関数は `mode: "implicit"` とし、`F(x,y)=0` として評価できる式を `expr` に保存します。任意右辺の等式は `左辺-右辺` に正規化します（例: `x^2 - 4*x + y^2 - 22`）。元の入力等式は `exprTex` や `label` に保持できます。`domain` は曲線ごとの表示範囲で、媒介変数表示では `t` の範囲、陰関数では x 方向の描画範囲です。

### Graph Points, Annotations, Fills

```ts
interface GraphPoint {
  id: string;
  x: string;
  y: string;
  xTex?: string;
  yTex?: string;
  label?: string;
  color?: string;
  fill?: "solid" | "none";
  radius?: number;
  showXProjection?: boolean;
  showYProjection?: boolean;
}

interface GraphAnnotation {
  id: string;
  x: string;
  y: string;
  text: string;
}

interface GraphFillRegion {
  id: string;
  x: string;
  y: string;
  color?: string;
  opacity?: number;
  pattern?: "solid" | "diagonal" | "diagonalBack" | "cross" | "horizontal" | "vertical" | "dots";
}
```

点や塗りつぶしの座標も評価用の式文字列です。`xTex` / `yTex` は座標の数式入力 (`(x, y)` 形式) で入力した TeX の投影で、分数・平方根・πなどの入力表示を保持します。`fills` はグラフ内の指定点をもとに閉領域を塗るためのデータです。`pattern` は未指定なら `"solid"` として扱い、斜線・格子・横線・縦線・点々などの塗り分けを保存します。`opacity` は指定する場合 `0..1` です。

## Table Shape

表と増減表は本文ブロックではなく `tableShape` としてoverlayに保存します。

```ts
type OverlayTableShape = OverlayBaseShape<"tableShape", {
  w: number;
  h: number;
  table: SigmaTableSpec;
}>;
```

```ts
interface SigmaTableSpec {
  version: 1;
  kind: "plain" | "variation";
  columns: SigmaTableColumn[];
  rows: SigmaTableRow[];
  cells: SigmaTableCell[];
  grid: SigmaTableGridStyle;
  defaultCellStyle: SigmaTableCellStyle;
}
```

`plain` は通常表、`variation` は増減表です。列と行は1件以上が必須で、IDはそれぞれの配列内で重複不可です。セルは `rowId` と `columnId` で行列を参照します。

### Table Tracks

```ts
type SigmaTableTrackSize =
  | { mode: "auto"; min?: number; max?: number }
  | { mode: "fixed"; value: number }
  | { mode: "fr"; value: number; min?: number; max?: number };
```

列幅・行高はセルではなく `columns[].width` / `rows[].height` に保存します。

- `auto`: 内容と `min` / `max` に合わせる
- `fixed`: ユーザー操作後の固定px
- `fr`: 表全体サイズに対する比率配分

`fixed.value` と `fr.value` は正の数です。`min` / `max` は指定する場合正の数です。

### Table Columns And Rows

```ts
interface SigmaTableColumn {
  id: string;
  width: SigmaTableTrackSize;
  role?: "label" | "point" | "interval" | "value";
}

interface SigmaTableRow {
  id: string;
  height: SigmaTableTrackSize;
  role?: "header" | "body" | "variable" | "derivative" | "variation" | "note";
}
```

`role` は表の意味づけです。増減表では `label`、`point`、`interval`、`variable`、`derivative`、`variation` などを使って編集UIや表示を補助します。

### Table Cells

```ts
interface SigmaTableCell {
  id: string;
  rowId: string;
  columnId: string;
  rowSpan?: number;
  colSpan?: number;
  content: SigmaTableCellContent[];
  style?: Partial<SigmaTableCellStyle>;
}

type SigmaTableCellContent =
  | SigmaTableCellParagraph
  | SigmaTableTrend;
```

`rowSpan` と `colSpan` は指定する場合、正の整数です。`content` は配列で、段落と増減矢印を入れられます。

```ts
interface SigmaTableCellParagraph {
  type: "paragraph";
  id: string;
  children: InlineNode[];
  align?: "left" | "center" | "right" | "justify";
}

interface SigmaTableTrend {
  type: "trend";
  id: string;
  direction: "up" | "down" | "flat";
  label?: InlineNode[];
}
```

セル内段落の `children` は本文と同じ `InlineNode[]` です。通常文字列と `mathInline` を混在できます。

### Table Styles

```ts
interface SigmaTableGridStyle {
  borderColor: string;
  borderWidth: number;
  borderStyle?: "solid" | "dashed" | "dotted" | "double";
  showOuterBorder?: boolean;
  showInnerBorders?: boolean;
  lineOverrides?: SigmaTableGridLineOverride[];
}

type SigmaTableGridLineOverride =
  | { axis: "vertical"; edge: "left" | "right"; style: SigmaTableGridLineStyle }
  | { axis: "vertical"; beforeColumnId: string; style: SigmaTableGridLineStyle }
  | { axis: "horizontal"; edge: "top" | "bottom"; style: SigmaTableGridLineStyle }
  | { axis: "horizontal"; beforeRowId: string; style: SigmaTableGridLineStyle };

interface SigmaTableGridLineStyle {
  visible?: boolean;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: "solid" | "dashed" | "dotted" | "double";
}

interface SigmaTableCellStyle {
  align?: "left" | "center" | "right" | "justify";
  verticalAlign?: "top" | "middle" | "bottom";
  paddingX?: number;
  paddingY?: number;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
}
```

`borderWidth`、`paddingX`、`paddingY` は0以上です。`fontSize` はpt単位の正の数です。セルの `style` は `defaultCellStyle` を部分的に上書きします。

`lineOverrides` は表全体の罫線設定に対する格子線単位の上書きです。縦線は左右外枠または `beforeColumnId`、横線は上下外枠または `beforeRowId` で指定します。`style` の未指定項目は `grid.borderColor` / `grid.borderWidth` / `grid.borderStyle` と `showOuterBorder` / `showInnerBorders` から継承します。`visible` が指定された線では、その線だけ表示/非表示を優先します。

## Validation And Normalization

`parseSigmaDocument(input)` は次を行います。

- `version` が `"2.0"` であることを確認する
- `docId`、`metadata`、`content`、`outputProfiles` を検証する
- `pageLayout` を `PageLayoutSchema` で検証し、`normalizePageLayout` と `expandMarginsForRunningRegions` を通す
- 返却時に `version` を `"2.0"` にする
- `pageLayout` が欠けている場合も既定値で補完する
- 問題の `lead` が欠けている場合は空配列に補完し、schema外の `kind` / `difficulty` / `points` は保持しない
- `boxBlock.blocks` は1件以上必要で、箱内の `layoutSection` や入れ子 `boxBlock` も本文ID検査の対象になる

`pageLayout` では少なくとも次を検証します。

- 用紙幅・高さは正の数
- 余白は0以上
- 左右余白の合計は用紙幅未満
- 上下余白は本文高さを少なくとも `MIN_PAGE_BODY_HEIGHT_MM = 30` mm残す
- 段数は `1..4` の整数
- 段間は0以上
- 段間の合計は本文幅未満

`whiteboard` では余白・段組みに関する検証を行わず、互換性のため保持する `pageSize.widthMm` / `pageSize.heightMm` が正の数であることだけを検証します。また、文書全体の検証で `content` が空配列であり、overlay shape に本文・ページ anchor がないことを必須とします。

`overlaySnapshot` は `isValidOverlaySnapshot` で検証します。通常の厳格検証では、不正なshapeやassetが1件でも含まれると `PageOverlaySchema` の検証に失敗します。ファイル読み込み時は `recoverOverlaySnapshot` がshape/assetを1件ずつ検証し、不正な要素だけを診断付きで除外します。復旧後のsnapshotも厳格schemaを通ることが必須です。

`getDocumentIssues(document)` は追加の文書品質チェックです。

- 本文ブロックID、問題内rich block ID、箱内block ID、`mathInline` ID、コメント/リアクションIDの重複
- `mathInline.tex` のMathLive検証エラー
- 空ID

## Authoring Rules

SigmaDocを手で書く、AIで生成する、外部形式から変換するときは次を守ります。

- 教材本文は `content` に置く。
- 説明、導入文、問題文、解答、見出しをoverlay textにしない。
- 単純な枠付き本文やTeX風の箱は `boxBlock` にし、overlay図形として貼らない。
- 本文中の数式は `mathInline` にする。
- 図形、画像、グラフ、表は `pageLayout.overlay.overlaySnapshot.shapes[]` に置く。
- グラフは `graph2dShape` の `spec.curves[].expr` で表し、線や矢印の集合で近似しない。
- 表と増減表は `tableShape` で表し、本文内の擬似テキスト表にしない。
- 本文に追従すべき図形は `anchor: { type: "block", blockId, dx, dy }` を使う。
- すべての本文ノード、mathInline、shape、graph curve/point/annotation/fill、table row/column/cell/contentには安定したIDを付ける。
- overlayは `overlaySnapshot` だけを正本とする。直列化済みのSVG文字列は保存せず、渡しても破棄される。

## TeX Import

`.tex` ファイルは `src/lib/tex-import.ts` でSigmaDocへ一方向変換します。TeX全文を正本として保存せず、変換後の本文・問題・数式をSigmaDocノードとして検証してからワークスペースへ追加します。

現在の importer は次を扱います。

- `\title` を `metadata.title` へ移す。
- `\newcommand` / `\renewcommand` / `\providecommand` の0〜9引数マクロを、宣言を本文から分離してから展開する。省略時引数・未使用引数に対応し、`providecommand` は既存の定義を上書きしない。循環・展開量超過・不正な定義・引数不足は文書を返す前にエラーにする。
- `\section` を `section`、`\subsection` / `\subsubsection` を `heading` へ変換する。
- 段落本文を `paragraph`、`$...$`、`\(...\)`、`\[...\]`、`equation` / `align` などを `mathInline` へ変換する。
- `problem` / `exercise` / `question` 環境を `problem` ノードへ変換し、内部の `solution`、`hint`、`answer` を対応エリアへ分ける。
- `\rulecenter{問題...}` を `problem` ノードの区切り、`\ovalbox{解答}` を解答エリアの開始として扱う。
- `\anaume{...}` / `\sanaume{...}` は囲み付きテキスト、`\maru1` / `\maru{1}` は丸数字、`\footnote{...}` は注記テキストへ変換する。
- `enumerate` / `itemize` は `list` として取り込む。`label=(\arabic*)` と `start=` を `markerStyle` / `start` に移す。`\item[(3)]` などの数字ラベルも本文へ重複挿入せず、連続番号は一つのリスト、飛び番号は別リストにする。数字以外の明示ラベルと `description` のラベルは各 `listItem.children` の先頭に残す。
- 小問内の複数段落・別行数式は `listItem.continuations`、入れ子リストは `nested` に保持する。本文中の別行数式は中央揃えの独立段落にする。単独の `$...$` はインラインのままとする。
- 単独の `aligned` / `gathered` / `cases` / 各種matrix環境も数式として保持する。数式内の `\item` や `\solution` を文書構造として解釈しない。
- `quote` / `center` / `itembox` は本文ブロックへ展開する。`itembox` 内のリストも残す。囲みテキストと内部の数式は同じ `boxed` mark を保持する。
- `tikzpicture` / `tikzcd` / `tabular` など未対応環境は `codeBlock`（`language: "latex"`）として保持する。図・表へ描画したことにはしない。小問内では、リストモデルが扱える通常段落へソースを残す。
- `\includegraphics{...}` は、現在のTeX importerでは隣接画像ファイルの解決をまだ行わないため、`［画像: filename］` のプレースホルダとして保持する。

処理は `tex-import/scanner.ts`（エスケープ・入れ子・区切り）、`macros.ts`（定義の分離・展開上限）、`math.ts`（数式境界）、`list-options.ts`（番号指定）、`tex-import.ts`（SigmaDoc組み立て）に分ける。これらの中間表現は保存しない。既存のファイル取り込みと公開Editorの変換APIは同じ実装を使う。

受験数学研究所の[投稿仕様](https://jukenmath.net/submit)を2026-09-10に確認し、上記のマクロ・小問・数式構文に対応した。サイトの問題文／解答のように別フィールドを持つ場合は `importTexProblem({ title, prompt, solution, hints, preamble, tags })` を使う。マクロ定義は同一問題の全フィールドで共有し、問題文を `prompt`、解説を `solution`、ヒントを `hints` へ明示的に分ける。空の問題文はエラーにする。返す文書IDは変換ごとに新しく作り、完成文書を `parseSigmaDocument` で検証する。

完全なLaTeX処理系ではない。マクロ定義は問題全体の共有表として読み取るため、グループ局所スコープや本文途中の再定義による表示切替には対応しない。任意のenumitemラベル書式、入れ子リストの後の文章との厳密な順序、複雑なレイアウト、図版の描画、表組み、外部ファイル参照、ページ設定は完全再現しない。通常のマクロ展開後の未対応環境ソースを残し、SigmaDocエディタ上で整える前提とする。

## Quick Checklist

新しいSigmaDoc JSONを保存またはimportする前に確認すること。

1. `version` は `"2.0"` か。
2. `docId` は空でないか。
3. `outputProfiles` に `student`、`teacher`、`answerBook` があるか。
4. 本文は `content`、図形類は `pageLayout.overlay` に分かれているか。
5. `pageLayout` を省略していないか。省略する場合も正規化後の既定値を理解しているか。
6. `overlaySnapshot.version` は `1` か。
7. `shapes[]` と `assets` の参照関係は壊れていないか。
8. block追従が必要なshapeに `anchor.type: "block"` があるか。
9. TeXは本文フローなら `mathInline` に入っているか。
10. TeX風の箱をoverlay shapeではなく `boxBlock` にしているか。
11. import前に `parseSigmaDocument` で検証できるか。
