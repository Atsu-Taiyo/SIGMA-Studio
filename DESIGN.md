---
version: alpha
name: Sigma Studio
description: 理系教材エディタ Sigma Studio のデスクトップUI。白・黒・グレーの静かな面に教材を置き、青は状態を示すときだけ使う。
colors:
  primary: "#1F5EFF"
  primary-50: "#EDF2FF"
  primary-100: "#E0E8FF"
  primary-200: "#D2DFFF"
  background: "#FFFFFF"
  surface: "#FAFAFA"
  surface-soft: "#F7F7F7"
  surface-muted: "#F1F1F1"
  surface-strong: "#E9E9E9"
  border-subtle: "#E5E5E5"
  border: "#DADADA"
  border-strong: "#BDBDBD"
  text-primary: "#111111"
  text-secondary: "#555555"
  text-muted: "#8A8A8A"
  text-disabled: "#B0B0B0"
  danger: "#B42318"
  danger-soft: "#FFF1F0"
  success: "#247A3D"
  warning: "#9A6700"
  tooltip-surface: "#202020"
  pro: "#FACC15"
  pro-soft: "#FEF6C7"
  pro-ink: "#854D0E"
typography:
  title-lg:
    fontFamily: &ui-font 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif'
    fontSize: 18px
    fontWeight: 650
    lineHeight: 1.35
  title-md:
    fontFamily: *ui-font
    fontSize: 14px
    fontWeight: 650
    lineHeight: 1.4
  title-sm:
    fontFamily: *ui-font
    fontSize: 13px
    fontWeight: 650
    lineHeight: 1.4
  body-md:
    fontFamily: *ui-font
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: *ui-font
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.55
  label-md:
    fontFamily: *ui-font
    fontSize: 12px
    fontWeight: 650
    lineHeight: 1
  label-sm:
    fontFamily: *ui-font
    fontSize: 11px
    fontWeight: 650
    lineHeight: 1.3
  label-xs:
    fontFamily: *ui-font
    fontSize: 10px
    fontWeight: 650
    lineHeight: 1.2
  document-title:
    fontFamily: *ui-font
    fontSize: 20px
    fontWeight: 450
    lineHeight: 1.4
  document-body:
    fontFamily: '"M PLUS 1p", "Noto Sans Symbols", "STIX Two Math", sans-serif'
    fontSize: 16px
    fontWeight: 400
rounded:
  control: 10px
  panel: 16px
  dialog: 20px
  round: 999px
spacing:
  none: 0px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  4xl: 64px
  content-width-sm: 480px
  content-width-md: 640px
  content-width-lg: 840px
  content-width-xl: 1040px
components:
  button-primary:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.background}"
    typography: "{typography.label-md}"
    rounded: "{rounded.control}"
    height: 34px
    padding: 12px
  button-primary-hover:
    backgroundColor: "#2E2E2E"
    textColor: "{colors.background}"
  button-secondary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.control}"
    height: 34px
    padding: 12px
  button-secondary-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-primary}"
  button-ghost:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.control}"
  button-danger-hover:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
  icon-button:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.round}"
    size: 34px
  tool-button:
    textColor: "{colors.text-secondary}"
    rounded: 7px
    size: 34px
  tool-button-disabled:
    textColor: "{colors.text-disabled}"
  tool-button-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-primary}"
  tool-button-active:
    backgroundColor: "{colors.primary-100}"
    textColor: "{colors.text-primary}"
  tool-button-active-hover:
    backgroundColor: "{colors.primary-200}"
    textColor: "{colors.text-primary}"
  toolbar-group:
    backgroundColor: "{colors.surface}"
    rounded: 8px
    padding: 3px
  toolbar-splitter:
    backgroundColor: "{colors.border-subtle}"
    width: 1px
    height: 28px
  search-field:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.round}"
    height: 36px
  search-field-focus:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-primary}"
  dialog:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-primary}"
    typography: "{typography.title-lg}"
    rounded: "{rounded.dialog}"
    width: "{spacing.content-width-md}"
    padding: "{spacing.xl}"
  dialog-description:
    textColor: "{colors.text-muted}"
    typography: "{typography.body-sm}"
  tooltip:
    backgroundColor: "{colors.tooltip-surface}"
    textColor: "{colors.background}"
    typography: "{typography.label-sm}"
    rounded: 7px
  new-button:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.panel}"
    height: 48px
  new-button-hover:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.text-primary}"
  skeleton:
    backgroundColor: "{colors.surface-muted}"
    rounded: 4px
  list-row:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    height: 44px
  list-row-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-primary}"
  list-row-selected:
    backgroundColor: "{colors.primary-50}"
    textColor: "{colors.text-primary}"
  document-tab:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-secondary}"
    height: 28px
  document-tab-active:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-primary}"
  save-dot-saved:
    backgroundColor: "{colors.success}"
    rounded: "{rounded.round}"
    size: 7px
  save-dot-saving:
    backgroundColor: "{colors.warning}"
    rounded: "{rounded.round}"
    size: 7px
  save-dot-error:
    backgroundColor: "{colors.danger}"
    rounded: "{rounded.round}"
    size: 7px
  toast:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.background}"
    rounded: 12px
  toast-error:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.background}"
  account-ring-pro:
    backgroundColor: "{colors.pro}"
    rounded: "{rounded.round}"
  pro-badge:
    backgroundColor: "{colors.pro-soft}"
    textColor: "{colors.pro-ink}"
    rounded: "{rounded.round}"
---

# Sigma Studio Design System

この文書は Sigma Studio のデスクトップUIがいまどう見え、どう振る舞うかを書いたデザインの仕様である。形式は [DESIGN.md](https://github.com/google-labs-code/design.md) に従い、冒頭のYAMLにトークンを、本文にその使い方を書く。

- 値は CSS で定義している。色・余白・角丸・影・重なりは `apps/desktop/src/app/styles/controls.css` の `:root`、青の濃淡は `apps/desktop/src/app/palette.css` にある。冒頭のトークン名は CSS カスタムプロパティに合わせてあり、`colors.surface-muted` は `var(--surface-muted)`、`spacing.md` は `var(--space-md)`、`rounded.control` は `var(--radius-control)` を指す。CSS とこの文書が食い違ったら、CSS に合わせてこの文書を直す
- 共通部品は `apps/desktop/src/components/ui/` にあり、部品ごとの受け持ちは同じ場所の `README.md` に書く
- 画面ごとの配置と編集操作の決まり (編集画面、教材一覧、数式、図形、ヘッダーとフッターなど) は [docs/design-rules.md](docs/design-rules.md) に書く。この文書はどの画面にも共通する見た目と部品を扱う
- 書式は `pnpm dlx @google/design.md lint DESIGN.md` で確かめる

## Overview

Sigma Studio は数式・図・グラフを含む理系教材を作るエディタである。画面の主役は教材で、UIはそのまわりで目立たないようにする。長い時間使う道具なので、目を引くことより、迷わず操作できて疲れないことを選ぶ。迷ったら、凝った見た目より分かりやすい操作を取る。

1. **直感的でシンプル**
   - 画面の要素を増やしすぎず、操作の流れを短くする
   - 同じ操作はどこでも同じ位置・同じ見た目・同じ挙動にする
   - 説明が要るUIは、説明文を足す前に配置・アイコン・ラベル・状態表示を見直す
2. **教材が主役**
   - 装飾は最小限にし、余白・線・文字・アイコンで階層を作る
   - 1画面の主役は1つに絞る。編集画面では本文キャンバスをいちばん強く、補助パネルは薄い背景と細い境界線、小さな文字で控えめに見せる
3. **状態が分かる**
   - 読み込み中・保存中・同期中・エラー・未保存・選択中を、作業の邪魔にならない位置と強さで示す
   - 状態が変わったら、該当箇所の近くで変化を見せる
   - 色だけに頼らず、アイコン・ラベル・面・動きを組み合わせる
4. **白・黒・グレーが基調**
   - グレーは面・境界・階層・状態を表す主な手段として使う
   - 青 (`primary`) は選択・フォーカス・挿入位置などの状態にだけ使い、広い面には塗らない
5. **アイコンで操作する**
   - 保存、元に戻す、削除、整列、太字、数式、図形などの主要な操作はアイコンボタンで表す
   - アイコンだけでは結果が曖昧な操作には Tooltip を付ける
   - 破壊的な操作はアイコンだけで即実行せず、確認するか取り消せるようにする
6. **必要なときに見せる**
   - 補助情報・詳細・追加操作はホバー、メニュー、ポップオーバー、ダイアログで段階的に出す
   - 主要な操作と重要な状態は、ホバーしないと存在が分からない作りにしない
   - 開示しても周囲のレイアウトを動かさない
7. **静かで整った面**
   - 同じ種類のカード・行・ボタンは余白、アイコンの位置、文字の位置、境界線、角丸を揃える
   - 影は浮いている面だけに使い、面の階層は薄い背景差と1pxの境界線で表す

## Colors

基調は無彩色の12段で、白の背景に `#111111` の文字を置く。値は `controls.css` の `:root` にある。

| トークン | 値 | 役割 |
| --- | --- | --- |
| `background` | `#FFFFFF` | 画面、ダイアログ、入力欄、選択中の文書タブ |
| `surface` | `#FAFAFA` | パネル、ツールバーのグループ |
| `surface-soft` | `#F7F7F7` | ごく薄い下地、見本やプレビューの面 |
| `surface-muted` | `#F1F1F1` | ホバー、選択中のナビゲーション項目、未選択の文書タブ、検索欄、読み込み中の骨組み |
| `surface-strong` | `#E9E9E9` | いちばん濃い面。プレビューの線やタブのまとまりの下地など、面の上でさらに一段沈めるところ |
| `border-subtle` | `#E5E5E5` | 区切り線、カード・ダイアログ・表の罫 |
| `border` | `#DADADA` | 入力欄と secondary ボタンの枠、ホバーしたツールボタンの枠 |
| `border-strong` | `#BDBDBD` | 選択中の文書タブの枠、押し込まれたボタンの枠 |
| `text-primary` | `#111111` | 本文、見出し、primary ボタンの面 |
| `text-secondary` | `#555555` | 補助的な文字、通常時のアイコン |
| `text-muted` | `#8A8A8A` | メタ情報、プレースホルダー、説明文 |
| `text-disabled` | `#B0B0B0` | 無効な操作 |

`text-muted` は白の上でコントラスト比が約3.4:1なので、操作できる要素の主ラベルには使わず `text-secondary` 以上にする。

### Accent

青は `primary` (`#1F5EFF`、CSS では `--primary-500` と別名の `--accent`) の1色で、濃淡は `palette.css` で白と混ぜて作る。

| トークン | 値 | 役割 |
| --- | --- | --- |
| `primary` | `#1F5EFF` | フォーカスリング、挿入線とドロップ先の線、一覧で選んだ行の左端の線、並び替え中の列の印、共同編集者のキャレット |
| `primary-50` | `#EDF2FF` | 選んだ行や情報パネルの薄い下地 (`--accent-soft`) |
| `primary-100` | `#E0E8FF` | ツールバーのトグルがONであることを示す面 |
| `primary-200` | `#D2DFFF` | ONのトグルにホバーしたときの面 |

- トグルのONは面の色だけで示し、アイコンと文字は青くしない。青い文字はリンクや別の状態に見える
- 新しい濃さが要るときは、部品の CSS に `color-mix()` を直書きせず `palette.css` に段階を足す
- 本文の選択範囲は `rgb(59 130 246 / 32%)` の固定色にする。OSのハイライト色は環境ごとの差が大きいので使わない

### Semantic

| トークン | 値 | 役割 |
| --- | --- | --- |
| `danger` / `danger-soft` | `#B42318` / `#FFF1F0` | エラー、削除。削除の操作はホバーしたときに赤くなる |
| `success` | `#247A3D` | 保存済み (文書タブの点)、成功 |
| `warning` | `#9A6700` | 保存中 (文書タブの点)、警告 |

### Exceptions

無彩色と青から外れてよいのは次だけ。

- Proプランのアカウント表示。アバターに `pro` (`#FACC15`) の単色のリングを付け、下端に `pro-soft` の面と `pro-ink` の文字のバッジを重ねる。光沢やグラデーションは付けず、黄色をほかのUIへ広げない
- 色そのものを選ぶ面 (彩度×明度の面、色相の帯、色見本)
- AIプロバイダのロゴ、ユーザーのアイコン画像
- 教材の中身。本文・図・枠の色はユーザーが決める
- Tooltip (`tooltip-surface`、`#202020`) と教材一覧のトースト (`text-primary`) は、暗い面に白い文字で出す

コメントまわりなどに slate 系や `#2563eb` の直値が残っているが、新しく書くときはトークンを使う。

## Typography

UIの文字は OS のシステムフォントで組む (`--app-ui-font-family`)。教材の本文は別で、`"M PLUS 1p"` を先頭にした `--editor-body-font-family` を既定にし、ユーザーが教材ごとに変えられる。

UIの文字は小さく、12px と 11px と 13px でほとんどを占める。太さは、ボタン・ラベル・見出しの強調に 650、本文に 400 を使う。600 と 700 を使う箇所もある。見出しを太さだけで目立たせず、字間は標準のままにする。

| トークン | サイズ / 太さ | 使いどころ |
| --- | --- | --- |
| `title-lg` | 18px / 650 | ダイアログの見出し |
| `title-md` | 14px / 650 | 設定のセクション見出し |
| `title-sm` | 13px / 650 | 設定行の名前、パネルの見出し |
| `body-md` | 13px / 400 | 一覧、表、メニュー項目、ツールバーの選択欄 |
| `body-sm` | 12px / 400 | 説明文、補足 (`text-muted`、行間 1.55) |
| `label-md` | 12px / 650 | ボタン、フォームのラベル |
| `label-sm` | 11px / 650 | 表の列見出し、Tooltip、リボンのグループ名、ヒント |
| `label-xs` | 10px / 650 | ショートカットのキー表示、バッジ |
| `document-title` | 20px / 450 | 編集画面の教材タイトル |
| `document-body` | 12pt (16px) | 教材本文の既定 |

- ラベルは短くする。説明文を足すより、配置とアイコンで意味を伝える
- 階層はサイズ・太さ・グレーの濃さ (`text-primary` → `text-secondary` → `text-muted`) の順に差を付けて作る
- 16px 以上の文字はダイアログの見出し、教材一覧の「Sigma Studio」(16px)、Backstage の見出し (22px)、料金の金額のような、その面に1つの見出しに限る
- 教材本文の文字サイズ・行の高さ・数式の扱いは [docs/design-rules.md](docs/design-rules.md) に書く

### Overflow

長いラベルはまず折り返し、ボタンやパネルからはみ出させない。1行に保つ箇所では、場所によって端の見せ方を分ける。

- **端を薄れさせる (Overflow Fade)**: 文書タブのタイトル、タブ列の横スクロール、コメントの発言者、追加フォントのタイル名、ポケットのカードのように、見出しとして常に見えている文字。CSS の `mask-image` で末尾の短い範囲だけを透明にし、背景色に依存させない。はみ出しているときだけ薄れさせ、横スクロールでは内容が隠れている側の端だけに掛ける
- **「…」で切る**: 教材一覧の行、パンくず、メニュー、サイドバーの項目名、教材タイトルの入力欄など、一覧として並ぶ名前。プロダクトの大半はこちら
- どちらの場合も全文のデータとアクセシブルな名前は保ち、ホバーかキーボードフォーカスで全文を確かめられるようにする
- 入力欄の背景・枠、アイコン、操作ボタン、フォーカスリングは薄れさせない。入力中の値とキャレットは常に読めるようにする
- 教材本文と印刷・PDF出力には、どちらも使わない

## Layout

### Spacing Scale

余白・パディング・要素の間隔は `--space-*` の9段で決める。

| トークン | 値 | 主な用途 |
| --- | ---: | --- |
| `none` | `0px` | 余白なし |
| `xs` | `4px` | 隣り合うアイコンボタン、密接した要素 |
| `sm` | `8px` | アイコンとラベル、標準の要素間隔、ボタンの上下 |
| `md` | `12px` | フォームの項目間、ボタンと入力欄の左右 |
| `lg` | `16px` | カード・パネルの内側 |
| `xl` | `24px` | ダイアログの内側、セクション間 |
| `2xl` | `32px` | 主要な領域の間、集中画面の左右 |
| `3xl` | `48px` | 空状態や集中画面の大きな余白 |
| `4xl` | `64px` | 特別に広い導入画面 |

- `margin`・`padding`・`gap` には、このトークンを使う
- 間隔は子要素の `margin` ではなく、親の `gap` で作る
- `1px` は境界線、`2px` はアイコンや文字の光学補正に使う
- 負の余白はキャンバスの座標処理やヒット領域など必要な箇所に限り、理由をコードコメントに残す
- 幅に応じて余白を変えるときも中間値を作らず、ブレークポイントでトークンを切り替える
- オーバーレイの座標、図形の寸法、印刷の寸法、ユーザーが指定する値は、このスケールの対象にしない

実際の CSS では、`margin`・`padding`・`gap` の宣言のうちトークンを使うものは3分の1ほどで、ツールバー・メニュー・タブのような密なクロームには `6px` と `10px` の直値が多く残っている。触った範囲からトークンへ寄せ、無関係な画面まで一括で書き換えない。トークンで表せない値を残すときは理由をコメントに書く。

### Layout Primitives

配置と余白は `apps/desktop/src/components/ui/layout/` の部品で組む。どれもスペーシングのトークン名を型付きの props で受け取り、任意の px は受け取らない。

| 部品 | 受け持ち |
| --- | --- |
| `Stack` | 縦に並べ、`gap` を持つ |
| `Inline` | 横に並べ、`gap`・折り返し・垂直位置を持つ |
| `Inset` | カードやパネルの内側の `padding` を持つ |
| `Center` | 最大幅 (`content-width-*`) と左右の中央寄せ、画面端のガターを持つ |
| `Grid` | 同じ種類の項目の列数 (1〜4) と `gap` を持つ |

- 部品は配置だけを受け持ち、色・境界線・影・業務ロジックを持たせない
- 兄弟要素との間隔は `Stack`・`Inline`・`Grid` に、内側の余白は `Inset` に持たせ、外側の余白と混ぜない
- 単純な縦横の配置のために、`div` と生の `margin`・`padding`・`gap` を増やさない

### App Frame

画面は2つある。寸法は CSS の実測値。

```text
教材一覧 (/workspace)
  ヘッダー 64px : ロゴ / 中央の検索 / 操作とアカウント
  左サイドバー 256px (畳むと 64px のアイコン列)
  本体 : パンくず / フォルダと教材の表 (行の高さ 44px)

編集画面
  クローム 116px (74px + 42px) : タイトル行・メニュー・文書タブ (高さ 28px)・ツールバー。Word風はリボン
  ポケット : 閉じると 0px、開くと 88px
  本文キャンバス
  ステータスバー 26px (Word風だけ)
  右サイドバー : ウィンドウの上端から下端まで。幅は既定 400px (320〜720px)
```

- ダイアログと集中画面の幅は `content-width-sm` (480px)・`md` (640px)・`lg` (840px)・`xl` (1040px) から選ぶ
- 本文キャンバスの高さは `--editor-chrome-height`・`--editor-pocket-height`・`--editor-statusbar-height` を引いて求め、`calc(100vh - …)` に生の px を書かない
- それぞれの画面の配置の決まりは [docs/design-rules.md](docs/design-rules.md) に書く

### Density

- ツールバー、一覧、アウトライン、設定の行は、目で追いやすい密度に詰める。ツールバーのボタンは 34px、一覧の行は 44px
- 本文キャンバスには十分な余白を取り、教材の読みやすさを優先する
- 初期画面、空状態、ダイアログ、AIの入力開始画面には編集画面の密度を持ち込まない。中央寄せの最大幅 (`content-width-*`) を決め、主役を囲む余白を広く取る

## Elevation & Depth

面は平らに置き、階層は薄い背景差と1pxの境界線で表す。影を付けるのは浮いている面だけにする。

| 階層 | 表し方 |
| --- | --- |
| 地の面 | `background`。影も枠も付けない |
| パネル、カード、表 | `surface` 系の面と `border-subtle` の1px |
| メニュー、ポップオーバー、浮かぶカード | `--shadow-floating` と `border-subtle` の1px |
| ダイアログ | `--shadow-floating`、背面は `rgb(17 17 17 / 32%)`。入れ子のダイアログの背面は20% |

- `--shadow-floating` は `0 24px 64px -32px rgb(17 17 17 / 45%), 0 4px 16px rgb(17 17 17 / 8%)`。広く柔らかく、ほとんど意識されない強さにしてある
- カードやタイルに影や持ち上がりを付けない。カードの中にカードを入れない
- 編集結果をその場で見せるための面 (グラフの設定パネル、色のパレット) は、背面を暗くしない
- 重なりの順は `--z-modal` (5000)・`--z-modal-nested` (5100)・`--z-tooltip` (5200) で決め、画面ごとに `z-index` を上書きしない
- 教材一覧の「新規」ボタンだけは常に小さな影を持つ。画面でいちばん大事な操作を示すための例外
- 画面ごとに書かれた影が残っているが、新しく書くときは `--shadow-floating` を使う

## Shapes

角丸は面の大きさで決める。

| トークン | 値 | 使いどころ |
| --- | ---: | --- |
| `control` | `10px` | 文字を含むボタン、入力欄、選択カード |
| `panel` | `16px` | カード、ポップオーバー、浮かぶパネル |
| `dialog` | `20px` | ダイアログ |
| `round` | `999px` | アイコンだけのボタン、検索欄、チップ、バッジ、状態の点 |

- アイコンだけのボタン (`IconButton`) は幅と高さを揃えた真円にする。AIチャットの送信ボタンが基準
- ツールバーの中に並ぶツールボタンは別で、34px 四方に `7px` の角丸を使う。小さいもの (28px) は `6px`。Tooltip も `7px`
- 文書タブは上の2つの角だけを `6px` 丸める
- メニュー項目やコード片のような部品の内側の小さな面は `4px`〜`8px`。これはトークンになっていない
- 完全なピル形はチップ・バッジ・検索欄・短いステータスに限る
- 境界線は1px。選択を枠の太さで示さない (太くすると要素が動く)
- アイコンは [Lucide](https://lucide.dev/) の線画を使い、大きさは 14〜16px を基本に、小さな箇所で 12〜13px、大きな操作で 18px にする。ラベルの左に置くときは、文字と視覚的な中心を合わせる

## Motion & Micro-interaction

動きは状態の変化を伝えるためだけに使い、短く、控えめにする。

| 種類 | 値 | 使いどころ |
| --- | --- | --- |
| 状態の変化 | `120ms ease` | ホバー、押下、選択の色の変化。共通の `Button` と `SearchField` は 140ms |
| 面が出る | `170ms cubic-bezier(0.2, 0.85, 0.25, 1)` | ダイアログの面。背面は 140ms でフェードする |
| 読み込み | `1.4s`〜`1.8s ease-in-out` の繰り返し | Shimmer の明滅 (1.4s) と骨組みの光の帯 (1.8s) |

- 開閉や展開は 180〜280ms (検索欄が広がる動きが 180ms、ポケットの開閉が 280ms)。開いても周囲のレイアウトを動かさない
- 読み込みの動きは遅く弱くする。強い点滅や派手なグラデーションにしない
- `prefers-reduced-motion` では動きを止め、状態を一瞬で切り替える。起動時のスプラッシュも動きを減らす設定ではロゴを直接出す
- 動きの最中の値は保存しない。ドラッグやスライダーは、離したときに1回だけ確定する

## Voice & Content Strategy

UIの文言は日本語を正とし、英語は `apps/desktop/src/lib/i18n/dictionaries/` の辞書で対応させる。

- ラベルは操作の名前を短く書く。Tooltip は「数式を挿入」のように結果を一言で示し、「ここをクリックすると文書内に新しい数式を追加できます」のような説明文にしない
- ダイアログを開くメニュー項目は「グラフの設定…」「拡張機能を管理…」のように末尾に「…」を付ける
- ボタンは、押すと何が起きるかを書く (「作成して開く」「作成のみ」「取消」)
- 説明文は常時表示しない。補助は Tooltip、プレースホルダー、空状態、一時的な案内で出す
- 「保存しました」「教材を開きました」のような成功や経過の報告は、編集画面には出さない。読み上げ用の非表示の領域には残す
- うまくいかなかったときは、押しても何も起きない状態にせず、その場所の近くに理由を言葉で出す
- 時刻は「今」「5分前」のように経過で書き、正確な日時は Tooltip に出す
- プランで許されない操作は、その操作をした時点で理由を伝える。操作する前から Pro 限定の案内を常設しない
- ショートカットは既定値を直書きせず、ユーザーが変更したあとの現在の割り当てを表示する

## Components

共通部品は `apps/desktop/src/components/ui/` にある。部品を置いただけで仕上げを終わりにせず、閉じた状態のボタンや入力欄から開いたメニューまでを一体として整える。ブラウザやOSの既定の見た目は残さない。

### Buttons

`Button` と `IconButton` (`components/ui/Button.tsx`) を使う。重要度は tone で分ける。

| tone | 見た目 | 使いどころ |
| --- | --- | --- |
| `primary` | `text-primary` の黒い面に白い文字 | その面の主要な操作。1つに絞る |
| `secondary` (既定) | 白い面に `border` の枠 | 通常の操作 |
| `ghost` | 面も枠もなく `text-secondary` の文字 | ツールバー、インスペクタ、ブロックの操作 |
| `danger` | 通常は secondary と同じ無彩色。ホバーで `danger-soft` の面と `danger` の文字 | 削除などの破壊的な操作 |

- 高さは `sm` 30px・`md` 34px・`lg` 40px。文字は 12px / 650 (`lg` は 13px)、角丸は `control`
- ホバーは `surface-muted` の面、押し込んだ状態 (`aria-pressed`) は `surface-muted` の面と `border-strong` の枠、無効は不透明度 0.45
- フォーカスは2pxの青いアウトラインを、2px離して出す
- アイコンだけの操作は `IconButton` を使い、`label` を必ず渡す。形は真円で、画面ごとの CSS で角丸へ戻さない
- 削除のボタン・アイコン・メニュー項目は、ホバーしたときに赤くする。削除を確かめるダイアログの実行ボタンだけは、はじめから `danger` の赤い面にする
- ツールバーでは文字のボタンよりアイコンのボタンを優先し、文字を添えるのはユーザーが迷いやすい主要なコマンドに限る

編集画面のツールバーに並ぶツールボタンは形が違い、34px 四方に `7px` の角丸を持つ (`.icon-button` クラス)。ホバーで `border` の枠と `surface-muted` の面が出て、トグルがONのときは `primary-100` の面になる。関連するボタンは `surface` の面と `border-subtle` の枠を持つグループ (`.toolbar-group`) にまとめ、グループの間は高さ 28px の1pxの線で区切る。

旧来の `.button` クラス (角丸 `7px`、13px / 550) を使う画面も残っている。新しく書くときは `Button` を使う。

閉じる操作は次のように置く。

- ダイアログとポップオーバーを閉じるだけの操作は、右上の `X` のアイコンボタンにする。フッターや本文に「閉じる」「キャンセル」だけの文字ボタンを重ねて置かない
- 取り消しと保存のように、ユーザーがどちらかを選ぶ必要があるときだけ、文脈に合う文字ボタンを置く
- 取り込みの結果のように、結果を知らせるだけのダイアログでは、主ボタンとして「閉じる」を置いている
- 対象の3点ボタンから開く小さな操作メニュー (box の操作、コードブロックの設定) には、タイトルも閉じるボタンも置かない。外側を押すか `Esc` で閉じる。中で選択メニューを開いている間は、最初の `Esc` で選択メニューだけを閉じる

### Inputs

入力欄は何を入れる欄かが画面の上で分かるようにする。

- 横並びの入力欄、座標、範囲、サイズ、余白のように、順序だけでは意味を読み違えやすい項目には `x:` / `y:` のような小さなラベルを付ける。ラベルは入力欄のすぐ近くに置く
- プレースホルダー、`aria-label`、Tooltip だけを、値の意味を示す唯一の手段にしない
- インスペクタやツールバーでは、密度を保ったまま読み違いを防ぐ。広い余白や長い説明文で解決しない
- 数値欄にOS標準のスピナーを見せない。増減が要るときは、直接入力と併用できる `−` / `＋` のボタンを持つ `SettingsNumberField` (`components/editor/SettingsNumberField.tsx`) を使う
- 角丸のように連続して見た目を調整する値には、数値欄と同期するスライダーを併用する
- 数値の単位・最小値・最大値・刻みを揃え、空欄や小数の入力途中を妨げない。確定したときに範囲内の値へ整え、上限と下限では増減ボタンを無効にする
- フォーカスしたら、枠を `primary` にして薄いリングを足す。別のアウトラインを重ねない

### Search Fields

検索欄は共通の `SearchField` (`components/ui/SearchField.tsx`) を使い、独自の `<input>` を組まない。

- 見た目は `round` の角丸と `surface-muted` の面に虫眼鏡。フォーカスすると白い面と `border-subtle` の枠に変わる
- 消去の `X` は文字が入っているときだけ出す。ブラウザ標準の検索クリアボタンは出さない
- 高さは置き場所で選ぶ。ページ上部とコマンドパレットは `lg` (42px)、ダイアログの道具列は `md` (36px、既定)、メニュー・ポップオーバー・サイドバーは `sm` (34px)
- 画面側の CSS には幅と余白だけを書き、面・角丸・フォーカスの見た目は足さない

幅に余裕のないサイドバーの道具列 (右サイドバーのファイル一覧) では、虫眼鏡のアイコンボタンを1つ置き、押すと空いている幅へ広がって入力欄になる形にしている。

- 広がる動きは 180ms で、周囲のボタンと行の高さを動かさない。`prefers-reduced-motion` では動かさない
- 開いた直後は入力欄へ焦点を渡す。文字が入っている間は開いたままにして絞り込みを保つ
- 空のまま焦点が外れたとき、または `Esc` を押したときは虫眼鏡へ畳み、`Esc` では虫眼鏡へ焦点を戻す。文字があるときの最初の `Esc` は文字だけを消す
- 開いている間は、入力欄の中の `X` が閉じる操作を兼ねる (`alwaysShowClear`)

### Selects And Pickers

選択肢から値を選ぶUIは、すべてアプリ内のメニューで表示する。OSが描くドロップダウン、カラーパネル、日付ピッカーは、見た目も操作もプラットフォームごとに変わるので使わない。

- ネイティブの `<select>` は使わず、共通の `Select` (`components/ui/Select.tsx`) を使う
- `Select` は、閉じているときは現在値と `ChevronDown` だけを見せ、開くとアンカー付きのポップオーバーで選択肢を出す。選択中の項目にはチェックを付ける
- キーボードだけで完結させる。`Enter` / `Space` / `↑` / `↓` で開き、`↑` `↓` で移動、`Home` / `End` で端へ移り、文字を打って項目へ移ることもできる。`Enter` で決定し、`Esc` で取り消して呼び出し元へ焦点を戻す
- ダイアログの中で選択メニューが開いている間は、最初の `Esc` でメニューだけを閉じる。親のダイアログまで同時に閉じない
- 線種や文字の太さのように、見本で違いが分かる選択肢にはメニューの中に見本を添える
- ツールバーの選択欄は、通常は枠も面も持たず、ホバーと開いている間だけ `border` の枠と `surface-muted` の面を出す
- サイドバー、ツールバー、リボンのような密なクロームに、現在値と `ChevronDown` を横幅いっぱいの枠付きの箱に入れた「ドロップボタン」を置かない。入力欄のような箱はダイアログやインスペクタの設定フォームで値を選ぶ項目にだけ使う
- クロームで対象 (フォルダ、ページ、表示モードなど) を切り替えるときは、枠と面のない見出し風のトリガー (名前と小さな `ChevronDown`) にする。トリガーは内容の幅にし、ホバーの面を行いっぱいに広げない。長い名前は「…」で切り、隣のアイコンボタンを押し出さない
- 選択肢が数個で、選ぶ対象の形そのものが情報になる排他の選択 (グラフの種類、検索エンジンなど) は、メニューに隠さず `ChoiceGroup` (アイコン付きのカード) で並べる。選択中のカードは `surface-muted` の面と `border-subtle` の枠で示し、枠を太くしない。長いラベルは折り返す
- `<input type="color">` と、`date`・`time` などOSのピッカーを開く入力型は使わない
- 例外はOSでなければ実現できないものだけ。ファイルの選択と保存先の選択 (`<input type="file">`、`dialog.showOpenDialog` / `dialog.showSaveDialog`) がこれにあたる

### Color

色は見本から選ぶことを基本にし、任意の色は「カスタム」段の `+` から開く色作成パネル (`ColorPalette.tsx`・`ColorPickerDialog.tsx`) で作る。

- 色作成パネルは彩度×明度の面、色相のスライダー、HEX と R/G/B の数値欄を持つ。パレットのポップオーバーの中に出る幅 280px の面で、背面を暗くしない。下に「キャンセル」と「OK」を置く
- 不透明度を編集する呼び出しでは、市松模様の上に色を敷いた不透明度のスライダーとA欄を加える。パレット本体にも同じスライダーを置き、色作成パネルを開かなくても決められるようにする
- スライダーの操作中は履歴に残さないプレビューを見せ、離したときに1回だけ確定する。パレットは閉じない
- 図形の塗りと枠線の不透明度は専用のボタンではなくそれぞれの色パレットで決める。図形まるごとの透明度ボタンは色を選べない図形 (画像、グラフなど) と、すでにその値を持つ図形にだけ出す
- 彩度×明度の面と色相の帯は編集対象そのものなので色を持つ。枠・文字・ボタン・面は無彩色のままにする
- 面のようにポインタでしか操作できない部品には、数値欄などキーボードで完結する別の経路を必ず用意する
- 保存する値は色 (`#rrggbb`) と不透明度 (0〜1) を分けて持つ。8桁の HEX は入力と表示のための表記で、保存には使わない
- 「塗りなし」と「不透明度0%の色」は別のものとして、内部の状態でも表示でも区別する
- 実行環境にない機能 (スポイトなど) のボタンは、無効にして置くのではなく描かない

### Dialogs

確認・入力・通知のダイアログはすべてアプリ内の部品で表示する。OSネイティブのダイアログは使わない。

- 新しいダイアログは `ModalFrame`・`ModalHeader`・`ModalBody` (`components/ui/Modal.tsx`) で組み、独自の背面を作らない。参考にする実装は `LinkConfirmationDialog`、`WorkspaceJoinDialog`、`PageSettingsDialog`
- 面は `background` に `border-subtle` の枠、角丸は `dialog`、影は `--shadow-floating`。幅は `sm` 480px・`md` 640px (既定)・`lg` 840px・`xl` 1040px から選び、高さは `min(88vh, 820px)` まで
- 見出しは 18px / 650、説明は 12px の `text-muted`。ヘッダーの内側は `xl` (24px) で、下に `border-subtle` の線を引く
- 閉じる操作は右上の `X`。`Esc` でも閉じ、閉じたら開いた元へ焦点を戻す。開いている間は背面を `inert` で隔離し、フォーカスをダイアログの中で循環させる
- 重なりの順は `layer` と共通トークンに任せ、画面側で `z-index` を上書きしない
- `window.alert`・`window.confirm`・`window.prompt` と、メインプロセスの `dialog.showMessageBox`・`dialog.showErrorBox` は使わない。ESLint (`no-alert`、`no-restricted-properties`) で止めている。メインプロセス起点の確認や通知は `menu:action` などでレンダラーへ転送し、アプリ内のUIで表示する
- `data:text/html` を読み込む即席の `BrowserWindow` を、ダイアログ代わりに作らない
- 教材一覧の作成・削除・確認のダイアログや表の設定などには、`ModalFrame` より前の独自実装 (角丸 16px、幅 420px) が残っている。触るときに `ModalFrame` へ移す

### Menus And Popovers

詳細な選択肢は常時表示せず、メニュー、ポップオーバー、設定ダイアログに収める。

- メニューはアプリ内のポップオーバー (`role="menu"`) で開き、`Esc` で閉じて開いた元へ焦点を戻す
- 面は `background` に `border-subtle` の枠と `--shadow-floating`。項目のホバーは `surface-muted` の面
- 長い文字列はメニューの幅に収まるよう折り返し、項目が多いときは高さに上限を置いてメニューの中でスクロールさせる
- 項目ごとの3点メニューのトリガーには、対象の名前を含むアクセシブルな名前を付ける (「Noto Sans JPのその他の操作」)
- 編集結果をその場で確かめる設定パネルは、背面を暗くするモーダルにしない

### Tooltips

Tooltip (`components/ui/Tooltip.tsx`) は `tooltip-surface` の暗い面に白い 11px の文字で、420ms 待ってから出す。

- アイコンだけでは結果が曖昧な操作にだけ付ける。それ以外のアイコンボタンは標準の `title` で名前だけを出す (`IconButton` は `tooltip` を渡さないと `label` を `title` に入れる)
- 文言は「選択範囲を太字に」「図形を選んで挿入」のように、操作の結果を一行で示す
- 対応するショートカットがあれば、説明と分けて `kbd` で表示する。割り当てが解除されているときは、古い既定のキーを残さずキーの表示を省く

### Selection

「選ばれている」の表し方は部品の種類ごとに決まっている。どれも枠を太くしない。

| 対象 | 選択中の表し方 |
| --- | --- |
| ナビゲーションの項目、リボンのタブ、`ChoiceGroup` のカード | `surface-muted` の薄いグレーの面 |
| ツールバーのトグル | `primary-100` の面。アイコンの色は変えない |
| 一覧の行 | `primary-50` の面と、左端に2pxの `primary` の線 |
| 文書タブ | 白い面と、上端に3pxの `text-primary` の線。未選択のタブは `surface-muted` |
| 本文のブロック、図形 | `primary` の選択枠とハンドル |

ホバーは `surface-muted` の面で示し、青は使わない。ドラッグの落とし先は `primary` の線か薄い面で示す。

### Cards And Lists

- カードは個別の教材ブロック、ダイアログ、一覧の項目に限って使う。ページ全体をカードの連続にしない
- カードの中にカードを入れない。影ではなく境界線と背景差で区切る
- 一覧の行は高さを揃える (教材一覧は 44px)。行ごとの操作ボタンはホバーとフォーカスで出し、出ていないときも場所は取っておく
- 表の列見出しは 11px / 650 の `text-secondary`、行の区切りは `border-subtle` の1px

追加したフォントのように、ユーザーが集めた同じ種類の項目を並べる面は、グリッドのタイルと3点ボタンで組む (`components/editor/extensions/` の `CustomFontsSection` と `ExtensionItemMenu`)。

- タイルには「どんなものか」が分かる見た目 (フォントならその書体で描いた見本) と短い名前だけを置く。タイルは「見本の面と名前の行」の1段にする
- ファイル名・パス・追加日・サイズのような、見分けるために毎回は要らない情報は、3点メニューの先頭に淡い文字で収める
- 削除や名前の変更などの項目ごとの操作も3点メニューへ収める。削除は文字付きの `danger` の項目にし、アイコンだけのゴミ箱を項目ごとに並べない
- 3点ボタンは常に見える位置に置く
- 名前は1行に保ち、はみ出すときは Overflow Fade で薄れさせる
- 列は `Grid` で揃え、狭い幅では1列へ戻す。空のときは破線の枠に短い一文だけを出す

素材ライブラリと公式プラグインは、この形になっていない。素材のタイルは説明とタグ (3つまで) を常に見せ、3点ボタンはホバーとフォーカスで出す。公式プラグインは設定の行で、説明とインストール済みのバージョンを常に見せる。

### Loading

待ち時間は読み込んだあとの形に近い骨組みで示す。回るアイコンだけに頼らない。

- 本文、アウトライン、一覧、カードの骨組みは `.shimmer-line` / `.shimmer-block` で描く。`surface-muted` の面の上を、白い光の帯が 1.8 秒の周期で横切る。読み込んだあととほぼ同じ大きさにして、表示が切り替わるときのずれを抑える
- 文字や面をゆっくり明滅させるときは `Shimmer` (`components/ui/Shimmer.tsx`。`text`・`marker`・`surface`・`icon`) を使う。不透明度を 1.4 秒の周期で上下させる
- AIの実行、検索、履歴の読み込みのように、終わるまでユーザーが待つ画面でも Shimmer を使う。AIの実行では Thinking Orb (`AiThinkingOrb`) を状態のアイコンとして併用できる
- ボタンの中、文書タブ、トースト、コメントとブックマークの一覧の処理中には、回るアイコン (`Loader2`) を使っている
- 保存中と同期中は Shimmer ではなく、文書タブの点などの状態表示で伝える
- 画面全体をふさぐ読み込みは、初回の表示やファイルの切り替えなど必要な場面に限る

### Empty And Error States

空の状態とエラーの状態でも、説明を増やしすぎない。

- 一覧やパネルの空状態は、アイコン、短い1行、必要なら補足の1文で組む。次に取る操作があるときだけ、ボタンを1つ置く (`WorkspaceEmptyState`)
- メニューや候補リストの空状態は、1行の文だけでよい
- エラーは派手にせず、該当箇所の近くに出す。入力した値は消さない

```text
[image icon]
画像がありません
ドラッグして追加
```

### Status And Toasts

- 教材一覧では、画面の左下にトーストを出す。`text-primary` の暗い面に白い文字で、成功は約 2.6 秒で消える。エラーは `danger` の面になり、次の操作まで残る
- 編集画面では、右上の状態表示にエラーと警告だけを出す。保存中・保存済み・エラーは文書タブの点 (7px) の色で示す
- 読み上げが鳴り続ける場所 (ステータスバーなど) は `role="status"` にしない

### States And Accessibility

操作できる要素には、通常・ホバー・押下・選択・フォーカス・無効・処理中・エラーの状態を用意し、実際の画面で確かめる。

- 状態の違いを色だけに頼らない。面、境界線、アイコン、Tooltip、補助の文を組み合わせる
- アイコンボタンにはアクセシブルな名前を付ける
- キーボードのフォーカスは2pxの `primary` のアウトラインで示す。共通の `Button` は32%に薄めた色を使い、グレーの面に載る `ChoiceGroup` は薄めない色を使う (選択中のグレーの上では、薄い色のリングが見えない)
- 見た目を変えても、入力の意味、アクセシブルな名前、キーボード操作を失わない
- 破壊的な操作は確認するか取り消せるようにする

## Do's and Don'ts

### Do

- 白・黒・グレーで面と階層と状態を作り、青は選択・フォーカス・挿入位置にだけ使う
- 教材と編集対象をいちばん目立たせる
- アイコンで操作を示し、曖昧なものにだけ Tooltip を付ける
- 余白は `--space-*`、配置は `Stack`・`Inline`・`Inset`・`Center`・`Grid` で組む
- 角丸・影・重なりは `--radius-*`・`--shadow-floating`・`--z-*` を使う
- 選択肢・確認・色の入力はアプリ内の `Select`・`ModalFrame`・`ColorPalette` で完結させる
- 状態が変わったら、その場所の近くで伝える
- 部品を変えたら、通常・ホバー・フォーカス・選択・無効の状態を Electron の実画面で確かめる
- 共通部品を足したら、公開 export の JSDoc と `components/ui/README.md` の一覧を一緒に更新する

### Don't

- 見た目の凝った表現を、操作の分かりやすさより優先しない
- 説明文を画面に並べない。成功の報告を編集画面に出さない
- 強い色、グラデーション、広い面の青を使わない
- カードやタイルに影を付けない。カードを入れ子にしない
- 選択を枠の太さで示さない
- 任意の `margin`・`padding`・`gap`、画面ごとの角丸・影・`z-index` を増やさない
- OSが描くUI (ネイティブの `<select>`、`window.confirm`、カラーパネル、日付ピッカー) を操作面にしない
- 密なクロームに、横幅いっぱいの枠付きドロップボタンを置かない
- アイコンだけで危険な操作を即実行しない
- 主要な操作と重要な状態を、ホバーしないと見えない場所に置かない
- 追加した項目の一覧に、ファイル名・日付・削除ボタンを行ごとに並べない
- 印刷とPDFの出力に、アプリのUIの見た目を持ち込まない
