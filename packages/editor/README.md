# @sigma-studio/editor

SigmaDoc教材のWeb編集をReactサイトへ組み込むEditorパッケージです。閲覧専用のサイトには、より軽量な`@sigma-studio/viewer`を使用してください。

## パッケージの選び方

| 用途 | パッケージ |
| --- | --- |
| 教材を表示する | `@sigma-studio/viewer` |
| 教材をWeb上で編集する | `@sigma-studio/editor` |

## 含まれるもの

- `SigmaDocViewer`: 問題・解答・コメントの出し分け、問題番号上書き、高さ制限を持つRead専用表示
- `SigmaDocEditor`: デスクトップ版と同じ編集UIを組み込み、`onChange` / `onSave`へ完全なSigmaDocumentを返すcontrolled editor
- `parseSigmaDocument`: 外部JSONを正規スキーマで検証
- `importTexDocument` / `importTexProblem`: TeX文書、または問題文・解説の別フィールドをSigmaDocへ変換

教材一覧、認証、データ取得、永続化、AI/MCP、Electron API、デスクトップ専用の教材import機能は含みません。これらは組み込み先のアプリが担当します。

## インストール

```sh
npm install @sigma-studio/editor
```

entry pointでCSSを一度読み込みます。

```tsx
import "@sigma-studio/editor/styles.css";
```

`SigmaDocEditor`はブラウザ専用です。Viteなどのclient-side Reactアプリでは通常のimportを使用できます。SSRを行うフレームワークでは、Editor componentをSSR対象から外してください。

Next.js App Routerでは、global CSSをroot layoutで読み込み、Editorをclient componentからdynamic importします。

```tsx
// app/layout.tsx
import "@sigma-studio/editor/styles.css";
```

```tsx
// components/SigmaEditorClient.tsx
"use client";

import dynamic from "next/dynamic";
import type { SigmaDocEditorProps } from "@sigma-studio/editor";

const SigmaDocEditor = dynamic<SigmaDocEditorProps>(
  () => import("@sigma-studio/editor").then((module) => module.SigmaDocEditor),
  { ssr: false },
);

export function SigmaEditorClient(props: SigmaDocEditorProps) {
  return <SigmaDocEditor {...props} />;
}
```

## Viewerを使う

```tsx
import { SigmaDocViewer, type SigmaDocument } from "@sigma-studio/editor";

export function AnswerPage({ document }: { document: SigmaDocument }) {
  return (
    <SigmaDocViewer
      document={document}
      visibleParts={["problem", "solution"]}
      hideProblemNumbers={false}
      maxHeightPx={760}
    />
  );
}
```

`visibleParts`は`problem`、`solution`、`comments`を自由に組み合わせられます。未指定なら完全版です。`maxHeightPx`を超えた場合だけFadeと「すべて表示」を出します。

## TeXの問題を取り込む

```ts
import { importTexDocument, importTexProblem } from "@sigma-studio/editor";

// .texファイル全体、または本文だけのTeX
const document = importTexDocument(texSource, "入試問題.tex");

// 問題投稿フォームなどの、別々に管理された問題文と解説
const problem = importTexProblem({
  title: "二次関数の最小値",
  preamble: String.raw`\providecommand{\sq}[1]{#1^2}`,
  prompt: String.raw`$f(x)=\sq{x}+1$ の最小値を求めよ。`,
  solution: String.raw`$\sq{x}\geq0$ より、最小値は $1$。`,
  tags: ["数と式"],
});
```

返り値を `SigmaDocEditor.document` または `SigmaDocViewer.document` に渡せます。変換ごとに新しい文書IDを発行します。`prompt` と `solution`、任意の `hints` はSigmaDocの問題エリアに分かれ、マクロは同じ問題内で共有されます。変換時のエラーは例外として返すため、呼び出し元で表示してください。

受験数学研究所のTeXに使われる必須引数マクロ、`enumerate` の数字付き小問、`label=(\arabic*)`、`start=`、`\item[(1)]`、別行数式、`aligned` / `cases` / 行列に対応します。任意のLaTeXパッケージは実行しません。TikZや未対応の表・環境は、描画の代わりに編集可能なTeXソースとして残します。

## Editorを使う

```tsx
import { useState } from "react";
import {
  SigmaDocEditor,
  type SigmaDocument,
} from "@sigma-studio/editor";

export function MaterialEditor({ initialDocument }: { initialDocument: SigmaDocument }) {
  const [document, setDocument] = useState(initialDocument);

  return (
    <SigmaDocEditor
      document={document}
      onChange={(nextDocument, change) => {
        setDocument(nextDocument);
        console.log(change.path);
      }}
      onSave={async (nextDocument) => {
        await fetch(`/api/materials/${nextDocument.docId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(nextDocument),
        });
      }}
    />
  );
}
```

`SigmaDocEditor`は、デスクトップ版の`EditorShell`と汎用editor componentを再利用します。本文・数式・問題・ページ・overlay図形・グラフ・表・画像の編集操作、ツールバー、選択UIはデスクトップ版と共通です。編集のたびに`change.path === "$"`、`change.source === "desktop-editor"`として完全なSigmaDocを返します。

AI編集と独自教材形式のimportはデスクトップ専用拡張です。公開Editorのbuildでは、それらへの依存を無効なadapterへ差し替え、実装moduleを公開bundleへ含めません。build時にはesbuildの入力一覧と出力bundleも検査し、デスクトップ専用moduleや識別文字列が混入した場合は失敗します。このためAIメニュー、AI選択アクション、AI設定、デスクトップ版への誘導placeholder、デスクトップ専用のimport形式は表示しません。

Electronのworkspace/library、AI/MCP、認証は接続しません。教材一覧・新規作成・複製・削除は組み込み先が担当し、編集結果の永続化は`onSave`で受け取ります。`onSave`を指定した場合は編集停止から450ms後に呼ばれ、保存中表示は`onSave`の実行中だけ表示します。PDFプレビューからの保存はデスクトップ用routeやローカルfileIdを使わず、ブラウザの印刷画面を開きます。

`document` stateは`onChange`だけが更新します。`onSave`は永続化専用のフックであり、その中で`setDocument`しないでください(サーバーレスポンスを書き戻す場合も同様)。保存の完了を待つ間にユーザーが入力を続けていると、古いスナップショットで最新の入力を上書きしてしまい、それが再びdirtyとして次の自動保存を呼び、保存表示が止まらなくなる自走ループになります。`document`へ新しい値を渡すのは、別の教材を開いた場合など、エディタの外で本当に文書が切り替わったときだけです。

実際の数学解答共有サイト、表示パラメータ操作、編集route、保存後の再表示は`examples/editor-react18`にあります。

## AIコーディングエージェントに導入させる

AIエージェントは次の順序で導入してください。

1. ホストがReact `>=18.2.0 <20`を使用していることを確認する
2. `npm install @sigma-studio/editor`を実行する
3. `@sigma-studio/editor/styles.css`をアプリ全体で一度だけ読み込む
4. SSR環境では`SigmaDocEditor`をclient-onlyのdynamic importにする
5. 外部の`unknown`値を`parseSigmaDocument`で検証する
6. `document`をホスト側のstateで所有し、`onChange`でだけ編集結果をstateへ反映する
7. `onSave`では永続化だけを行い、保存レスポンスで編集中のstateを上書きしない
8. ホスト側のtypecheckとproduction buildを実行する

SigmaDoc JSONを正本にし、Editor内部のTiptap JSON、HTML、DOM、CSS class、canvas状態を保存形式や連携APIにしないでください。教材一覧、認証、API通信、保存先はホスト側に実装し、公開packageの内部moduleはimportしません。

次の指示をそのままAIエージェントへ渡せます。

```text
このReactプロジェクトへ @sigma-studio/editor を導入してください。

要件:
- 既存のpackage manager、React version、SSRの有無を最初に確認する
- @sigma-studio/editorを追加し、styles.cssをアプリ全体で一度だけ読み込む
- SSR環境ではSigmaDocEditorをssr:falseのclient-only dynamic importにする
- 外部から取得した教材JSONはparseSigmaDocumentで検証する
- SigmaDocumentはホスト側のcontrolled stateとして保持する
- onChangeで受け取った最新documentだけをstateへ反映する
- onSaveはAPIやstorageへの永続化だけを行い、setDocumentを呼ばない
- 教材の切り替え時だけ外部から新しいdocumentを渡す
- SigmaDoc JSONを正本とし、Tiptap JSON、HTML、DOM、canvas状態を永続化しない
- AI/MCP、認証、教材一覧、Electron APIをpackage内部に求めず、必要ならホスト側で実装する
- @sigma-studio/editorの内部moduleや内部CSS classをimportしない
- 実装後にtypecheckとproduction buildを実行し、変更ファイルと検証結果を報告する
```

## Editor API

```ts
interface SigmaDocEditorProps {
  document: SigmaDocument;
  onChange: (
    document: SigmaDocument,
    change: {
      document: SigmaDocument;
      path: "$";
      source: "desktop-editor" | "reset";
    },
  ) => void;
  onSave?: (document: SigmaDocument) => void | Promise<void>;
  className?: string;
  style?: React.CSSProperties;
  editorRef?: { current: SigmaDocEditorHandle | null };
  /** UI表示言語。省略時はブラウザ/OSロケールを検出し、判定できなければ日本語。 */
  locale?: "ja" | "en";
}

interface SigmaDocEditorHandle {
  getDocument(): SigmaDocument;
  reset(document?: SigmaDocument): void;
  focus(): void;
}
```

## 表示言語

`locale`に`"ja"`か`"en"`を渡すとEditorのUI言語が切り替わります。省略した場合は「以前この端末で選ばれた言語 → ブラウザ/OSのロケール → 日本語」の順で決まります。

言語を渡すと、その選択はホストページの`localStorage`(`sigma-studio:ui-locale`)に残ります。したがって**一度`locale="en"`を渡した後にpropを外しても英語のまま**です。ホスト側が言語を所有している場合は、propを外さずに現在の言語を渡し続けてください。

ホストページの`<html lang>`は変更しません(ページ全体の言語指定はホストのものだからです)。読み上げやハイフネーションを表示言語に合わせたい場合は、ホスト側で`document.documentElement.lang`を設定してください。

言語設定はモジュールグローバルです。**1つのページに2つの`SigmaDocEditor`を別々の言語で置くことはできません** (後からmountした方の`locale`が両方に効きます)。インスタンスごとに言語を分ける必要が出た場合は、i18nextインスタンスを分ける対応が必要です。

## 互換性

- React / React DOM: `>=18.2.0 <20`
- SigmaDoc: `version: "2.0"`
- CSS: `@sigma-studio/editor/styles.css`

パッケージのバージョンはSigma Studio本体と揃えて公開します。

## ライセンス

MIT
