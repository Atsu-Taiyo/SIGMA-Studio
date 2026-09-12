# Sigma Studio Web組み込みガイド

`@sigma-studio/viewer`はSigmaDoc教材のRead専用表示、`@sigma-studio/editor`はWeb編集をReactサイトへ組み込む公開パッケージです。Editorからも`SigmaDocViewer`を利用でき、完全なSigmaDocをホストへ返すcontrolled editorの`SigmaDocEditor`と同じ入口から使えます。

Editorパッケージが担当するのはSigmaDocの検証・表示と、Sigma Studioデスクトップ版の`EditorShell`をそのまま使う編集UIです。次の機能はホストアプリまたはSigma Studioデスクトップ版のElectron runtimeが担当します。

- 認証、権限、教材一覧、ルーティング
- APIからの取得、キャッシュ、更新通知
- APIへの保存、共同編集
- Electron workspace/library、AI、MCP、認証

## Installation

公開後はホスト側で通常のnpm dependencyとして導入し、ホストのリリース時にバージョンを更新します。

```sh
npm install @sigma-studio/editor
```

このmonorepo内で動作確認する場合は、React 18の組み込み例を使えます。

```sh
npm install
npm run editor:build
npm run editor:example
```

## Basic Usage

CSSはホストアプリのentry pointで一度だけ読み込みます。

```tsx
import {
  SigmaDocViewer,
  parseSigmaDocument,
  type SigmaDocument,
  type SigmaDocViewerError,
} from "@sigma-studio/editor";
import "@sigma-studio/editor/styles.css";

interface MaterialPageProps {
  document: SigmaDocument;
}

export function MaterialPage({ document }: MaterialPageProps) {
  const handleViewerError = (error: SigmaDocViewerError) => {
    console.error(error);
  };

  return <SigmaDocViewer document={document} onError={handleViewerError} />;
}
```

外部APIのレスポンスは、Viewerへ渡す前にも検証できます。

```ts
const response = await fetch(`/api/materials/${materialId}`);
const document = parseSigmaDocument(await response.json());
```

## Updating A Document

ViewerはSigmaDocを取得しません。ホストが新しい`document`オブジェクトを渡すと、再マウントや`updatedAt`の変更なしで再検証・再描画します。

```tsx
const [document, setDocument] = useState(initialDocument);

useEffect(() => {
  return materialStore.subscribe((nextDocument) => {
    setDocument(nextDocument);
  });
}, []);

return <SigmaDocViewer document={document} />;
```

同じオブジェクトを直接変更するとReactが更新を検出できません。ホストは更新ごとに新しいSigmaDocumentオブジェクトを渡してください。

## 問題領域の部分表示

`visibleParts`を指定すると、problem外の見出し・本文を除外し、全problemから指定領域だけを表示できます。`problem`は`lead`と`prompt`、`solution`は解答本文、`comments`は編集画面で「コメント」と呼ぶ`hints`です。短い正答を持つ`answer`は部分表示へ含めません。

```tsx
// 問題だけ
<SigmaDocViewer document={document} visibleParts={["problem"]} />

// 解答だけ
<SigmaDocViewer document={document} visibleParts={["solution"]} />

// 問題と解答
<SigmaDocViewer document={document} visibleParts={["problem", "solution"]} />

// 問題内コメントだけ
<SigmaDocViewer document={document} visibleParts={["comments"]} />
```

選択した領域へblock-anchorされた図形は残り、非表示領域、page-anchorの図形、header/footerは除外されます。特定のproblem IDだけを抽出するAPIではなく、document内の全problemへ同じ指定を適用します。

問題番号と表示高さもViewer側から上書きできます。

```tsx
<SigmaDocViewer
  document={document}
  visibleParts={["problem", "solution"]}
  hideProblemNumbers
  maxHeightPx={420}
/>
```

`hideProblemNumbers`はSigmaDocの`numbering`設定より優先します。`maxHeightPx`は正の有限値だけを受け付け、実際に内容が溢れた場合だけ下端フェードと「すべて表示」ボタンを出します。展開操作は表示制限を解除するだけで、document更新や編集は行いません。document、表示領域、または高さ指定が変わると再び折りたたみ状態から判定します。

ホストは`PageOverlay`をSigmaDocの一部として永続化します。`overlaySnapshot`が唯一の正本で、SVG previewは必要なときにsnapshotから再生成します。直列化済みのSVG文字列は保存せず、`overlaySnapshot`を持たないoverlayは正規化時に破棄されます。

`graph3dShape`では`props.spec`が数学的な正本で、Three.js sceneは保存しません。`previewAssetId`が指すPNGはread-only Viewer・印刷用の派生cacheです。ホストはspecとpreview assetをともにSigmaDocへ保存しますが、previewだけから3D内容を復元してはいけません。ViewerはこのPNGを通常の画像assetと同じdata URL制約で検査し、Three.jsや数式評価器を公開read-only画面では起動しません。

## ViewerのRead-only Boundary

`SigmaDocViewer`内には編集ツールバー、フォーム、`contenteditable`、選択ハンドル、保存ボタン、印刷ボタンを置きません。本文は通常のWebコンテンツとして選択・コピーできますが、オーバーレイは`pointer-events: none`の表示専用レイヤーです。高さ制限時の「すべて表示」は閲覧範囲だけを変更する補助操作です。編集が必要な画面では、Viewerを編集可能に切り替えるのではなく`SigmaDocEditor`へ遷移します。

`visibleParts`未指定時、問題ノードは問題文、answer、hints、solutionをすべて表示します。`outputProfiles`による生徒版・教師版の切り替えは行わず、制作コメントは表示しません。

編集は`SigmaDocEditor`で行います。独自のWeb用フォームではなく、デスクトップ版と同じ本文・数式・ページ・自由配置overlayの編集UIを使います。

## Images

v1のViewerは自己完結した教材だけを表示するため、overlay assetの`props.src`として次のdata URLを受け付けます。

- `data:image/png`
- `data:image/jpeg`
- `data:image/webp`
- `data:image/svg+xml`

PNG、JPEG、WebPはbase64形式と実ファイル署名を検証します。SVGはbase64またはpercent-encoded UTF-8を受け付け、script、event属性、外部resource参照を含まない自己完結した内容だけを表示します。画像shapeの位置、寸法、crop、回転、透明度、前景・背景、block/page anchorをSigmaDocの指定から描画します。SVGも内容をDOMへ展開せず、SVGの`<image>`として扱います。

次のsourceはViewerから取得しません。

- `http:` / `https:` の外部URL
- `blob:` URL
- デスクトップ専用の`sigma-doc-storage://` URL
- 空のsourceまたは存在しないasset

未対応assetはshapeと同じ領域にplaceholderを表示し、`onError`へ`unsupported-asset`を通知します。署名URLの発行やremote asset resolverが必要なサイトでは、ホスト側で画像をdata URLへ変換してからSigmaDocを渡します。

## Data Boundary

正本は常にSigmaDoc JSONです。HTML、TeX、Tiptap JSON、SVG、編集用overlay stateをホスト側の保存形式にしないでください。

- 現行の読込対象は`version: "2.0"`です。
- TeXは`mathInline`ノードの中だけに置きます。
- 用紙寸法、余白、段組み、header/footerは`pageLayout`に保存します。
- 図、グラフ、表、画像は`pageLayout.overlay.overlaySnapshot`に保存します。
- overlayは`overlaySnapshot`だけが正本で、直列化済みSVGは保存しません。

フィールド単位の契約は[SigmaDoc Schema](sigma-doc-schema.md)を参照してください。

## Layout And Styling

Viewerはページを縦に並べます。表示領域が用紙より広い場合は実寸、狭い場合は縦横比を保ったままコンテナ幅へ縮小します。Viewer内にズーム操作UIはありません。

Viewer固有のCSSは`.sigma-viewer`配下へ限定されています。ホスト側ではViewerの外側に余白、背景、スクロール領域を設定してください。KaTeXとMathLiveは、それぞれ固有のclassに対する表示用CSSも`styles.css`から読み込まれます。

## Error Handling

不正なSigmaDocや描画不能なデータでホスト全体を例外終了させず、Viewer領域に`role="alert"`の固定エラーを表示します。診断が必要な場合だけ`onError`を指定してください。

```ts
type SigmaDocViewerError =
  | { code: "invalid-document"; message: string; issues: readonly string[] }
  | { code: "unsupported-asset"; message: string; assetId: string }
  | { code: "render-failed"; message: string };
```

## Compatibility

- React / React DOM: `>=18.2.0 <20`
- SSR: packageのimportは可能。hydration完了までは安定したshellを表示します。
- Browser: ResizeObserver、Font Loading APIなどが無い環境では利用可能な範囲で表示し、hostを停止させません。

React 18での閲覧・編集round-tripは`examples/editor-react18`を参照してください。長い数学問題と解答を持つ共有ページ、表示パラメータ操作、別routeの編集ページ、保存後の再表示までを含みます。

## SigmaDocEditorを組み込む

ホストはSigmaDocをstateとして所有し、`onChange`で毎回返る新しいSigmaDocumentをstateへ反映します。`onSave`には、その時点で画面に表示されている完全なSigmaDocが編集停止から450ms後に渡されます。保存中表示はデバウンス待ちでは動かさず、`onSave`の実行中だけ表示するため、入力中に保存アイコンが点滅し続けません。

`onSave`はあくまで永続化専用のフックで、controlled documentの書き戻し先ではありません。サーバーが返したレスポンス(保存確認、正規化後のJSONなど)を`onSave`の中で`setDocument`してはいけません。保存には数百msかかることがあり、その間もユーザーは入力を続けられるため、保存完了時点で`setDocument`すると、保存に着手した時点より新しい入力を古いスナップショットで上書きしてしまいます。上書きされた文書は再びdirtyとして扱われて次の自動保存を呼び、その保存がまた`onSave`を経由して同じスナップショットを返す…という自走ループになり、保存インジケーターが止まらなくなります。`document`へ新しい値を渡すのは、別の教材を開いた・他クライアントの編集を取り込んだといった、エディタの外で本当に文書が切り替わったときだけにしてください。

```tsx
import { useState } from "react";
import {
  SigmaDocEditor,
  type SigmaDocument,
} from "@sigma-studio/editor";
import "@sigma-studio/editor/styles.css";

export function MaterialEditorPage({ initialDocument }: { initialDocument: SigmaDocument }) {
  const [document, setDocument] = useState(initialDocument);

  return (
    <SigmaDocEditor
      document={document}
      onChange={(nextDocument, change) => {
        setDocument(nextDocument);
        console.log("changed path", change.path);
      }}
      onSave={async (nextDocument) => {
        // 永続化のみ。ここでsetDocumentすると、保存中に進んだ入力を
        // レスポンスのスナップショットで上書きしてしまい自走ループになる。
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

`SigmaDocEditor`は`apps/desktop/src/components/editor/EditorShell.tsx`を正本の編集surfaceとして束ねます。ツールバー、本文・問題・インライン数式、ページ設定、自由配置overlay、図形、グラフ、表、画像、選択、undo/redoはデスクトップ版と同じコンポーネントです。Editor側に別の構造編集フォームやJSON編集タブはありません。AI編集はEditorへ公開せず、AIメニュー、選択時のAIアクション、AI設定、AIプレースホルダーを組み込み時には構成しません。

組み込み時はElectron bridgeを接続しないため、workspace/libraryに属する教材一覧、新規作成、複製、削除、AI/MCP、デスクトップ認証は無効です。JSON/TeXのインポートは現在のcontrolled documentを置き換え、JSON exportはブラウザダウンロードを使います。PDFプレビューの`PDF保存`はデスクトップ固有の`/print?fileId=...`へ遷移せず、表示中の共通PrintPreviewをブラウザ印刷へ渡します。ホストは`onChange` / `onSave`の外側で取得、権限、routing、永続化、共同編集を接続します。HTML、Tiptap JSON、編集用canvas stateを別の正本にせず、常に完全なSigmaDocを往復させます。

`onChange`の`change.path`は常に`"$"`、`change.source`は通常編集で`"desktop-editor"`、`editorRef.reset()`で`"reset"`です。デスクトップ編集surface内の複数操作を公開API側で不完全なfield patchへ変換しないため、ホストは第1引数の完全なSigmaDocumentを正本として扱います。

編集routeを分ける場合は、閲覧ページで`SigmaDocViewer`、`/materials/:id/edit`で`SigmaDocEditor`を使い、同じSigmaDocument stateまたはAPIを共有します。`editorRef`へmutable objectを渡すと、`getDocument()`、`reset()`、`focus()`をホスト操作から呼び出せます。

`locale`に`"ja"` / `"en"`を渡すとEditorのUI言語が切り替わります。省略時は「以前この端末で選ばれた言語 → ブラウザ/OSのロケール → 日本語」の順です。言語を渡すとその選択は`localStorage`の`sigma-studio:ui-locale`に残るため、**一度渡した後にpropを外しても直前の言語のまま**になります。ホストページの`<html lang>`は変更しません (ページ全体の言語指定はホストのものなので、必要ならホスト側で設定してください)。**言語設定はモジュールグローバルなので、1ページに2つの`SigmaDocEditor`を別々の言語で置くことはできません**。ホストが自前の言語切り替えUIを持つ場合は、その値をそのまま`locale`へ渡し続けてください。

## Release Boundary

EditorとViewerはデスクトップアプリと独立したSemVerを持ちます。ホストは依存バージョンを更新して再デプロイすることで新しい表示・編集機能を取り込みます。デスクトップの`v*`リリースタグとは共有しません。

現時点ではnpm公開workflowを持たず、次のコマンドで公開物だけを確認します。

```sh
npm run viewer:pack
npm run editor:pack
```
