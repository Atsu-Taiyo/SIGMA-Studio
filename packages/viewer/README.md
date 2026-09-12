# @sigma-studio/viewer

SigmaDoc教材をReactアプリ内で安全に表示する、閲覧専用の軽量Viewerです。

## パッケージの選び方

| 用途 | パッケージ |
| --- | --- |
| 教材を表示する | `@sigma-studio/viewer` |
| 教材をWeb上で編集する | `@sigma-studio/editor` |

Viewerには編集UI、保存、認証、AI、Electron API、外部assetの取得は含まれません。ホストアプリがSigmaDocの取得と状態管理を担当します。

## インストール

```sh
npm install @sigma-studio/viewer
```

## 基本的な使い方

```tsx
import { SigmaDocViewer, type SigmaDocument } from "@sigma-studio/viewer";
import "@sigma-studio/viewer/styles.css";

export function MaterialPage({ document }: { document: SigmaDocument }) {
  return (
    <SigmaDocViewer
      document={document}
      onError={(error) => console.error(error)}
    />
  );
}
```

ホストが新しい`document`オブジェクトを渡すと、ViewerはSigmaDocを再検証して表示を更新します。Viewer自身はfetch、polling、保存を行いません。

## AIコーディングエージェントに導入させる

AIエージェントは次の順序で導入してください。

1. ホストがReact `>=18.2.0 <20`を使用していることを確認する
2. `npm install @sigma-studio/viewer`を実行する
3. アプリのentry pointで`@sigma-studio/viewer/styles.css`を一度だけ読み込む
4. APIや保存層から受け取る`unknown`値を`parseSigmaDocument`で検証する
5. 検証済みの`SigmaDocument`を`SigmaDocViewer`の`document`へ渡す
6. ホスト側のtypecheckとbuildを実行する

独自のHTML変換やTiptap変換を間に挟まず、SigmaDoc JSONを表示の正本にしてください。Viewer内部のDOM、CSS class、canvas状態には依存せず、公開されているpropsだけを使用します。

次の指示をそのままAIエージェントへ渡せます。

```text
このReactプロジェクトへ @sigma-studio/viewer を導入してください。

要件:
- 既存のpackage managerとReact構成を確認し、@sigma-studio/viewerを追加する
- @sigma-studio/viewer/styles.cssをアプリ全体で一度だけ読み込む
- 外部から取得した教材JSONはparseSigmaDocumentで検証する
- 検証済みSigmaDocumentをSigmaDocViewerのdocument propへ渡す
- Viewerにfetch、保存、認証の責務を持たせない
- SigmaDoc JSONを正本とし、HTMLやTiptap JSONへ永続化しない
- 内部moduleや内部CSS classをimportしない
- 既存UIに合わせた必要最小限のcontainerだけ追加する
- 実装後にtypecheckとproduction buildを実行し、変更ファイルと検証結果を報告する
```

## API

### `SigmaDocViewer`

```ts
interface SigmaDocViewerProps {
  document: SigmaDocument;
  visibleParts?: readonly ("problem" | "solution" | "comments")[];
  hideProblemNumbers?: boolean;
  maxHeightPx?: number;
  className?: string;
  style?: React.CSSProperties;
  onError?: (error: SigmaDocViewerError) => void;
}
```

本文は選択・コピーできます。URL形式の本文も自動リンク化せず、通常の文字列として表示します。オーバーレイは表示専用で、編集ハンドルやツールバーは描画されません。問題の問題文、解答、ヒント、解説はすべて表示し、制作コメントは表示しません。

`visibleParts`を指定すると、problem外の本文を除外して、次の問題領域だけを組み合わせて表示できます。未指定時は従来どおり全内容を表示します。

- `problem`: 導入文と問題文 (`lead` / `prompt`)
- `solution`: 解答 (`solution`)。短い正答の`answer`は含みません
- `comments`: 編集画面上の問題内コメント (`hints`)

```tsx
<SigmaDocViewer document={document} visibleParts={["problem"]} />
<SigmaDocViewer document={document} visibleParts={["solution"]} />
<SigmaDocViewer document={document} visibleParts={["problem", "solution"]} />
<SigmaDocViewer document={document} visibleParts={["comments"]} />
```

`hideProblemNumbers`はSigmaDocの採番設定より優先して問題番号を非表示にします。`maxHeightPx`に正のpx値を指定すると、その高さを超えた場合だけ下端をフェードし、「すべて表示」ボタンを表示します。このボタンは表示範囲を広げるだけで、SigmaDocを変更しません。

### Validation

`parseSigmaDocument`は外部から取得したunknown値をSigmaDoc v2として検証・正規化します。

```ts
const document = parseSigmaDocument(await response.json());
```

## 画像の扱い

画像assetの`props.src`には次のdata URLだけを使用できます。

- `data:image/png`
- `data:image/jpeg`
- `data:image/webp`
- `data:image/svg+xml`

PNG、JPEG、WebPはbase64形式と実ファイル署名を検証します。SVGはbase64またはpercent-encoded UTF-8を受け付け、script、event属性、外部resource参照を含まない自己完結した内容だけを表示します。SVG文字列はDOMへ展開せず、SVGの`<image>`として描画します。位置、寸法、crop、回転、透明度、前景・背景、anchorをSigmaDocの指定どおり再現します。

外部URL、`blob:`、`sigma-doc-storage://`、空のsource、存在しないassetは取得しません。同じ画像枠にplaceholderを表示し、`onError`へ`unsupported-asset`を通知します。

## 互換性

- React / React DOM: `>=18.2.0 <20`
- SigmaDoc: `version: "2.0"`
- CSS: `@sigma-studio/viewer/styles.css`

パッケージのバージョンはSigma Studio本体と揃えて公開します。

## 開発

以下はこのリポジトリの開発者向けコマンドです。リポジトリルートで実行します。

```sh
npm run viewer:typecheck
npm run viewer:test
npm run viewer:build
npm run viewer:pack
npm run viewer:example
```

`npm run viewer:pack`は公開せず、npm packageの内容だけを確認します。

### CSSの視覚回帰テスト

`src/styles-sync.test.ts`はスタイルシート同士をテキストとして突き合わせるだけで、**適用した結果**は見ていません。値のずれ（`--editor-font-size`の変更、共有`document-surface.css`の余白変更など）はこれをすり抜けます。

その差分を数値で捕まえるのが`apps/desktop/tests/e2e/viewer-css-parity.spec.ts`です。`packages/viewer/dist`を実ブラウザに配って代表文書を描き、`.sigma-viewer`配下の全要素について`getComputedStyle`と`getBoundingClientRect`を採取し、コミット済みベースラインと比較します。差分は`<要素> | <プロパティ>`の行として出ます（スクリーンショット比較ではありません）。

```sh
# 1. dist を作る。作業ツリーのパスに非ASCII文字が含まれる場合は
#    scripts/build.mjs の new URL().pathname が percent-encode されて失敗するので、
#    ASCIIパスのクローン（git worktree add --detach /tmp/<name> <ref> + node_modules を cp）で実行し
#    packages/viewer/dist をコピーして戻す。
npm run viewer:build

# 2. 走らせる（Next の dev server は不要。spec が自前で静的サーバを立てる）
cd apps/desktop
SIGMA_STUDIO_E2E_BASE_URL=http://127.0.0.1:<空きポート> \
  npx playwright test tests/e2e/viewer-css-parity.spec.ts
```

`dist`が無い、または`dist/styles.css`が元のCSS（`packages/viewer/src/styles.css` / `apps/desktop/src/app/document-surface.css`）より古い場合は、理由付きでskipされます。古いビルドを測ると「作業ツリーに既にある退行」を緑と報告してしまうためです。

ベースラインの更新は`--update-snapshots`を付けて再実行し、**差分を1行ずつ読んでから**コミットします。ファイル名にはPlaywrightのplatform suffix（`-chromium-darwin`）が付きます。フォントとChromiumのビルドに依存する計測なので、書き出した機械・ブラウザでのみ意味を持ちます。

## ライセンス

MIT
