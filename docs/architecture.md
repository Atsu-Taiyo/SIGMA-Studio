# Architecture

## Summary

このエディタは、教材全体をTeX、HTML、Tiptap JSON、キャンバスライブラリのJSONのいずれかで保存しません。

正本は独自の中立フォーマットであるSigmaDoc JSONです。Tiptap、MathLive、KaTeX、オーバーレイキャンバス、Playwrightは、編集・表示・出力のための部品として使います。

現在の詳細な保存スキーマは [SigmaDoc Schema](sigma-doc-schema.md) にまとめます。

このリポジトリの標準ターゲットは Electron デスクトップアプリです。教材・ワークスペース・フォルダ・AI編集 proposal はローカルファイルを正本にします。

```text
SigmaDoc JSON
  ↓ adapter
Tiptap / ProseMirror
  ↓ user editing
SigmaDoc JSON patch

SigmaDoc JSON
  ↓ page canvas (エディタと共通の唯一のレイアウトエンジン)
確定した紙面DOM
  ↓ ページ帯ごとの切り出し
PDF

SigmaDoc JSON
  ↓ @sigma-studio/editor
controlled Web editor → onChange / onSave → SigmaDoc JSON
  ↓ @sigma-studio/viewer
read-only React pages + static overlay SVG
  ↓
host-owned mathematics website

SigmaDoc JSON
  ↓ PageCanvasEditor
TextFlowEditor + page metrics + overlay view cache
  ↓
page sheets / visible pages / editable overlay

SigmaDoc JSON
  ↓ overlay canvas
shapes / graphs / tables / images → SVG or live React preview
```

Web組み込みの公開境界は、閲覧専用の`@sigma-studio/viewer`と編集用の`@sigma-studio/editor`です。EditorはRead専用の`SigmaDocViewer`を再exportし、デスクトップ版の`EditorShell`を同じ実装のままcontrolled SigmaDocへ接続する`SigmaDocEditor`を追加します。Electron workspace/library、AI/MCP、認証は接続せず、教材の取得、権限、routing、保存、更新通知はホストサイトが所有します。編集結果は完全なSigmaDocとして`onChange` / `onSave`へ返します。閲覧だけが必要なホストは`@sigma-studio/viewer`を直接利用できます。

正本となる意味型は`apps/desktop/src/features/document/model`に置きます。公開パッケージの構造型は`packages/viewer/src/types.ts`から配布し、型互換testでfeature modelとの一致を検査します。デスクトップの既存import pathである`apps/desktop/src/types/sigma-doc.ts`はfeature modelを再exportする移行用facadeです。runtimeの正当性は引き続き`src/lib/sigma-doc-schema.ts`で検証し、型定義だけを信頼して外部JSONを表示・編集しません。

AI編集も同じく派生レイヤーとして扱います。Codex / Claude / Gemini の3プロバイダは、同一のローカルMCPサーバー経由でSigmaDocを読み書きします。書き込み系ツールは`expectedRevision`必須のrevisionゲートを持ち、既定ではpending proposalとして保存し、デスクトップ側の承認UIでユーザーが承認するまでSigmaDoc JSONは更新しません。書き込み成功時にはvalidation結果とページコンテキストのpreview PNGを含む`verification`が返り、エージェントは自分の編集結果を見て自己修正できます。proposalは発行元のAIセッション(runId/roomId)へ帰属し、revisionが進んで古くなったproposalは現在のrevisionへのrebaseを試せます。`aiAutoApplyVerifiedProposals`設定を有効にすると、検証済みかつ現行revisionのproposalは自動適用され、revisionが進む前なら元に戻せます。実行中のrunは`ai-edit:cancel`で中断できます。

AI編集toolの拡張計画は `docs/ai-edit-tool-roadmap.md` に置きます。図形挿入の強化、既存教材編集tool、設定で有効化するWeb research / shell / MCP / connector capabilityはこの計画に沿って追加します。

本文の分割、続きの編集所有権、配置 snapshot と計測の版管理は [flow-pagination-architecture.md](flow-pagination-architecture.md) を参照してください。

## 任意の共同編集

明示的に共有した教材だけは、同じYjs履歴をElectron main・renderer・教材ごとの同期サーバーで複製する。SigmaDocの意味スキーマは維持し、JSONは表示・検証・書き出しの投影として扱う。ローカル専用教材は従来どおりJSONが正本で、ログインやサーバー接続を必要としない。

`features/document-session/contracts.ts` は汎用の編集・履歴・保存・一時selection契約。DesktopEditorが外側から共有sessionを注入する。純粋なdocument/rendering coreと公開Editor/ViewerへYjsやクラウドの実装を持ち込まない。共有中の通常保存はmainのjournal flushへ置き換え、古いJSONのwatcherやrevision整数を共有状態への上書き経路にしない。

共有AIは本人のローカルMCPがmainの現在の投影を読み、private proposalを既存UIへ返す。承認時はサーバーで権限・対象と参照元のハッシュ・冪等操作IDを検証する。共有中は従来の長時間予約と自動rebase/自動承認を使用しない。UndoはYjsの選択的履歴へ接続する。

共同編集の利用方法は [共同編集ガイド](collaboration-user-guide.md) を参照。

## Module Boundaries

ディレクトリ構成は、リポジトリ全体を `models` / `views` / `controllers` に分ける方式ではなく、feature単位を基本にします。各featureの内部では必要に応じてModel・Controller・Viewを分けますが、正本となるmodelと描画coreはUIやデスクトップ固有機能より内側に置きます。

```text
apps/desktop/src/
├─ features/
│  ├─ document/          SigmaDocの意味型、overlay型、validation、純粋操作
│  ├─ drawing/           headlessなtool・interaction・angle/bounds・resize
│  ├─ rendering/
│  │  ├─ core/           render model・SigmaDocの純粋解釈・DOM非依存の寸法推定
│  │  └─ adapters/
│  │     ├─ react/       本文・図中文字・印刷で共有する静的React描画
│  │     ├─ svg/         headless serializerとReact静的描画binding
│  │     └─ *.ts         HTMLなど出力形式のserialization
│  ├─ text-editing/      本文編集のheadless model・host/editor契約
│  ├─ ai-edit/           AI状態を汎用editor extensionへ変換するdesktop feature
│  └─ webmcp/            WebMCP登録・ドラフト適用・状態通知のcomposition
├─ components/
│  ├─ editor/            本文・page・overlayの編集View/Controller
│  ├─ tiptap/            Tiptap固有の編集adapter
│  └─ print/             専用print View
├─ lib/                  desktop application serviceと既存互換adapter
└─ app/                  composition root
```

依存方向は次の通りです。矢印の左側だけが右側をimportできます。

```text
app / desktop features / editor UI
                 ├─→ rendering adapters ─→ rendering core
                 ├─→ drawing ──(types + limited font facade)─→ features/document
                 │       └─→ rendering core
                 └─→ features/document

features/ai-edit ─→ generic editor-extension contracts
features/text-editing ─→ features/document / rendering core
base text/overlay editor ─×→ AI store / AI feature internals
```

本文modelは文書の純粋な操作とrendering coreの問題表示判定も使います。
drawingのdocument依存は型のみを原則としますが、既存の`text-shape-font.ts`には
`document/overlay-text-font.ts`の単位変換を再利用するruntime参照が1箇所あります。
境界テストはこの参照元とexport名を限定して固定しており、一般のruntime依存を許可するものではありません。
drawingからrendering coreへの依存は公開入口の純粋なhelperに限定し、逆方向は禁止します。

境界ごとのルール:

- `features/document` はReact、Next.js、Tiptap、editor component、AI、`types/sigma-doc.ts`をimportしません。comment model、overlay snapshotのvalidation・migration・group正規化・graph migration・anchor補正・patch/remove/upsertに加え、コメントCRUD、top-level blockの挿入・重複ID修復、running regionと余白のresize遷移もここに置きます。UI、AI、MCP、Electronは同じ公開APIを使います。`types/sigma-doc.ts`は、新しいdocument featureの型を再exportする移行用facadeとしてだけ残し、productionコードからは参照しません。
- `features/drawing` はtool選択、interaction mode、角度・shape bounds、hit test、move/rotate/resize、point/arc編集、snap geometry、align/distribute/page内補正、anchor座標解決、曲線・line・polygon・callout・image crop・graph layoutといったheadless geometryを所有します。依存先は`features/document`の型とrendering core公開入口の純粋helper、上記の既存font単位変換facadeに限定し、React、Tiptap、AI、Electron、editor componentはimportしません。documentやrendering coreからdrawingへの逆依存は禁止します。DOM測定、event、pointer capture、group-awareなstack順変更の配線はUI/application adapter側に残します。
- `features/rendering/core` はReact、Tiptap、KaTeX、HTML、AI、componentを知りません。正本の`InlineNode`と`OverlayRichTextDocument`から中立なread-only render modelへの変換、囲み文字runの分割・スタイル解釈、overlay textのDOM非依存な寸法推定、問題エリア段組み、overlayのpage window/slice計算を純粋かつ同期的に行います。DOM実測値やshape boundsは入力として受け取り、coreからdrawingや出力adapterへ逆依存しません。
- `features/rendering/adapters` は出力境界を担当するため、HTML、React、SVGなど特定の出力形式をimportできます。HTMLのescape・serialization、KaTeX生成callbackの呼び出しはadapter側に閉じ、coreからadapterを参照しません。`adapters/react`の`InlineContent`、`MathPreview`、`Graph2DPreview`、`OverlayRichTextPreview`を本文・図中文字・印刷の共通read-only描画に使います。`adapters/svg`はheadless serializerへ数式・グラフの静的rendererを注入し、AI preview・素材・page表示・印刷が同じ公開入口を使います。旧componentパスは互換facadeだけにします。
- `features/text-editing` は本文編集のReact/Tiptap非依存なmodelとhost/editor間の契約を所有します。改ページと境界削除、段組み、本文block探索、box tree、問題番号表示値、本文flowの挿入・置換・ID正規化、全文検索・置換、command query、editor同期key、選択IDの包含判定などSigmaDocだけで決まる操作と、外部所有の本文範囲を表示するevent名・blockごとの範囲解決はここに置きます。`PageCanvasEditor`はDOM selection・pointer・focusの配線、`TextFlowEditor`とTiptap extensionはProseMirror command・Decoration生成・event購読だけを担当します。
- 用紙preset、正規化、寸法、簡易pagination、header/footer自動調整とresizeは`features/document/application`が所有します。`lib/page-layout.ts`、`lib/page-running-region-layout.ts`、`lib/line-height.ts`は移行用facadeであり、productionコードはdocument featureの公開入口を使います。
- Tiptapとの編集変換は`lib/tiptap-adapter.ts`を明示的な境界として維持します。overlay text/calloutも`OverlayRichTextDocument.blocks[].children`にsemanticな`InlineNode[]`を保存し、Tiptap JSONは編集セッションの開始・更新時だけadapterで生成・回収します。静的rendering、検索、AI、MCP、SVG/PDFはTiptapを経由しません。
- `TextFlowEditor`、`RichTextEditor`、`PageCanvasEditor`、`OverlayCanvasEditorClient`、`shape-renderer`は、AI run、proposal、provider、停止処理を知りません。編集禁止と追加表示は、汎用的な`TextFlowEditPolicy`、`OverlayEditPolicy`、`OverlayShapeDecoration`、`PageCanvasEditorExtension`として受け取ります。AI固有lockをgeneric overlayへ投影していた旧互換層は置かず、`features/ai-edit`がこれらの契約へ変換します。
- AI固有のhook、文言、停止操作、shimmer表現、proposal表示・決定モデルの組み立ては`features/ai-edit`が所有します。AI featureから汎用editor契約を利用する方向だけを許可し、`EditorShell`にはIPC・保存・React stateなどの副作用配線だけを残します。
- featureを跨ぐ参照は公開入口を優先し、別featureの内部ファイルへ依存しません。移行中のadapterだけは、その目的が明確な場合に限定して例外とします。
- `TextFlowEditor.tsx`はcompositionとTiptap event wiringを担当し、SigmaDoc block操作・同期判定・正規化は`features/text-editing/model/`、手動改ページ遷移は`features/text-editing/application/`に置きます。`components/editor/text-flow/`にはTiptap document adapterとtransaction、DOM操作、UI契約、旧pathのlogic-free互換facadeを置きます。
- スラッシュコマンドの候補定義・絞り込み・順位付けは`text-flow/slash-command-model.ts`、ProseMirror selectionからのquery計算・キー操作・transactionによる実行は`slash-command-controller.ts`が所有します。汎用query解析は`features/text-editing`の公開APIを利用し、popoverは表示、TextFlowEditorはevent配線とstate保持を担当します。
- 本文系editorに共通するTiptap書式commandとtoolbar stateの変換は`components/tiptap/text-format-controller.ts`に集約し、`TextFlowEditor`と`RichTextEditor`は対象selectionとblock種別だけを渡します。このcontrollerはReact、AI、editor compositionを参照しません。
- 本文のTiptap属性、段組・container node、ID修復は`components/tiptap/sigma-doc-text-attributes.ts`、`sigma-doc-container-extensions.ts`、`sigma-doc-text-identity.ts`が所有します。ProseMirror node照会は`node-queries.ts`で共有し、schema利用者やそのテストがReactの`TextFlowEditor`をimportする必要をなくします。旧controllerからのexportは互換入口として維持します。
- `PageCanvasEditor.tsx`はpage compositionとDOM測定・event wiringに限定し、TextFlow編集結果のSigmaDocへの調停、再帰的なID正規化、問題エリアやrunning regionの遷移、inline contentの区間構成は`components/editor/page-canvas/`の純粋modelへ置きます。
- overlayのread-only shape rendererとinteractive shape editorは別moduleにします。`shape-renderer.tsx`、`text-shape-editor.tsx`、`table-shape-editor.tsx`から`OverlayCanvasEditorClient.tsx`への逆importは禁止し、canvas controllerだけが各Viewを組み立てます。
- 3D spec・cameraの更新、preview hashの検査、配置更新、設定パネルへの選択通知の発行と終了時クリアは`overlay-canvas/use-graph3d-controller.ts`が所有します。canvasから最新snapshotのrefと保存・履歴callbackを受け、camera操作と派生previewを同じUndo区間に保ちます。
- `EditorShell.tsx`はcomposition rootとして残し、素材取得、toolbar正規化、page navigation、workspace request、ブロックスタイル変換など単独で検証できるapplication logicは`components/editor/editor-shell/`へ切り出します。
- コメントCRUDのUI協調は`editor-shell/use-comment-actions.ts`、AI宛コメントのprovider実行は`features/ai-edit/application/use-comment-ai-run.ts`が担当します。コメントの純粋な変更は`features/document`に残し、hostのcommitを通して履歴・保存へ反映します。
- AI提案の適用・拒否・復元・取消とfeedbackは`features/ai-edit/application/use-ai-proposal-actions.ts`に置きます。保存待ち、busy区間、render時の対象一覧と実行時の最新ref、部分成功後の復旧順を保持し、文書採用・Undo・revision更新はEditorShellのcallbackへ委ねます。公開Editorでは同じexportをAI無効adapterに差し替えます。
- AIパネルの表示・portal・catcherと位置は`features/ai-edit/view/AiEditorHost.tsx`、drag中のrefと確定位置は`use-ai-inline-drag.ts`が所有します。`AiEditPanel`の文書・参照・提案propsはEditorShellで組み立てたchildrenとして渡し、表示だけのownerへ巨大な文書contextを渡しません。同じ表示modeの再描画・session更新ではpanelをremountせず、新sessionは古いdrag位置だけを無効にします。pointerup/cancelのcapture解除・cursor復元・focus順は既存どおりです。

WebMCPの登録とドラフト適用を組み立てるReact境界は`features/webmcp/view/WebMcpBridge.tsx`です。
汎用editorはWebMCPやAIの状態を所有せず、compositionから汎用extensionを受け取ります。
履歴と通知の型・event名は`features/webmcp/model`に置き、dockはcontrollerをimportせずに通知契約だけを読みます。
旧`components/editor/webmcp/WebMcpBridge.tsx`と`webmcp-history.ts`は再exportだけの互換入口です。

Electronの提案保存は`electron/local-sigma-doc-proposal-store.ts`がファイルI/O、排他、監視、通知を所有し、
`electron/proposals/`が契約、鮮度判定、再適用、選択的な取り消しを所有します。
後者から保存ストアへは依存しません。既存のストア入口からの型・関数exportは維持し、
モデルの入出力テストと、一時ディレクトリを使う保存・IPCテストを分けて検査します。
承認の協調処理は`electron/proposal-approval.ts`が所有し、mainとstorage IPCが同じcoordinatorを使います。
proposal lock、document lock、再検査、replay、revision付き保存、提案解決をこの順で進めます。
単体承認と一括承認の通知順・部分失敗の違いは各入口に保持し、Electronを起動せず実ファイルストアで検査します。

文書台帳のJSON解析、行の修復、隔離とその報告は`electron/local-library-record.ts`に置きます。
workspace・folder・file行は`lib/library-ledger.ts`の型を共有し、ファイルID検査はI/Oを持たない
`electron/document-file-id.ts`を使います。`local-sigma-doc-store.ts`はファイル書込、排他、watch、
バックアップとログ順序を所有し、parserから保存ストアや履歴sidecarへ依存しません。
自己書込のhash・stat識別情報は`electron/local-store-write-identity.ts`、外部本文の読取・復旧と台帳への反映は
`electron/local-document-reconciler.ts`が所有します。watcherは対象fileを渡し、reconcilerはストアが供給する
排他・バックアップ・台帳更新のportを使います。rename前の署名登録、作成直後の本文欠落の猶予、
不正な外部編集時の台帳保持を独立して検査し、OSのwatch通知回数をテストの前提にしません。

台帳と文書履歴のプロセス間排他は`electron/file-lock.ts`が所有します。
`file-lock-native.ts`だけが`fs-native-extensions`へ接続し、削除しない`<lockPath>.mutex`の
descriptorをロック取得から保存・releaseの終了まで保持します。診断用JSONは別ファイルに置き、
生成・残骸の回収・削除・進行中heartbeatの完了を同じ排他権の内側で処理します。
mtimeの古さだけで生存中の所有者を追い出さず、クラッシュ時の解放はOSに任せます。
新protocolの残存JSONは排他取得後に回収し、旧protocolの生存PIDや別hostの所有者は待機します。
ロック非対応時は保存へ進まず、時刻ベースの旧方式にfallbackしません。
旧版と新版の同時稼働は排他の保証対象外です。`.mutex`は所有者情報ではなく安定した排他対象なので、
通常のreleaseや残骸cleanupで削除しません。

ローカルMCPでは`sigma-doc-mcp-tool-registrar.ts`が公開profile、annotation、実行帰属、計測を担い、
`sigma-doc-mcp-response.ts`が応答envelopeを所有します。SDKの`server.registerTool`を実行中に上書きせず、
coreが明示的なregistrarに既存tool定義を渡します。tool名、description、schema、公開順と実行経路はそのまま維持します。
visual sessionのlive・terminal・書込待ち状態と描画世代の検証は`mcp/visual-edit-session-lifecycle.ts`が所有します。
clockと状態書込先を受け取るprocess共通のinstanceを使い、tool handlerから状態遷移を呼びます。
状態ファイルの保存は`mcp/visual-session-status-file.ts`、Electron側と共有する形式は
`electron/visual-session-status.ts`に置きます。終了状態の保存完了後にlive sessionを削除する順序を維持します。

この依存規則は `src/features/headless-boundaries.test.ts`、`src/features/document/architecture.test.ts`、`src/features/drawing/architecture.test.ts`、`src/features/rendering/architecture.test.ts`、`src/features/text-editing/architecture.test.ts`、`src/features/ai-edit/editor-boundary.test.ts`、`src/components/editor/text-flow/architecture.test.ts`、`src/components/tiptap/text-format-controller-architecture.test.ts`、`src/components/editor/page-canvas/architecture.test.ts`、`src/components/editor/overlay-canvas/shape-renderer-architecture.test.ts` で検査します。互換性を型検査するtestと出力adapterは境界を跨ぐこと自体が役割なので、純粋coreと同じ禁止規則は適用しません。

### Future OSS Surface

将来、描画部分だけを公開できるよう、公開候補を段階で分けます。

1. `features/document` の意味型・validation・migration・純粋操作
2. `features/drawing` のheadless tool・interaction mode・angle/bounds・hit test・transform・snap・arrangement
3. `features/rendering/core` のrender model・正本`InlineNode`変換・囲み文字runの純粋解釈・DOM非依存のoverlay text寸法推定・段組み・page window
4. HTML・React・SVGなど出力先ごとの必要最小限のadapter。React adapterでは本文・図中文字・印刷の静的数式／本文描画を共有
5. selection・history・snapshot操作など、UIから段階的に移すheadless application logic

Electron、workspace保存、ローカルMCP、AI provider、proposal承認、認証は公開描画engineに含めません。`@sigma-studio/viewer`と`@sigma-studio/editor`は公開境界として固定し、Editorはデスクトップ`EditorShell`と汎用editor componentを再利用します。ただしAI編集はデスクトップ専用拡張とし、公開Editorのbuildでは`features/ai-edit`、`lib/ai`、AI UI componentへの依存を無効なadapterへ差し替えます。esbuildの入力一覧にデスクトップ専用AI moduleが現れた場合はbuildを失敗させ、UIを非表示にするだけで実装moduleを公開bundleへ残す構成を許可しません。一方、UI非依存で個別利用できるheadless drawing/editor coreは、リポジトリ内のimport境界とcharacterization testでAPI候補を安定させてから切り出します。旧Tiptap形式のoverlay rich textは読み込みmigrationだけでsemantic形式へ変換する互換層であり、公開coreや保存データへ戻しません。

## Design Principles

### 1. TeX Is For Math, Not The Whole Document

TeXは数式ノードの中だけに閉じ込めます。

```json
{
  "type": "paragraph",
  "id": "paragraph_formula_example",
  "children": [
    {
      "type": "mathInline",
      "id": "math_formula_example",
      "tex": "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      "display": "inline"
    }
  ]
}
```

教材構造、採番、参照、教師版/生徒版切り替え、デザイン、改ページ制御はJSON側で管理します。

### 2. SigmaDoc JSON Is The Source Of Truth

保存形式をTiptap/ProseMirrorの内部JSONにすると、将来エディタを差し替えにくくなります。

保存形式をキャンバスライブラリのJSONにすると、本文、問題構造、解答、PDF出力制約を表現しづらくなります。

保存形式をHTMLにすると、見た目と意味構造が混ざり、教材としての再利用性が落ちます。

そのため、正本は独自のSigmaDoc JSONにします。

### 2.1 Persistence Is Local First

デスクトップ版では、Electron main process が `app.getPath("userData")/data` 配下に `library.json`、`workspace.json`、`documents/<fileId>.sigmadoc.json` を保存し、このローカルファイル群をSigmaDocとワークスペース表示の正本にします。`library.json` は workspace、folder、file の管理正本です。初期 workspace は `マイ教材` です。`workspace.json` は開いている `openFileIds` と `activeFileId` だけを持つUI状態です。Codex app-server のログ、セッション、ログイン状態は同じ `data` 配下の `codex-agent-home` に置き、作業用cwdは `codex-agent-workspace` に分離します。この作業用cwdは永続で、AIリソース(AGENTS.md / skills)が同期されます。Claude CLI も同様に `claude-agent-home` を持ち、Antigravity CLI は作業用cwd `antigravity-agent-workspace` に `AGENTS.md`、`.agents/skills`、`.agents/mcp_config.json` を持ち、共有設定 `~/.gemini/config/mcp_config.json` と併用します。Studio管理のグローバル指示とskillはCodex・Claude・Antigravityの3社共通リソースとして各実行cwdへ投影し、ワークスペース指示は実行時プロンプトで共通適用します。Antigravity 経由の提案は provider `antigravity` として保存します。各プロバイダのアプリ実行コンテキスト(選択ブロックや添付画像など)は `ai-run-context/<provider>.run-context.json` で受け渡します。renderer の IndexedDB / `localStorage` はデスクトップ版の教材保存経路では使いません (Web版の保存先については 2.2 を参照)。

デスクトップ版は `data/documents`、`library.json`、`workspace.json` を監視します。外部エディタやファイル同期ツールが現在開いている `documents/<fileId>.sigmadoc.json` を更新した場合、main process は `{ type: "document", fileId, change }` をrendererへ通知し、renderer はそのSigmaDocを読み直して画面に即時反映します。アプリ内編集がdirtyな状態で外部更新が来た場合は、新しい `fileId` の退避教材を作ってから外部変更を反映します。外部削除時は削除済みfileを復活させず、別fileへ切り替えます。

教材ごとのバージョン履歴はSigmaDoc本体に焼き込まず、`data/doc-versions/<encodedFileId>/` のサイドカーとして保持します。各版の本文は個別の `<versionId>.sigmadoc.json`、一覧に必要な時刻と出所は追記型 `index.jsonl` に分け、通常の保存で履歴全体を読み書きしません。通常編集は最新版から10分ごと、それに加えて教材タブを離れる時とアプリ終了時に、最新版と本文が異なる場合だけスナップショットを追加します。履歴は右上の専用ボタンから開き、選択した版を編集面の代わりに読み取り専用の紙面として表示します。保持上限は1教材あたり200版で、超過時だけ古いスナップショットの削除とindexのcompactionを行います。Web版でもIndexedDBのメタデータと本文を別object storeに保存し、一覧取得は本文をdeserializeしません。

IDの境界は分けます。`fileId` はローカルのファイル管理IDで、workspace、folder、revision、タブ、一覧、watch、AI編集対象の基準です。`docId` はSigmaDoc内部IDで、教材本文の内部識別子としてだけ残します。

教材作成、保存、削除、フォルダ移動、workspace変更、画像参照はすべてローカルlibrary内で完結し、標準UIもこのローカルデータだけを表示します。`library.json` が現行スキーマに適合しない場合は専用エラー画面で違反箇所とAI修復用プロンプトを示し、再読み込みされるまで台帳へ書き込みません。

### 2.2 Web Version Persists In The Browser

Web版 (Electron の preload bridge `window.desktopAPI` が無い素のブラウザ) は、同じ台帳とSigmaDocをそのブラウザの IndexedDB (`sigma-studio`) へ保存します。教材、ワークスペース、フォルダ、タブ状態、テンプレート、素材がすべて再読み込み後も残ります。サーバもログインも使いません。同期先はこのブラウザだけで、別の端末やブラウザへは渡りません。

保存先の選択は `src/lib/runtime/app-runtime.ts` の `getAppRuntime()` が 1 か所で行います。bridge があれば desktop runtime、無ければ browser runtime です。`src/lib/storage.ts` と `src/lib/workspace-repository.ts` はこの runtime だけを呼ぶので、画面側は保存先を意識しません。MCP提案・データフォルダ・AI実行のように desktop でしか意味を持たない操作だけが `getDesktopRuntime()` を使い、`null` を分岐します。

台帳の行の形と操作の意味 (既定ワークスペースの生成、ソフト削除、フォルダの入れ子、`revision` の楽観ロック) は `src/lib/library-ledger.ts` の純関数が唯一の出典で、デスクトップ版の `library.json` と同じ形です。両実装が同じ操作列で同じ結果になることは `electron/browser-store-parity.test.ts` で縛ります。

デスクトップ版がプロセス間ロックで守っている台帳の read-modify-write は、ブラウザでは IndexedDB のトランザクション 1 つに置き換えます。台帳と本文を同じトランザクションで書くので、「行はあるが本文が無い」状態は原理的に作れません。外部変更の通知は `fs.watch` の代わりに `BroadcastChannel("sigma-studio:storage")` で、他タブの作成・改名・保存が同じ形のイベントで届きます。

ブラウザがサイトデータを拒む場合 (プライベートウィンドウなど) はメモリ上の保存先へ落ち、`capabilities.browserStorage` が `false` になります。このときは編集できてもタブを閉じると失われるので、起動時にその旨を表示します。

### 3. Semantic Nodes Before Visual Styling

教材では、見た目ではなく意味を先に持ちます。

```text
section
heading
paragraph
list       ── listItem / nested list を内包
problem   ── lead / prompt / answer / solution / hints / areaLayout / numbering / frame を内包
layoutSection ── 本文途中の段組み範囲
boxBlock  ── TeX風の箱、RichBlock本文、BoxFrameSpecを内包
mathInline (インライン)
```

教材構造は意味で持ちます。例えば問題の解答を書く領域 `solution` と、画面上は「コメント」と呼ぶ補助領域 `hints` は問題ノードのフィールドです。箇条書きや番号付きリストは、記号を付けた段落ではなく `list` / `listItem` として保持します。Tiptap の `bulletList` / `orderedList` / `listItem` は編集時の派生表現で、保存時はSigmaDocの `list` に戻します。生徒版では非表示、教師版では表示、解答冊子では解答のみを別建てにする、といった切り替えを出力プロファイルで行うため、見た目の折りたたみではなく意味として保持します。

ただし、`problem` は常に枠付きコンテナとして描画するわけではありません。編集・印刷では `lead`、`prompt`、`hints`、`solution` を本文中の連続したエリアとして展開し、`problem.frame.enabled === true` の場合だけ問題文エリアに枠線を付けます。導入文、コメント、解答エリアには枠線を回しません。自動の「問題」「コメント」「解答」見出しは紙面へ出さず、エディタだけが紙面外のサイド注とガイド線でエリア境界を示します。導入文エリアは常に表示し、使わない場合は空欄のままにします。空のコメントや解答エリアは編集画面でも既定では表示せず、必要に応じて追加します。エリアの手動高さは `problem.areaLayout.*.minHeightMm` に保存し、内容が増えた場合は内容高さを優先します。問題番号は `problem.numbering.enabled !== false` の問題だけを本文順に採番し、数字だけを表示して右隣に導入文を置きます。番号は未指定なら直前の表示番号 + 1 として導出し、`problem.numbering.value` があればその番号から続けます。番号サイズは `problem.numbering.fontSize` で調整できます。

図・グラフ・画像は本文ノードではなく、本文に重ねるオーバーレイのシェイプとして持ちます（後述）。

一方で、`/itembox`、`/tcolorbox`、`/doublebox` のような単純な箱はoverlay shapeではなく本文フロー内の `boxBlock` です。箱の本文は `boxBlock.blocks` に置き、見た目は `styleId` と `frame: BoxFrameSpec` で保存します。編集画面と印刷画面は同じ `BoxFrameSpec` からCSS変数と `data-box-*` 属性を作ります。任意TeX/TikZを実行せず、安全に表現できる装飾だけを `BoxDecorationSpec` に写します。

本文中の部分的な文字装飾は `TextInlineNode` の属性として保持します。太字・斜体・下線・四角囲みは `marks`、文字色は `color`、フォントファミリーは `fontFamily`、部分的な文字サイズは `fontSize` に保存し、Tiptap の `styledText` マークは編集時の派生表現として扱います。数式を四角で囲む場合だけ、`mathInline` に `marks: ["boxed"]` と必要に応じて `boxedPaddingY` を保存します。

本文の行高も inline run から導出します。`rendering/core/text-block-typography.ts` が段落内の最小文字サイズとサイズ未指定の run を判定し、`rendering/adapters/text-block-typography-dom.ts` が共有CSSへの値に変換します。段落の基準サイズだけを下げ、未指定の文字・数式は段落スタイル本来のサイズを保つことで、折り返し後も各行の文字・数式に応じた高さをブラウザが決めます。編集面は `styledText` の装飾プラグイン、静的表示は `TextFlowStaticBlock` が同じ射影を使います。段落の最低高さは実際の行間に従う `1lh` とし、下余白は別に加えます。派生した行高・基準サイズをSigmaDocへ保存せず、再計測や別のPDF組版で補正しません。

### 4. PDF Is The Editor Screen, Sliced Into Pages

**PDFは編集画面のDOMをページ帯ごとに切り出したものです。印刷専用のレイアウトを組んではいけません。**

詳細と不変条件は `pdf-parity-architecture.md` にあります。要点だけ:

- レイアウト計算はドキュメント1つにつき1回。PDF側で再計測・再ページ割りをしない
- PDFに出るDOMは画面に出るDOMのクローン。PDF専用のブロックコンポーネントやCSSクラスを作らない
- ブロック座標を算術で逆算しない。図形のアンカー解決は実測矩形だけを使う
- 図形は画面と同じReactコンポーネントで描く。SVG文字列シリアライザはPDFの経路に入れない
- ズームは `transform: scale()` で見た目だけを変える。CSSの `zoom:` はレイアウトを再計算するため使用禁止
- 用紙サイズは `pageLayout` が唯一の出典。`printToPDF` にハードコードしない
- 表示中のプレビューDOMとrevisionをOutputSessionとして固定し、別ウィンドウで再読込しない
- Chromiumには確定済み用紙窓を1ページずつ渡し、検証後にベクターPDFページを結合する
- 標準ゴシックは同梱した`M PLUS 1p`、標準明朝は同梱した`Noto Serif JP`で描き、丸数字・ローマ数字・数学記号などの不足グリフも同梱した`Noto Sans Symbols`と`STIX Two Math`で補う。OSごとに異なるシステムフォントの文字幅をページ計測へ入れず、旧SigmaDocの標準明朝フォールバックも描画時に`Noto Serif JP`へ解決する

用紙・余白・ページ番号・フォント・数式サイズ・図版サイズ・分割禁止といった紙面の制御は、印刷側ではなくページキャンバス（＝編集画面そのもの）が担います。

手動の改ページ/改段(`pagination.break: true`)は、枠付き問題文や全幅エリアでは「分割禁止」より優先します。TeX風の`boxBlock`は別で、箱直下の手動改ページは許可せず、箱内の複数段`layoutSection`配下だけを改段として扱います。長い箱のページ・外側段への分割は手動指定ではなく自動ページネーションが担当します。分割の適格判定はDOM非依存の`features/rendering/core`に置いた`isProblemAreaFlowEligible`が唯一の出典です。分割位置がページキャンバスとPDFで一致することは`tests/e2e/object-break-parity.spec.ts`で担保します。

`components/print/PrintPreview.tsx` の静的レンダラはPDFの経路から外れており、`packages/viewer`・サムネイル・テンプレートギャラリーの近似プレビュー専用です。ここに用紙出力を追加しないこと。

### 5. Read-only Viewer Shares The Static Renderer

Web Viewerは編集DOMを流用せず、`PrintPreview.tsx`による近似プレビューと同じ静的描画を使います。本文、数式、header/footer、overlayの描画部品を共有しつつ、Tiptap、選択状態、編集イベントを公開bundleから外します。用紙窓の確定と正確なPDF出力は、前節の`PagedRenderSurface`とOutputSessionが担当します。

```text
SigmaDoc
  ├─ desktop editor → editable derived views → SigmaDoc patch
  ├─ paged preview  → PageCanvas → OutputSession → PDF
  ├─ approximate preview → shared static renderer
  └─ web viewer     → shared static renderer → read-only React DOM
```

Viewerはhostから渡されたSigmaDocを検証し、新しいdocumentオブジェクトを受け取るたびにページ組版をやり直します。Viewer自身はfetch、polling、storage、asset署名URLの解決を行いません。

画像はv1では`data:image/png`、`data:image/jpeg`、`data:image/webp`、`data:image/svg+xml`だけを表示します。raster画像はbase64と実ファイル署名を検証し、SVGはactive contentと外部resource参照を拒否します。外部URL、`blob:`、`sigma-doc-storage://`は通信せずplaceholderに置き換えます。SVG data URLもDOMへ展開せず、静的SVGの`<image>`として描画します。

## Editor Layers

### Editor Chrome

編集画面のメニューバーとコマンド面（クローム）は `src/components/editor/editor-shell/chrome/` にあります。Googleドキュメント風とWord風リボンの2系統を、同じ部品から作り分けます。

- `renderEditorChrome`（`editor-chrome.tsx`）が**唯一のJSX生成関数**です。ツールバーの各コントロールはこの関数の中でローカル `const` として1回だけ作られ、`chrome-parts.ts` の `EditorChromeParts` に束ねられます。
- `renderDocsComposition` / `renderRibbonComposition`（`chrome-composition.tsx`）は、**生成済みのelementを並べるだけ**です。ラッパ（`<header>` / `.menubar-row` / `EditorToolbar` / リボンのタブバーと本体）しか作らず、コントロールのJSXは一切作りません。
- **クロームのJSXを複数の関数や子コンポーネントに分割してはいけません。** 分割するとoverlay（図形）のスタイル指定が描画へ届かなくなります。機序は未解明で、実測のみで確認されています（純関数への分割・単一の子コンポーネント化のいずれでも `arrowhead-kinds.spec.ts` が落ち、単一関数 + ローカル `const` 共有では落ちません）。共有したいものが増えたときは、関数を増やさずローカル `const` を細かく割ってください。
- **状態の所有権は `EditorShell` から動きません。** クロームはpropsとして受け取った値バケットを読むだけで、SigmaDocの書き込みや選択状態を持ちません。リボン固有の状態（開いているタブ、Backstageの開閉とセクション、リボンの折りたたみ）も `EditorShell` が持ち、遷移規則だけが純関数 `ribbon-tabs.ts` / `ribbon-backstage.ts` にあります。どちらも「変化が無いときは同じオブジェクトを返す」ことでReactのbail-outを効かせます（`EditorShell` は毎キーストローク再レンダーされるため）。
- レイアウトの選択は `src/lib/ui-layout-preference.ts`（localStorage、既定はGoogleドキュメント風）で、初回起動時のUI選択画面は `src/components/onboarding/` にあります。オンボーディングは `app/page.tsx` から描かれるため、`packages/editor` のバンドルには入りません。リボンの折りたたみ状態（`ribbonCollapsed`）も同じ設定に永続します（per-fieldガードなので、保存済みの値に無くても既定で読めます）。

Word風クロームは Word 365 の画面構成に倣って5つの面を持ちます。いずれも `renderEditorChrome` 内のローカル `const` として作り、`renderRibbonComposition` は並べるだけです。

| 面 | クラス | 中身 |
|---|---|---|
| タイトル行 | `.menubar-row` | アプリアイコン / クイックアクセスツールバー `.ribbon-qat`（保存状態・元に戻す・やり直す）/ 中央の教材タイトル / 右端の常設アクション `.ribbon-titlebar-actions`（ワークスペース） |
| タブ行 | `.ribbon-tabs-row` | `.ribbon-tabs`（`role="tablist"`）と右端の `.ribbon-tab-actions`（コメント表示・AIチャット） |
| リボン本体 | `.ribbon-body` | グループごとに「大ボタンのスロット + 小ボタンの段（2段）+ 下端の見出し行（ラベルとダイアログランチャー）」。右端に折りたたみボタン |
| Backstage | `.ribbon-backstage` | ファイルタブで開く全画面。左ナビ7セクション（ホーム/新規/開く/情報/エクスポート/オプション/ヘルプ）と右の内容 |
| ステータスバー | `.ribbon-statusbar` | 画面下端。左に「ページ N / M」、右にズーム |

- **大ボタンの見た目はスロットが与えます。** リボンに並ぶコントロールの多くは docs のツールバーと**同じelement**を共有していて（`ref` を持つものは複製もできません）、element側に `large` を付けると docs 側の見た目とDOM署名まで変わります。`.ribbon-group-large` の中身を大きく描くCSSに寄せ、`EditorToolbarIconButton` の `large` はリボン専用のボタンにだけ使います。
- **Backstage・折りたたみ中は「見えていない本文」へコマンドが効かないようにします。** Backstage表示中はリボン本体・タイトル行/タブ行のコマンド・ステータスバーを描かず、`<main>` を `inert` にし、window の capture フェーズで Escape 以外の keydown を止めます。**capture の `stopPropagation()` は同じ window に付いた別の capture リスナーを止められず、`inert` も window レベルのリスナーには効きません。** 本文側で window capture に張っているショートカット（`PageCanvasEditor` の図中テキスト挿入）は `shortcutsSuppressed` プロパティで自分から降ります。window capture の keydown リスナーを増やすときは、この抑止の輪に必ず加えてください。
- 高さは `--editor-chrome-height`（タイトル行 + タブ行 + リボン本体、折りたたみ時はタブ行まで）と `--editor-statusbar-height`（docsでは `0px`）の2トークンで決まります。本文キャンバスの `calc(100vh - …)` は両方を引きます。**派生トークンを `:root` に作ってはいけません** — カスタムプロパティの `var()` 置換は宣言された要素の値で解決されるため、`.app-shell` 側のWord風上書きが反映されなくなります。
- docs側のDOMは `tests/e2e/editor-chrome-signature.spec.ts` が署名として固定しています。クロームの**挙動**（タブ・Backstage・2段リボン・折りたたみ・ステータスバー・高さ）は `tests/e2e/ui-layout-ribbon.spec.ts`、**両レイアウトのコマンド集合が一致すること**は `tests/e2e/ui-layout-parity.spec.ts` が双方向で見ます。両方の spec は収集・操作ヘルパを `tests/e2e/ui-layout-chrome.ts` から取り、**同じ関数で両側を観測します**（片側だけ広い収集にすると、判定は必ず緩い方へ倒れて緑になります）。
- **コマンドを片方のレイアウトにだけ足すとパリティ spec が落ちます。** 落ちたら許容リストで隠さず、まずもう一方の置き場所を決めてください。意図的な差分（Backstageの左ナビ、折りたたみ、ダイアログランチャーなど）は理由付きで許容リストに載せ、実体が消えたエントリは spec 側が検出します。
- Word風では同じコマンドが複数の面に出ます（ワークスペース = タイトル行とBackstage、コメント表示 = タブ行右端と表示タブ、ズーム = 表示タブとステータスバー）。Word 自身がそうなので受容しますが、**Word風のe2eは必ず `.ribbon-qat` / `.ribbon-titlebar-actions` / `.ribbon-tab-actions` / `.ribbon-body` / `.ribbon-backstage` / `.ribbon-statusbar` / `.document-title-row` のいずれかでスコープしてください**（無スコープの `getByRole` は strict mode で落ちます）。

### Flow Editor

Tiptap/ProseMirrorを使う領域です。

担当範囲:

- セクション見出し
- 見出し
- 段落
- 導入文・問題文・コメント・解答
- インライン数式
- 本文フロー内の `boxBlock`

Tiptapは編集UIとして使い、保存形式にはしません。

`TextFlowEditor` はSigmaDoc本文ブロックからTiptap文書を作り、編集後にSigmaDoc本文ブロックへ戻します。`boxBlock` はTiptap内では編集用の表現を持ちますが、保存正本は常にSigmaDocの `boxBlock` です。ページ分割用の高さ測定や手動改ページもSigmaDoc側の `pagination` とページレイアウト計算に戻します。

### Page Canvas

`PageCanvasEditor` は、SigmaDoc本文を用紙・余白・段組みへ流し込み、ページシートとして表示する編集面です。`features/document` の `getPageMetrics` と `PAGE_GAP_PX` を使って、mm単位のpage layoutをCSS px相当の連続キャンバスへ変換します。

担当範囲:

- 用紙サイズ、余白、段組み、ヘッダー/フッターの編集
- 本文ブロック、問題エリア、`layoutSection`、`boxBlock` のページ/段への流し込み
- 本文ブロックの実測高さと `computeColumnUnitLayouts` によるページ分割
- 可視ページwindowingと、重いoverlay/graph/text viewの描画範囲制御
- body選択とoverlay選択を同じページ座標で扱うための選択popover配置

ページは保存データではありません。`content` は論理順の1本の配列であり、ページや段ごとの配列は保存しません。

### Page Layout

用紙サイズ、向き、余白、文書全体の段組み、ヘッダー/フッターは `SigmaDocument.pageLayout` に保存します。

```json
{
  "pageLayout": {
    "preset": "B4",
    "orientation": "portrait",
    "pageSize": { "widthMm": 257, "heightMm": 364 },
    "marginsMm": { "top": 18, "right": 17, "bottom": 18, "left": 17 },
    "flow": { "type": "columns", "columnCount": 2, "columnGapMm": 8 },
    "footer": {
      "enabled": true,
      "heightMm": 8,
      "offsetMm": 5,
      "showOnFirstPage": true,
      "blocks": [
        {
          "type": "paragraph",
          "id": "page_footer_running_body",
          "align": "center",
          "children": [{ "type": "text", "text": "{page}" }]
        }
      ]
    }
  }
}
```

`preset` は `A4` / `A3` / `B5` / `B4` / `custom` を持てます。文書全体の本文 `content` は段ごとの配列に分けず、論理順の1本の配列を正本にします。ページ段への流し込み、ページ寸法、本文矩形、ヘッダー/フッターの表示テキストは `features/document` の正規化・metrics関数から派生させます。一方、本文途中だけを段組みにする `layoutSection` は新聞型の自動流し込みではなく、`layout.columnStartIds`で各childの列所属、`layout.columnWidths`で相対幅を明示します。列ごとに独立した編集面とページカーソルを持つため、左列末尾のEnterやページ溢れで右列へ本文が移ることはありません。短い列は空白のまま、長い列だけが次ページへ続きます。`pagination.break`は局所段組の列境界には使いません。ヘッダー/フッター本文は `blocks` を正規データにし、Tiptapのページ表示拡張は実験的な表示レイヤーとして使い、Tiptap JSONや拡張内部状態は正本にしません。

### Math Editor

MathLiveを使います。

担当範囲:

- 数式入力
- TeX生成
- 既存TeXの再編集

表示はKaTeXを使います。MathLiveは入力とTeX検証に使い、KaTeXは表示に使います。

### Overlay Canvas

図・グラフ・画像は、本文の上に重ねるオーバーレイキャンバスで扱います。Excalidrawなどの外部ライブラリは使わず、SigmaDocを正本とする自前実装です（`src/components/editor/overlay-canvas/`）。

AI生成SVGもSigmaDocの`OverlayAsset`と`image` shapeとして保存します。`insert_svg_image` / `update_svg_image`はローカルMCPとWebMCPから同じdraft実装を呼び、静的SVGの要素・属性・外部参照・サイズを検証して承認待ち提案を作ります。SVG原文はアセットのdata URLに保持し、本文構造やキャンバス全体の正本にはしません。本文とは独立した画像なので、配置はページプレビューで確認します。ローカルMCPは既存のPNG検証結果、WebMCPは画面上の提案プレビューを返します。承認前の挿入→画像差し替えも操作順に描画し、更新後のアセットを使います。


ドキュメント全体で**1つの連続したオーバーレイ**（`pageLayout.overlay`）を持ち、シェイプは全ページにまたがる連続キャンバス座標で配置します。各シェイプは本文ブロックへ `anchor` でき、`dy` とブロック左端基準の `dx` によってテキストのリフローや段移動に追従します。AIやimportからanchorなしのシェイプが入った場合も、本文が画面上で測定可能になった時点で近傍の本文ブロックへ自動でanchorし、SigmaDocへ確定します。必要に応じてブロック内の表示行にも `line` 補助アンカーを持たせ、アンカー行そのものの移動にも追従します。アンカーUIとoverlay座標は本文flowの外にあり、図形の位置やアンカー操作によって本文の高さ・改ページは変えません。用紙サイズが変わっても、オーバーレイはその時点のページmetricsを使って表示・SVG切り出しを行います。

本文の範囲選択と図形選択が同時に立っているコピーは、本文のProseMirror sliceと図形を `textAndShapes` payloadにまとめます。
貼り付けで生成した本文ブロックはidを再採番し、コピー範囲内のブロックへ向いていた図形のanchorを対応する貼り付け先ブロックへ付け替えます。
コピー範囲外のブロックへのanchorとpage anchorは、通常の図形貼り付けと同じ規則で扱います。

overlayは見た目のレイヤーとして `stackLayer: "background" | "foreground"` を持てます。背景shapeは本文の背面、前景shapeは本文の前面に描きます。グループ化は `type: "group"` shape と子shapeの `parentId` で表します。描画やヒットテストでは正規化後の階層とvisual stack orderを使います。

図形の問題エリア所属は、shapeに専用fieldを増やさず `anchor.blockId` から導出します。`anchor.type === "block"` の `blockId` が `problem.lead`、`problem.prompt`、`problem.hints`、`problem.solution` 内のrich blockを指す場合、そのshapeは該当エリア所属です。`anchor.type === "shape"` のshapeは親shapeの所属と出力可否を継承します。明示的な `anchor.type === "page"`、または本文をまだ測定できず自動anchorが確定していない互換データは文書共通として扱い、生徒版/解答冊子などの問題エリア表示制御では隠しません。

担当範囲（シェイプ種別）:

- `graph2dShape`: 2D関数グラフ・数直線（`Graph2DSpec`）
- `graph3dShape`: 数式曲面・立体・共通部分・3D注釈（`Graph3DSpec`）。Three.jsのscene/meshは保存しない
- `geo`: 矩形・楕円などの図形
- `arc`: 円弧・扇形
- `arrow` / `line`: 矢印・折れ線・曲線・フリーハンド
- `callout`: 吹き出し
- `tableShape`: 座標で配置する表・増減表（セル内容は `InlineNode[]`）
- `image`: 画像（オーバーレイの `assets` からdata URLまたはローカルasset参照を持つassetを参照）
- `text`: 補助的なページ注釈（多用しない）

板書風の補助図、図形問題の図、ベクトル図、数直線、面積図、増減表などをここで作ります。PowerPoint代替ではありません。

### Images And Assets

画像はオーバーレイのスナップショット内 `assets` に保持し、`image` シェイプの `props.assetId` から参照します。ローカル教材ではdata URLまたはローカルasset参照を使えます。本文ノードとしての画像ブロックや、ドキュメント直下の `assets` フォルダ/マップは持ちません。画像shapeは任意の `props.crop` を持ち、元画像内の表示範囲を正規化座標で保存します。`crop` がない既存画像は、枠いっぱいに写真が入る中央cover表示として扱います。

```text
pageLayout.overlay.overlaySnapshot
├─ shapes[]            ← graph2dShape / geo / line / image / tableShape ...
└─ assets{ assetId }   ← 画像表示情報（data URLまたはローカルasset参照）
```

画像assetも教材本文と同じくローカルSigmaDoc側を正本とし、署名URLやprovider側metadataは標準データモデルに保存しません。

### PDF Output

`getPrintableDocument` が `outputProfiles` に応じて問題の解答・コメント・ヒントを濾し、問題エリアにanchorされたoverlay shapeも同じ表示可否で濾します。**この投影だけがPDF固有の処理で、レイアウトはエディタと共通です。** 投影後のドキュメントをページキャンバスに描き、表示中のプレビューと同じOutputSessionから確定済み用紙窓を1ページずつベクターPDF化し、検証後に結合します。詳細は `pdf-parity-architecture.md`。

`exportOverlaySvg` によるSVG文字列化はPDFの経路から外れており、`packages/viewer`・サムネイル・AIプレビュー・素材書き出し専用です。以下の落とし穴はそれらの経路にだけ残っています。

overlayのテキストをSVGに落とす場合、テキストは `<foreignObject>` に入ります。**`<foreignObject>` は宣言した width/height の外へ出たグリフを「クリップする」のではなく落とす**ので、はみ出した文字は出力から完全に消えます(画面側は `overflow: visible` のHTMLなので見えてしまい、気づけません)。`overlay-svg.ts` はこれに対して、矩形をフォントサイズ由来のbleed分だけ広げる方式(表シェイプの `getTableForeignObjectOverflow` と同じ規約)と `overflow="visible"` の二重で対処しています。片方だけでは、推定が大きく外れたとき(背の高い数式)に取り返しがつきません。

図形内テキストの実効サイズは `features/drawing/overlay-text-box.ts` が内容から導出します。SigmaDocの `props.w`/`props.h` は書き換えません。`getShapeBounds` が図形寸法の唯一の合流点です。数式の実寸法は `features/rendering/adapters/math-metrics.ts` がKaTeX/MathLiveの箱メトリクスから取り、`features/drawing` へはポート注入で渡します(`features/drawing` は `katex` も `@/lib` も import できないため)。

PDFは派生物です。正本ではありません。

## Image Insertion

画像はオーバーレイの画像シェイプとして挿入します。本文に画像バイナリを埋め込まず、オーバーレイスナップショットの `assets` に画像asset情報を保持し、`image` シェイプから参照します。

エディタUIでは、画像メニューからのファイル選択、クリップボード上の画像ファイル貼り付け、ページ上への画像ファイルドラッグ&ドロップを同じ挿入経路で扱います。標準のデスクトップ保存では、PNG/JPEG/WebP/SVGをdata URL化して `overlaySnapshot.assets` に保存します。URL貼り付けやHTML内の `<img>` 参照はv1の画像挿入対象ではありません。

アセット側（`pageLayout.overlay.overlaySnapshot.assets`）:

```json
{
  "asset_001": {
    "id": "asset_001",
    "type": "image",
    "props": {
      "w": 640, "h": 360,
      "name": "img_001.png",
      "isAnimated": false,
      "mimeType": "image/png",
      "src": "data:image/png;base64,...",
      "fileSize": 12345
    },
    "meta": {}
  }
}
```

remote asset参照の例:

```json
{
  "asset_001": {
    "id": "asset_001",
    "type": "image",
    "props": {
      "w": 640, "h": 360,
      "name": "img_001.png",
      "isAnimated": false,
      "mimeType": "image/png",
      "src": "sigma-doc-storage://asset_001",
      "fileSize": 12345,
      "storage": {
        "kind": "remote-asset",
        "storageKey": "workspace/file/asset_001.png",
        "assetId": "asset_001"
      }
    },
    "meta": {}
  }
}
```

表示時だけremote asset参照を表示可能URLへ解決します。期限付きURLは永続保存せず、プレビューや書き出しは必要時に `overlaySnapshot` から再生成します。

シェイプ側（`pageLayout.overlay.overlaySnapshot.shapes`）:

```json
{
  "id": "shape_image_1",
  "type": "image",
  "x": 96, "y": 620, "rotation": 0,
  "props": {
    "assetId": "asset_001",
    "w": 240,
    "h": 135,
    "crop": {
      "topLeft": { "x": 0.1, "y": 0 },
      "bottomRight": { "x": 0.9, "y": 1 }
    }
  }
}
```

オーバーレイ上でリサイズ・移動・整列ができ、本文ブロックへの `anchor` でテキストのリフローに追従させられます。画像をダブルクリックするとキャンバス内トリミングモードに入り、表示中の写真範囲だけを変更できます。

## Graphs And Math Labels

グラフは外部ツールではなく、`graph2dShape`（`Graph2DSpec`）としてオーバーレイに持ちます。関数は `curves[].expr`、媒介変数表示の `y=g(t)` は `curves[].yExpr`、陰関数は `mode: "implicit"` と `curves[].expr` の `F(x,y)=0` 評価式、目盛・点・塗りつぶしは spec のフィールドで表現し、表示はアプリ内の2Dグラフレンダラ（`src/components/graph/Graph2DPreview.tsx`）がSVG化します。`graph2dShape` の `x` / `y` / `props.w` / `props.h` は軸や曲線が描かれるプロット範囲を表し、目盛り文字などに必要なSVG余白は選択・整列・回転・リサイズの図形範囲に含めません。座標内の軸名・点・注釈・曲線式ラベルと目盛りラベルのフォントサイズはptで保持し、グラフ図形の位置・幅・高さ・線幅とラベル配置用の矩形はpxで保持します。閉領域の塗りつぶしは `fills[].pattern` でベタ塗り、斜線、格子、横線、縦線、点々を切り替えます。手描きの線でグラフを近似しません。

現行schemaには専用の `mathBox` shape はありません。本文中の数式は常に `mathInline` です。軸名、点ラベル、注釈、曲線の式ラベルなど、ユーザーが紙面上で動かしたいグラフ文字は `graph2dShape` のSVG内部に描かず、グラフにshape anchorされた `text` shape として持ちます。`graph2dShape` は `axisLabelTextShapeIds`、`pointLabelTextShapeIdsByPointId`、`annotationTextShapeIdsByAnnotationId`、`labelTextShapeIdsByCurveId` で所有するラベルshapeを参照します。

所有するtext shapeをmaterializeした後は、対応する `GraphAxes` / `GraphPoint.label` / `GraphAnnotation.text` / `GraphCurve.label` の本文を空にし、ラベル本文の正本をtext shapeへ一本化します。グラフ更新コマンドがspec形式の入力を必要とする場合だけtext shapeから一時specへ投影し、その投影は保存しません。

### 3D teaching materials

3D教材は `graph3dShape` と、その `props.spec: Graph3DSpec` を正本にします。`Graph3DSpec` は次を数学的・engine非依存なデータとして保持します。

- `implicitSurface`、媒介変数曲線・曲面（`x = u`、`y = v` と書けば教科書の `z = f(x,y)` になる）
- 球・円柱・円錐・直方体、回転体、多面体、不等式で囲まれた立体（線形・非線形）
- 汎用parameterと再生範囲。animation frameは保存せず、その時点のparameter値から導出する
- 立体ごとの局所軸倍率・局所回転・ワールド座標の平行移動。数式文字列は書き換えず、描画と内外判定の双方へ同じアフィン変換を適用する
- 立体どうしの共通部分 (`objectIntersection` region)。何も切り落とさずに共有する体積を塗る。平面を1つ混ぜたときは共有する面を塗る。非表示の立体も判定には残る。閉じた媒介変数曲面も中身のある立体として使える
- 数式ラベルと、線種・太さ・端の形を持つ寸法線
- z-upのcamera・表示設定

数式文字列は編集中の未完成値も失わず保存します。評価は `features/drawing/math-expression.ts` の制約付きparserだけを使い、`eval`、`Function`、動的import、ユーザーcallbackは使いません。式長・構文step・再帰深さ・geometry分割数には上限を設けます。共通部分は `graph3d-solid.ts` が担当し、立体ごとの内外判定 (`Graph3DSolidField`) を作ってから交わりを求めます。半空間だけで表せる立体どうしは頂点列挙で厳密に、曲面や二次不等式を含む場合は格子上のmarching tetrahedraで標本化します。古い `cuts` は互換のため残しますが描画しません。平面との共通部分は `objectIntersection` へ移行します。

Three.jsは `features/rendering/adapters/three` と `adapters/react/Graph3DPreview.tsx` に限定した描画adapterです。OrbitControlsによる回転・pan・zoom、perspective/orthographic camera、lighting、grid、GPU resourceのdisposeを担当します。Three.jsの `Scene`、`Mesh`、camera stateをSigmaDocの正本にしてはいけません。

ページ上、PDF、静的ViewerではWebGLを常時起動しません。設定パネルのlive viewportからPNG previewを生成し、`previewAssetId`で通常のoverlay image assetとして参照します。`previewSourceHash`がspecと一致しない間は古い画像であることを表示します。コピー時はpreview assetも複製し、Viewerでは通常画像と同じdata URL安全検証を通します。previewは派生キャッシュなので、数学的内容の復元には使いません。

## PDF And Print Quality

HTML/CSS + ChromiumのベクターPDF出力は現実的ですが、商用品質の教材PDFを作るには構造検査と画像検査が必要です。複数ページのCSS fragmentationは使わず、確定済みの用紙窓を1ページずつ出力します。

必要な検査:

- ページ画像diff
- テキスト抽出
- フォント埋め込み確認
- 空白ページ検出
- はみ出し検出
- 未ロード画像検出
- 代替フォント検出
- 低解像度画像検出
- 数式欠け検出

ページ分割は自動ページネーションが担い、ノード側には手動の改ページ/改段だけを持たせます(`keepTogether` / `keepWithNext` は廃止しました)。

```json
{
  "pagination": {
    "break": true
  }
}
```

## License Notes

主要な利用ライブラリはおおむね商用利用しやすいライセンスです。

ただし、以下は個別確認が必要です。

- Tiptap Pro extensions
- フォント
- 教材テンプレート
- 画像素材
- アイコン
- 生成画像

初期からライセンス台帳を持ちます。

```text
package / asset
source URL
license
commercial use
redistribution
font embedding
notes
```

## 性能の原則

数値と計測方法は `docs/performance-budget.md`。ここには「なぜその形にしてあるか」を残す。

### レイアウトは文書につき 1 回

ページ割りは 1 つのエンジンが 1 度だけ決める。同じ文書に対して 2 つの経路が別々に
レイアウトを決めると、**どちらも自己整合なのに食い違う**状態が作れてしまう
（実際に、同じ教材の 2 つのマウントが 2px ずれた位置と、丸 1 ページずれた位置に落ち着いた）。
ページ割りが参照する値（隙間・行ボックス・ブロック矩形）は、**実際に描画された DOM から
読み戻す**。状態マップから取ると、DOM が追いつく前のパスと食い違って収束しない。

この不変条件の帰結として、**画面外の幾何を「描かない」最適化は現行のページ割りと両立しない**。
`content-visibility` はレイアウトを飛ばすが、ページ割りは矩形を読むので飛ばした部分木の
レイアウトを強制的に起こし、かつ高さが実測値と `contain-intrinsic-size` の間で往復する。

### 描画経路には唯一の出典を持つ

本文の見た目を決めるものは 1 箇所にしかない: `document-surface.css`、`rich-text-dom.ts`、
`TextFlowStaticBlock`、`OverlayTableStaticView`。編集面・印刷/PDF・viewer・素材プレビューは
すべてここを通る。**意図的に残した例外がある**（overlay テキストの囲み枠はセグメントごとに
border を引く、running region のリストは region スコープ、静的レンダラのリスト構造は編集面と
食い違う）ので、統一する前にその理由を読むこと。「速いから」と別の描画経路を足すと、そちらだけが古くなる。

同じ理由で、**ファイル形式にも唯一の出典を置く**。書き手と読み手が別々に定数とパーサを持つと、
片方だけ形式を変えたときに、もう片方が例外も出さずに「何も読めない」状態になる。

### 打鍵のコストはページ数から独立させる

打鍵で走る仕事は「打った場所の周り」に比例させ、文書の総ページ数に比例させない。具体的には:

- decoration は plugin state に持ち、`props.decorations` で文書全体を走査し直さない
- 計測は汚れたユニットから先だけ測る（列挙自体もユニット単位で持ち越す）
- 巨大コンポーネントに渡す props は identity を安定させる

同じ考え方を保存にも当てる。保存のコストは**履歴の長さから独立**させる
（履歴ファイルを毎回読み書きすると、保存が履歴の長さに比例して重くなる）。
教材の大きさからの独立はまだ達成していない（実測で main 側の保存は約 40ms かかり、文書サイズに比例する）。

### アイドルの描画は 0

何もしていない 3 秒間で React が描画したり、ページ割りが再計算したりするのは常に不具合。
「少しだけ回っている」は放置すると必ず増えるので、予算は 0 で厳格にしてある。

### 検証は境界で 1 回

信用できない入力（ファイル・IPC・MCP・貼り付け）を受ける**入口で 1 回だけ**検証する。
同じ文書を renderer と main の両方で検証していると、教材サイズに比例した時間を二重に払う。
逆に、入口を 1 つに絞ったつもりで裏口が残っていないかは、経路を全部辿って確かめる。

### 共通処理とコントローラの分割

- 公開Viewerの型は `packages/viewer/scripts/generate-document-types.mjs` が正本の
  `features/document/model` と `overlay-model` から生成する。`npm --workspace @sigma-studio/viewer run types:generate` で更新し、`types:check` で更新漏れを検出する。
  公開宣言にはデスクトップのソースパスを持ち込まず、非公開の基底型も含めて自己完結させる。
- グラフの座標変換・軸位置・ラベル式の解釈は `drawing/graph-coordinate-label.ts`、
  表の結合セルは既存の `getTableCellMatrix` を共有する。
- 3Dの点・ベクトルの型と加減乗算・内積・外積は`drawing/graph3d-vector.ts`が所有する。
  平面の解釈、立体の構成、変換、サムネイルはこの共通演算を使い、正規化の許容値とエラー方針は各呼び出し元に残す。
- ズーム通知はブラウザ描画の契約なので`rendering/adapters/editor-zoom-event.ts`に置く。
  coreの公開入口へDOMイベントの責務を持ち込まず、必要なcanvas adapterだけがこの小さな入口を参照する。
- ネイティブclipboardのイベント所有権と転送は`editor-shell/clipboard-events.ts`が扱う。
  copyのbubble、pasteのcapture、複数editorにまたがる置換の遅延順序を維持し、SigmaDocの変更・履歴・選択はshell側のportへ返す。
- 本文clipboardのcopy・cut・貼付経路と編集面ごとの履歴キーは`text-flow/clipboard-transactions.ts`が扱う。
  `manual-break-transactions.ts`は改ページを跨ぐ置換の準備とProseMirror transactionの受理を確認し、
  受理できた本文変更だけが図形貼付へ進む結果を返す。拒否時もnative pasteを止め、
  図形の遅延保存まで同じUndo区間を保持する。SigmaDocだけで決まる遷移はtext-editing featureに残す。
- 文書ファイルの判別、復旧、形式別parserとID・用紙・題名の正規化は`editor-shell/document-file-import.ts`が扱う。
  `use-document-file-commands.ts`がパスワード・テキスト受け渡しdialogのstate/ref、入出力操作を所有する。
  `use-workspace-document-commands.ts`が教材の開閉・作成・複製・一覧操作を扱い、解析・保存待ち・record作成・タブ採用の順序を保つ。
- タブを閉じる操作と教材一覧からの削除は`editor-shell/document-tab-commands.ts`が扱う。
  通常のタブ操作に使うrender時点の状態と、未編集教材の削除時に再確認する現在の状態を区別する。
  読み取ったrevisionでの削除、一覧・workspace同期、最後の空タブを閉じる際の保存停止・画面遷移の順序を保ち、
  文書とタブの共有state/ref、採用と保存境界はshellに残し、workspace commandへ明示的に渡す。
- 素材repositoryの取得・作成・更新・削除と一覧への反映は`editor-shell/material-library-commands.ts`が扱う。
  メタデータの入力変換は`material-metadata-draft.ts`に置き、dialog Viewから独立して利用する。
  `use-material-library-controller.ts`はReact state・下書きref・図形編集のflushとref読取を所有し、
  `material-library-dialogs.tsx`へ表示と操作を渡す。commandはloading・error・完了通知の順序を保ち、
  文書の変更・履歴・選択はshellのcommitと共有refを使う。
- 通常コマンドの実行は`editor-command-actions.ts`へ、毎renderの配送先更新とkeydown購読・解除は
  `use-editor-command-routing.ts`へ置く。文字・図形・メニュー・アプリ操作を明示的なportに分ける。
  AIのロックはhostが汎用の禁止状態へ投影し、generic commandからAI storeを参照しない。
  `use-desktop-menu-actions.ts`はネイティブメニューの購読と最新renderのhandler配送を所有する。
  `use-command-palette.tsx`は開いたときだけ候補を解決し、閉じた後の1 frameを経て本文コマンドを実行する。
- 段組みの区間先頭は1回のlayout処理内で累積値を再利用する。同じprefixを断片ごとに再集計せず、
  元と同じ順番で加算して小数の丸めと配置結果を保つ。
- 1段本文のgap計測と配置計算は`page-canvas/single-column-layout.ts`が扱う。
  DOM計測値の取得と配置計算を分け、凍結中の計測拒否、古い計測や振動の判定、React stateへの採用はPageCanvasに残す。
- 下余白dragの操作世代、保存後の描画待ち、再計測の保留は`page-canvas/space-after-drag-session.ts`が扱う。
  `space-after-commit-paint.ts`は保存結果がDOMに現れるまでの監視と期限、古い監視のcleanupを所有する。
  PageCanvasはpointer、プレビューのDOM更新、React stateを接続し、描画完了までpaginationの凍結を続ける。
- 画像のFileReader・Imageによるdecodeは`overlay-canvas/image-file.ts`、寸法と横並び配置は
  `features/drawing/image-insertion.ts`が扱う。canvasごとの`image-import-session.ts`が重複requestと完了通知を管理し、
  取り込み中は空canvasを維持する。完了時の配置情報、選択・履歴・保存への反映はcontrollerが供給する。
- 公開Editor/Viewerのバンドル設定は各`packages/*/scripts/build-options.mjs`を唯一の入口にする。
  本番buildとpackage-boundary testが同じalias・external・asset loaderを使い、テスト側では出力先への書込だけを止める。
- `AiModelMenuContents` はモデル／推論強度メニューの表示とキーボード操作を所有し、
  選択値の保存とプロバイダ固有の補正は呼び出し側が所有する。
- 設定値の購読は `subscribe-storage-preference.ts` で共有し、同一タブ・別タブの変更を
  通知する前にキャッシュを無効化する。設定ごとの検証と保存失敗時の方針は各設定に残す。
- Electronの `cli-child-env.ts` は環境変数の選別とPATH構築を共有する。
  認証を上書きする変数の禁止やプロバイダ固有の追加変数は各clientに残す。
- `editor-shell/use-document-save-boundary.ts` は保存と教材切替前の境界処理を所有する。
  EditorShellが所有する文書・revisionの参照とeditor-stateのsetterを受け取り、
  保存中の教材切替、保存失敗、競合を従来と同じ順序で処理する。
- `editor-shell/document-storage-sync.ts`は外部通知の購読・解除、連続する保存の完了待ち、
  通知の世代と教材切替の確認、分類・マージ・退避の順序を所有する。
  正本の採用・Undo履歴・保存はhostへ返し、embeddedでの無効化とeffectの依存境界はshellに保つ。
- ページのDOMヒット判定は `page-canvas/pointer-targets.ts`、図形の選択ハンドルは
  `overlay-canvas/selection-handles.tsx`、外部文書との同期は
  `overlay-canvas/use-document-snapshot-sync.ts` に置く。操作中・保存待ちの同期保留と
  Undo時の選択維持を保ち、各モジュールから親コントローラへ依存しない。
- 本文のコマンドポップオーバーは `text-flow/command-popovers.tsx` に置く。
  Tiptapの同期とevent配線はTextFlowEditorに残し、clipboardと改ページのtransactionは専用moduleを使う。
- PowerPointのXML解析・継承解決は `powerpoint-import/xml-source.ts`、
  入力モデルの変換とSigmaDocへの集約は `powerpoint-import.ts` が担当する。
- `globals.css` は `styles/` の機能別CSSを元のカスケード順に読み込む。
  文書面の正本は引き続き `document-surface.css`。CSSの契約テストは共通の
  `tests/helpers/read-stylesheet.ts` を通して分割先も検査する。
