# ローカルアプリMCP

Sigma Studio デスクトップ版のローカル保存教材を Claude Code / Codex / Antigravity CLI から編集するための MCP サーバーです。

## 使い方

このリポジトリには project scoped の設定を置いています。

- Claude Code: `.mcp.json`
- Codex: `.codex/config.toml`

どちらも次の stdio サーバーを起動します。

```bash
node apps/desktop/scripts/run-sigma-doc-mcp.mjs
```

初回起動時に `apps/desktop/mcp/sigma-doc-mcp-server.ts` を `apps/desktop/dist-mcp/sigma-doc-mcp-server.cjs` へ静かにビルドしてから起動します。MCP は stdout をプロトコルに使うため、起動ログは出しません。

各ツールは MCP annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) を宣言します。ホスト側の承認ポリシーはこの情報を利用できますが、annotations自体は認可機構ではありません。`.codex/config.toml` は対話利用前提で `default_tools_approval_mode = "prompt"` にしています。非対話実行では `"approve"` を設定してください (デスクトップアプリ内実行は `codex-agent-home/config.toml` を自動生成して `"approve"` を設定済み)。

## 保存先

既定では Electron の `app.getPath("userData")` と同じローカル保存先を探します。macOS では次を見ます。

```text
~/Library/Application Support/Sigma Studio
```

保存先を明示したい場合は環境変数を使います。

```bash
SIGMA_STUDIO_USER_DATA_DIR="$HOME/Library/Application Support/Sigma Studio" node apps/desktop/scripts/run-sigma-doc-mcp.mjs
```

`data` そのものを指す場合は `SIGMA_STUDIO_DATA_DIR` も使えます。

MCPからの書き込み系ツールは、既定では教材ファイルを直接保存しません。`data/proposals` に承認待ちの編集提案を作り、デスクトップアプリ側の「AI提案」ボタンから承認・却下します。

同じ `runId`(無ければ同じチャットルーム)の連続する書き込みは1つの提案グループに積み上がり、承認UIには「1ラン=1件(1ページ分の変更)」としてまとまって表示され、まとめて承認/却下できます。グループ内の後続ツールは、同一グループ内の未承認の先行操作を反映した中間状態に対して解決するため、`create_problem_content` で作ったばかりの(まだ承認していない)problemを同じrunの `update_problem_content` や overlay の anchor から参照できます(以前はNOT_FOUNDになっていました)。グループ内の挿入順はツール呼び出し順で確定し、承認順には依存しません。`withdraw_current_edit_proposal` はグループ全体を取り下げます。

例外として、`create_local_document` / `update_local_document` / `delete_local_document` / `create_local_folder` / `update_local_folder` / `delete_local_folder` は教材ライブラリの構成を直接更新します。対象はSigma Studio管理下の個人ワークスペースID・フォルダID・fileIdに限定され、任意のOSパスは受け付けません。教材の更新・削除はrevisionを照合し、削除ツールには`destructiveHint:true`を付けます。

## 公開ツール

- `get_local_app_status` - ローカル保存先を確認します。
- `save_ai_resource` - Studio管理下のAIリソース(skill/instruction)を新規作成または更新します。skillは常にアプリ全体スコープ(全ワークスペースで使用)・全プロバイダ(Codex/Claude/Antigravity)向けに保存されます。`kind:"instruction"` はnameに既存の `global-instructions` のみ指定できます。
- `delete_ai_resource` - Studio管理下のskillをnameで削除します。ユーザーが明示的に削除を依頼した場合のみ使用してください。
- `update_ai_settings` - `aiAutoApplyVerifiedProposals` / `aiWebSearchEnabled` を部分更新します。変更内容は必ずユーザーへ報告してください。
- `list_local_documents` - ワークスペース、フォルダ、教材ファイルと revision を一覧します。
- `create_local_document` - 個人ワークスペース内に空のSigmaDoc教材を作成します。`workspaceId` / `folderId` は `list_local_documents` が返すアプリ管理IDだけを受け取り、任意のOSパスは扱いません。
- `update_local_document` - 個人ワークスペース内の教材名または配置フォルダを更新します。競合防止のため `expectedRevision` が必須で、ルート直下への移動は `folderId:null` を指定します。
- `delete_local_document` - 個人ワークスペース内の教材を削除します。直前の `expectedRevision` が必須で、ユーザーが削除を明示した場合だけ使います。OS上の任意ファイルは対象にできません。
- `create_local_folder` - 個人ワークスペース内にフォルダを作成します。ルート直下は `parentFolderId` を省略するか `null` を指定します。
- `update_local_folder` - 個人ワークスペース内のフォルダ名または親フォルダを更新します。自分自身や配下への移動は拒否されます。
- `delete_local_folder` - 個人ワークスペース内の空フォルダを削除します。教材または子フォルダがある場合は拒否され、OS上の任意ディレクトリは対象にできません。
- `read_local_document` - 既定の `detail:"summary"` ではrevision・ブロック数・構成・`pageLayout`の要約を返します。完全なSigmaDocが必要な場合だけ `detail:"full"` を指定します。
- `get_edit_context` - AI編集開始時に、現在revision・軽量outline・対象ブロックまたはoverlay図形の完全JSON・アンカー周辺の前後ブロックを1回で返します。アプリ実行時は`runId`を渡すと、実行開始時の選択テキスト・範囲offset・複数参照を`context.selection.references`に、複数ブロックにまたがる本文選択を`blockIds`/`blocks`に、複数図形選択を`shapeIds`/`shapes`に返します。`targetId`を省略した場合は`selectedId`、実行コンテキストの選択対象の順に使います。
- `get_document_outline` - 編集対象に使うブロックIDと現在の`pageLayout`を確認します。あわせて `overlayShapes`(表・グラフ・図形のID/種別/説明/アンカーブロックID/親グループID/絶対ページ座標 `x`,`y`)と `blockRects`(本文ブロックの推定ページ矩形。問題エリアの子ブロックなどネストしたブロックも含みます。`estimated: true`)も返します。`blockRects` と `overlayShapes` の座標は insert / update 系ツールの絶対 `x`/`y` と同じ座標系です。表(`tableShape`)・グラフ(`graph2dShape`)・図形はSigmaBlockではなくoverlay図形なので、削除・更新・整列したい場合はここからIDを確認してください。
- `get_block` - 指定ブロックを読みます。
- `get_blocks` - 複数ブロックを最大10件までIDでまとめて読みます。既定では `{id, type, text}` の軽量ビューのみを返し、`includeFull: true` を指定した場合のみ各ブロックの完全なJSONも含めます。
- `search_document` - 本文テキスト、TeX、表セル、overlayテキスト図形を横断してクエリ文字列を検索します。`get_document_outline` より対象を絞り込みたい時に使います。
- `search_library` - 今開いている教材だけでなく、ユーザーの過去教材ライブラリ全体から類似の問題・記述を検索します。`query`(必須)、`scope`(`"all"` 既定 / `"problems"`)、`limit`(既定8、上限20)、`excludeFileId`(結果から除外するfileId。通常は現在編集中の教材)を受け取ります。`scope: "problems"` にすると問題ブロック単位でヒットし、prompt本文とtagsを含む詳しい抜粋を返すため、類題を探す用途に向きます。
- `validate_local_document` - SigmaDoc と MathLive TeX を検証します。
- `list_edit_proposals` - 現在のrun/チャットに帰属するMCP編集提案の軽量な一覧を返します。`draft`、変更後教材全体、内部proposal IDは含みません。
- `get_edit_proposal` - `fileId`/`runId`から現在の作業案を読みます。既定の `detail:"summary"` は要約のみ、`detail:"full"` は再適用可能な `draft` を含みますが、内部の教材スナップショットとproposal IDは返しません。
- `withdraw_current_edit_proposal` - 同じチャットルームの未承認の作業案全体を取り下げます。
- `list_all_pending_proposals` - 指定した教材のセッション横断の保留中提案一覧を返します。roomId/runId に関わらず過去セッション由来の提案も含みます。デスクトップアプリのUI側で「他のセッションの保留中提案」として表示し、却下できるようにするために使います。
- `withdraw_edit_proposal` - 指定した proposalId の保留中提案を、セッション (roomId/runId) に関わらず取り下げます。`reason` 省略時は自動メッセージが使われます。
- `list_materials` - 保存済み素材を `description` / `usage` / `visualConcepts` / 内容要約で検索します。
- `get_material` - 保存済み素材のカタログ情報とSigmaDoc contentを読みます。
- `begin_visual_edit_session` - 図形を試作し、preview/inspection後に提案化するscratch sessionを作ります。必須の `sourceAnalysis` には、元画像と教材本文(問題文・近接ブロック・ラベル・寸法)から読み取った図の意味的構成を20字以上で記述してください(輪郭トレースではなく、『この図は何をどう作図したものか』の分析)。必須の `plannedShapes` には、図を構成する標準図形の分解計画を `{kind, purpose}` の配列で指定してください(円・円弧・扇形・曲線をpolylineで近似してはいけません)。
- `visual_insert_shape` - scratch sessionへ図形を追加します。提案はまだ作りません。`kind`が `polyline` または `freehand` の場合、begin_visual_edit_session の `plannedShapes` に同じ `kind` が宣言されていなければエラーになります。`rotationDeg`とarc/sectorの`startAngleDeg`/`endAngleDeg`は度で指定し、サーバーがoverlay内部のラジアンへ変換します。ページ座標はy軸下向きで0°=右、弧は`startAngleDeg`から`endAngleDeg`へ画面上の時計回りです(上半円は180→360)。circle/arc/sectorの`x`/`y`は円全体のバウンディングボックス左上で、中心は`(x+r, y+r)`です(ellipseは`(x+rx, y+ry)`)。
- `visual_replace_shape` - scratch session内の既存図形を置き換えます。位置・サイズ・折れ線pointsなどの修正に使います。角度fieldは`visual_insert_shape`と同じく度で指定します。
- `visual_remove_shape` - scratch session内の余分な図形を削除します。
- `render_visual_edit_session` - scratch session内の図形を、アンカーブロック周辺のページコンテキストと一緒にPNG previewとして返します(アプリのrender bridge経由、失敗時はresvgによるsvg-fallback)。`preview.previewFile`にはrun-scopedな絶対PNGパスが入り、画像右上にはreview用の5文字コードが描画されます。ChatGPTではinline image contentを既定で省略するため、必ず`previewFile`を`view_image`で開いて確認します。
- `inspect_visual_edit_session` - 不可視、極小、ページ外(全くページに重ならない/50%を超えてはみ出す場合はerrorとしてauto-fail)、折れ線点不足、自己交差などを検査します。polyline/freehand/curveが円またはその近似(Kåsa円フィット、点数6以上、RMSE < 半径の3%、中心角90°以上)と判定されたら、error「この折れ線は円/円弧の近似です (中心(x,y), 半径r)。kind:"arc" または "circle"/"sector" で表現し直してください」を返します。幅・高さ・opacity・font sizeが妥当な範囲外の場合はwarningとして知らせます(自動補正はしません)。

`plannedShapes` で `polyline` を宣言していても、inspectionで円・円弧の近似として拒否された場合は、セッションを作り直さず、`visual_replace_shape` で指摘された標準kind (`arc`、`circle`、`sector` など)へ変更してください。

- `review_visual_edit_session` - 元画像または参照図とpreviewを見比べた結果を記録します。必須の`previewCode`には、preview画像右上のバッジを実際に読んだ5文字コードを渡します(コードはpayloadに返しません)。合否はモデル自己申告の`score`ではなく、`previewCode`一致、`verdict:"pass"`、`issues`が空、直近の`inspect_visual_edit_session`が合格、直近の変更後に`render_visual_edit_session`が実行済み、という機械的な条件で決まります。`score`は引数として受け取り記録しますが、合否判定には使用しません。
- `propose_visual_edit_session` - render済み、inspection合格済み、review合格済みのscratch sessionをpending proposalにします。提案化直前にもinspectionを再実行し、失敗していれば拒否します。
- `discard_visual_edit_session` - scratch sessionを破棄します。
- `insert_material` - 保存済み素材を exact clone として挿入します。問題内へ置く場合は `area`、図形素材の配置調整には `x` / `y` / `scaleX` / `scaleY` を指定できます。追加回転の`rotationDeg`は度で指定します。
- `insert_body_content` - 本文、小見出し、枠を基準ブロックの直後へ挿入します。ホワイトボードには本文がないため使用できません。各blockに `pagination: { break?, keepTogether?, keepWithNext? }` を指定できます。problem内の既存段落直後へ入れる場合はその段落IDを`targetId`にして`area`を省略し、problemの特定領域へ末尾追加する場合だけ`area`を指定します。枠(boxBlock)を作成する場合は `{type: "boxBlock", styleId: "...", title?: "...", blocks: [...]}` の形式を使用します。styleIdは以下から選択: `fancybox`/`itembox`/`tcolorbox`/`tcolorbox-note`/`doublebox`/`shadebox`/`leftbar`/`dashedbox`/`ruledbox`/`screenbox`/`ovalbox`/`cornerbox`。`blocks` 内には段落、見出し、リスト、入れ子の枠を指定できます。枠は問題エリア内には挿入できません。
- `apply_edits` - 複数の型付き編集を1回のpending proposalへまとめる統合入口です。`replace_text`は既存SigmaDocを土台に本文の指定範囲だけをcopy-with置換し、元のフォント・ptサイズ・太字・色・囲みと範囲外内容を保持します。厳密な差分指定は`target:{type:"range",blockId,from,to,quote}`、完全一致文字列は`target:{type:"text",blockId,text,occurrence?}`、選択範囲は`target:{type:"activeSelection"}`、段落全体は`target:{type:"block",blockId}`を使います。`format_inline`は内容を変えず、paragraph/headingおよびtext/callout図形内テキストの書式だけを変更します。組み込みフォントは`fontFamilyToken:"body"|"sans"|"mincho"|"m-plus-1p"`です。
- `create_problem_content` - 問題を作成します。ホワイトボードには本文がないため使用できません。
- `update_rich_content` - 既存paragraph/headingの文章を `text` または型付き `runs` で更新し、`pagination` だけの更新もできます。`pagination: null` でページ指定を解除します。ID・type・heading levelなどはサーバー側で保持します。
- `update_problem_content` - 既存problemの `lead` / `prompt` / `answer` / `solution` / `hints` / `pagination` のうち指定した項目だけを更新します。`lead` / `solution` / `hints` は空配列、`answer` と `pagination` は `null` で消去できます。
- `replace_block` - 専用更新ツールで表せない構造変更のfallbackです。`pagination` を含む既存ブロックを完全な型付きブロック定義で置換し、IDとtypeは変更できません。
- `delete_blocks` - 本文ブロック(トップレベル、および問題のlead/prompt/hints/solution内のブロック)をIDで指定して削除します。表・グラフ・図形はoverlay図形なのでここでは削除できません(`delete_shapes` を使ってください)。
- `move_blocks` - 本文ブロックを、指定した対象ブロックの前後へ移動します。
- `update_page_layout` - SigmaDocのページ設定を部分更新します。`preset` (`A4`/`A3`/`B5`/`B4`/`custom`)、`orientation` (`portrait`/`landscape`)、`customSizeMm`、`marginsMm` のうち指定したfieldだけを変更し、未指定field、段組み、ヘッダー、フッターは保持します。用紙サイズと余白の単位はmmです。`customSizeMm`は`preset:"custom"`と同時に指定します。変更前に`read_local_document`または`get_document_outline`で現在の`pageLayout`とrevisionを確認し、成功後はverificationのページpreviewを確認してください。
- `update_column_layout` - 段組みを変更します。`scope: "document"` は文書全体、`scope: "blocks"` は連続した本文ブロックを新しい `layoutSection` で囲み(問題のsolutionエリアやboxBlock内の段落も対象にできます)、`scope: "section"` は既存 `layoutSection` の段数・段間を更新します。boxBlock内では作成した複数段layoutSectionの中だけ改段でき、箱直下の手動改ページはできません。ローカル段組みの解除は `scope: "section", unwrap: true` を使い、`columnCount: 1` は1段のsectionとして保持します。`scope: "document"` はブロック単位のrevision緩和を行わず、`expectedRevision` の完全一致が必要です。実行前に `get_document_outline` で現在の段組みとsection IDを確認し、実行後は `data.verification.validation` とPNG previewを確認してください。
- `list_generated_images` - Codexの現在の依頼で生成した画像の`imageId`、寸法、プレビューを返します。依頼と同じ`fileId` / `runId`が必須です。生成完了直後に空ならturnを終了し、ホストの取り込み後の続行を待ちます。
- `insert_generated_image` - `imageId`を通常の画像assetとimage shapeに変換し、挿入の承認待ち提案を作ります。`targetId`または`selectedId`が必須で、ホワイトボードは`CANVAS`。同じ画像の再呼び出しでは図形を重複させません。
- `update_generated_image` - `shapeId`の画像を生成結果へ差し替える承認待ち提案を作ります。位置、表示サイズ、回転、アンカーを保持し、assetを共有する別の図形へ影響させません。
- `get_image_reference` - 教材内のimage shapeをCodexの画像編集へ渡す参照画像として取得します。`fileId` / `runId` / `shapeId`が必須。返る`filePath`を`view_image`と画像生成ツールの参照入力に使います。自己完結SVGは検証後にPNGへ変換します。
- `insert_svg_image` - AIが書いた自己完結した静的SVGを、画像アセットとimage shapeとして承認待ち提案へ追加します。`svg`にxmlnsとviewBoxが必須。`targetId`（ホワイトボードは`CANVAS`）または`selectedId`、必要に応じて`area`/`x`/`y`/`w`/`h`/`name`を指定します。片方だけの表示寸法は縦横比を保持します。座標省略時はアンカーの下へ配置します。本文とは独立した画像レイヤーなので、プレビューで重なりを確認し、必要なら`update_shape`で位置・サイズを調整します。SVG原文はSigmaDocのasset.props.src（base64）に保存し、描画結果は`verification.preview`で確認します。
- `update_svg_image` - `shapeId`と新しい`svg`でSVG画像を差し替える承認待ち提案を作ります。位置・表示サイズ・回転・アンカーを保持し、共有アセットは対象画像だけを変更します。原文は`read_local_document(detail:"full")`で取得できます。両ツールとも最大256 KiB・4096要素・64段、xmlnsと正のviewBoxが必要です。静的なpath・基本図形・text/tspan・defs・グラデーション・clipPath・mask・markerと表示属性のみを受理し、style・script・外部参照・use・foreignObject・アニメーション・XML宣言を拒否します。`verification.preview`のPNGを実見して必要なら更新します。previewが生成できない場合は未確認として扱い、`render_block_context`/`render_page`で再確認します。
- `insert_shape` - 通常の図形、補助線、矢印、折れ線、曲線、ハイライト、テキスト注記、吹き出しを overlay に挿入します。ホワイトボードでは `targetId:"CANVAS"` と絶対座標 `x`/`y` を指定し、本文・ページ anchor を作りません。吹き出し(`kind:"callout"`)は`text`/`tex`を内部のリッチテキストとして保持する単一オブジェクトです。`kind:"text"`では`markdown`に複数段落、見出し、リスト、`$...$`数式を指定でき、`text`/`tex`/`label`とは併用できません。`w`/`h`は本文矩形のサイズ、`cornerRadius`は角丸半径、`tailBaseStart`/`tailBaseEnd`は本文矩形外周上の独立した麓2点、`tailTip`は自由に動く頂点で、3点は本文矩形左上基準の相対座標です。`rotationDeg`とarc/sectorの`startAngleDeg`/`endAngleDeg`は度で指定し、サーバーがoverlay内部のラジアンへ変換します。ページ座標はy軸下向きで0°=右、弧は`startAngleDeg`から`endAngleDeg`へ画面上の時計回りです(上半円は180→360)。circle/arc/sectorの`x`/`y`は円全体のバウンディングボックス左上で、中心は`(x+r, y+r)`です(ellipseは`(x+rx, y+ry)`)。`kind:"text"`は`w`がテキストの折り返し幅で、省略すると既定幅になります。高さは内容から導出されるので`h`は指定できません。標準kindで表せる図形を`polyline`で近似しません。線・矢印・開いた曲線・開いた円弧の端点装飾は`arrowheadStart`/`arrowheadEnd`に`none`/`arrow`/`triangle`/`openArrow`/`thinArrow`/`diamond`/`dot`/`bar`、またはそれぞれを小さく描く`arrowSmall`/`triangleSmall`/`openArrowSmall`/`thinArrowSmall`/`diamondSmall`/`dotSmall`/`barSmall`を指定します(始点と終点は独立、線幅に比例して拡大)。**位置指定**は絶対座標(`x`/`y`)または`placement`のいずれか一方です。`x`/`y`・`points`・`start`/`end` はページ左上基準の絶対座標で、`update_shape` と同じ座標系です。基準にする座標は `get_insertion_candidates` の `rect`(推定値)や `get_document_outline` の `blockRects` / `overlayShapes` の `x`,`y` から取得します。`x`/`y` を省略するとアンカーブロック直下24pxに配置され、位置を意味で指定できる場合は `placement` が推奨です。
- `update_shape` - 通常のoverlay図形をIDで指定し、位置・回転・表示状態・色・線・サイズ・ラベルなどを部分更新します。吹き出しは`w`/`h`/`text`/`tex`/`fontSize`/`cornerRadius`/`tailBaseStart`/`tailBaseEnd`/`tailTip`を同じshapeへ直接更新できます。text図形の`text`/`tex`/`markdown`/`fontSize`を更新すると、本文変換と高さの導出を同じ操作で行います。text図形の幅は`w`で指定し、高さは内容から導出されるので指定できません。`rotationDeg`は時計回りの度で指定し、サーバーがoverlay内部のラジアンへ変換します。`points`はline、`start`/`end`はarrowの絶対座標更新に使います。表とグラフには専用ツールを使います。
- `align_shapes` - 複数のoverlay図形をIDで指定し、指定したモードで整列または等間隔配置します。
- `delete_shapes` - overlay図形(表・グラフ・通常の図形をすべて含む)をIDで指定して削除します。IDは `get_document_outline` の `overlayShapes` または `search_document` で確認してください(本文ブロックの削除は `delete_blocks`)。
- `insert_table` - 表や増減表を overlay に挿入します。通常表は `kind: "plain"` と `cells` を使います。ホワイトボードでは `targetId:"CANVAS"` を指定し、本文・ページanchorなしで配置します。増減表は `kind: "variation"` と `criticalPoints` / `intervalSigns` / `trends` / `criticalValues` を使います。増減表の定義域端点は `leftEndpoint` / `rightEndpoint`、端点での関数値または極限は `endpointValues`、行ラベルは `variableLabel` / `derivativeLabel` / `functionLabel` で指定できます。表全体の枠線は `grid` の `borderStyle` (`solid` / `dashed` / `dotted` / `double`)・`borderColor`・`borderWidth`・`showOuterBorder`・`showInnerBorders`、共通の文字色・背景色などは `defaultCellStyle` で指定できます。問題内へ置く場合は `area` に `lead` / `prompt` / `hints` / `solution` を指定できます。
- `update_table` - 既存tableShapeのID・位置・anchorを保持したまま部分更新します。1セルだけの修正は`cellPatches`(`{row, col, content}`の配列)を使うと、列幅・行高さ・`grid`・`defaultCellStyle`・他のセルを完全に保ったまま対象セルだけ置き換えます。`cells`/`rows`/`columns`等で内容を部分再構成する場合も、未指定の列幅・行高さ・`grid`・`defaultCellStyle`は既存表の値を引き継ぎ、既定値へリセットしません。`delete_shapes`+`insert_table`で作り直すとこれらが失われるため避けてください。
- `insert_graph` - 2Dグラフを overlay に挿入します。問題内へ置く場合は `area` に `lead` / `prompt` / `hints` / `solution` を指定できます。軸名、点ラベル、注釈、曲線式ラベルはグラフ本体SVG内ではなく、graph-owned text shapeとして作られ、フォントサイズはptで保持されます。目盛りラベルのサイズも `axes.tickFontSize` にptで指定します。グラフ図形の位置・幅・高さはpxのままで、`w` / `h` は目盛り文字などのSVG余白を除いたプロット範囲を指定します。グラフは白黒基調が既定で、色を指定しなかった曲線・点・塗り領域は黒/グレー階調になり、複数曲線は色ではなく線種 (`dash`) で区別されます。色は明示的に指定した場合だけそのまま使われます。`points[].labelPlacement` (`n`/`ne`/`e`/`se`/`s`/`sw`/`w`/`nw`) で点ラベルの方位を指定でき、省略時は曲線・軸・他の点やラベルを避けて自動配置されます。
- `update_graph` - 既存graph2dShapeのID・位置・anchorを保持したまま、`insert_graph` と同じ型付きGraph2D fieldで指定箇所を更新します。未指定fieldは保持され、旧graph-owned labelは削除して更新後specのラベルへ同期します。
- `insert_graph3d` - 3Dグラフ(`graph3dShape`)を overlay に挿入します。数学座標はz軸が上向き(`zUp`)の右手系です。`preset` (`revolution` / `surface` / `tricylinder` / `sphereTetrahedron` / `blank`) を出発点に、指定した配列 (`objects` / `regions` / `annotations` / `parameters`) だけが丸ごと置き換わり、`camera` / `view` は既存値へ浅くマージされます。式はTeXではなく評価用の式で、オブジェクトの `rotation` はラジアンの式 (`pi/2` = 90°、overlay図形の `rotationDeg` とは別系統)、`camera.fov` だけが度、`w` / `h` はpxです。`annotations[].labelTex` はTeXで、ラベルは派生PNGへ焼かず印刷・PDFでもベクタのラベル層として重ねられます。挿入時にサーバー側でヘッドレスに派生PNGを作り、`previewAssetId` / `previewSourceHash` を埋めるため、アプリで開かなくても印刷・PDF・ビューアに実物の図が出ます(描けなかった場合も挿入は成功し、アプリが開いた時にWebGLが描き直します)。関数グラフ・座標平面・数直線・領域図は2Dの `insert_graph` を使います。
- `update_graph3d` - 既存graph3dShapeのID・位置・anchor・未指定fieldを保持したまま、`insert_graph3d` と同じ型付きGraph3D fieldと `w` / `h` を部分更新します。指定した配列は丸ごと置き換わり、`camera` / `view` は浅くマージされます。specを変更した場合は派生PNGも同じ操作で差し替えます。`delete_shapes` + `insert_graph3d` で作り直すと位置・サイズ・カメラが失われるため避けてください。
- `render_block_context` - 教材の現在の保存内容、または`currentProposal:true`で現在のrun/チャットの作業案を今の教材へ再適用した結果を、`blockId`(省略時は作業案の変更ブロックの先頭)周辺のページコンテキストPNGとして返します。`preview.previewFile`に絶対PNGパスを返し、ChatGPTではinline image contentを省略します。
- `render_page` - `pageNumber`(ページ番号)または`blockId`(そのブロックが配置されたページ)のどちらか一方を指定し、ページ全体のPNGを返します。`profile`(`student` / `teacher` / `answerBook`)を指定でき、`currentProposal:true`で未承認案を再適用した結果を描画します。応答の`page`に`pageNumber` / `totalPages` / `blockIds` / `splitBlockIds`を含むため、独立したpagination情報取得ツールは設けません。**TODO:** 生徒用・教師用・解答集という出力プロファイル分岐は暫定であり、将来はこの区分と`profile`引数を廃止して単一の描画経路へ統合します。
- `get_selected_block` - デスクトップアプリのAIチャットから実行した時に、ユーザーが選択中のブロックを返します。アプリの実行コンテキストがない場合(外部CLIからの実行など)は空の結果を返します。
- `get_active_reference` - 同様にアプリ実行時、ユーザーが選択・参照中のコンテキストを `references` 配列(複数可、0件 = 参照指定なし)で返します。各要素は kind/targetId に加え、テキスト選択の抜粋やmathInlineのTeXなどの詳細を持ちます。「この式」「選択部分だけ」のような単一参照だけでなく、ワンドボタンでピン留めした複数の参照も同時に返ります。旧clientとの互換用に先頭要素を `reference` (0件ならnull)でも返します。アプリの実行コンテキストがない場合は空の結果を返します。
- `get_insertion_candidates` - 同様にアプリ実行時、選択ブロック付近の挿入候補位置を返します。各候補には推定ページ矩形 `rect`(`pageIndex` / `left` / `top` / `width` / `height` / `estimated: true`)が付き、insert 系ツールの絶対 `x`/`y` の基準に使えます。アプリの実行コンテキストがない場合は空の結果を返します。
- `get_neighbor_blocks` - 同様にアプリ実行時、選択ブロックの前後ブロックを返します。アプリの実行コンテキストがない場合は空の結果を返します。
- `get_attached_media` - 同様にアプリ実行時、ユーザーが添付した任意形式のファイルを返します(最大4件)。各attachmentにはrun-scopedな絶対`filePath`が付きます。PNG/JPEG/GIF/WEBPはimage content、その他の形式は埋め込みresource contentとして実内容を返します(ChatGPTではinline image contentを省略するため、画像は`filePath`を`view_image`で開きます)。PDFはChatGPT/Antigravity向けにページ画像と抽出テキストへ変換し、`pdf.pageCount`、`pdf.pages[].pageNumber/text/previewFile`、`pdf.nextPageStart`を返します。1回最大4ページで、続きは同じ`runId`に`attachmentId`と`pageStart=nextPageStart`を指定します。ChatGPTは`previewFile`を`view_image`で開き、Antigravityはページ順のimage contentも読みます。ClaudeにはPDF原本をdocument contentで直接送信します。変換失敗はattachmentの`error`と`warnings`で通知します。図形参照から作ったpreviewには `sourceReferenceKey` が付き、`get_active_reference.references` の対応要素を特定できます。アプリの実行コンテキストがない場合は空の結果を返します。
- `get_mentioned_sigma_docs` - 同様にアプリ実行時、ユーザーが@メンションした他教材のSigmaDocを返します。アプリの実行コンテキストがない場合は空の結果を返します。

以上6つのアプリ実行時コンテキストtoolに加えて、`read_local_document` / `get_document_outline` / `get_block` / `get_blocks` / `search_document` / `search_library` も任意の `runId` 引数を受け取ります(後者は参照元の自動記録に使われます — 「Agentic RAG」節参照)。これらのtoolは、任意の `runId` 引数を受け取ります。プロンプトはエージェントに自分のrunIdを伝え、毎回のtool呼び出しで渡すよう指示します。Codex (app-server) とAntigravityは全runで1つのMCPサーバープロセスを共有するため、`runId` を渡すことで並行実行中の複数run分の実行コンテキストファイル(`<provider>-<runId>.run-context.json`)から自分のものを解決できます。省略した場合は、起動時にMCP設定へ焼き込まれた provider 単位の静的な実行コンテキストファイル(`<provider>.run-context.json`)にフォールバックします(単発実行や、runIdを渡し忘れた場合の互換用)。Claudeは1turnごとに `--mcp-config` を渡すため元々runId別ファイルですが、同じ命名規則で解決されるため `runId` を渡しても矛盾なく動作します。添付がある場合は `get_attached_media` に `runId` を渡してimage/resource contentを取得します。特にAntigravityの画像は `@` ファイル参照だけに依存しません。

## アプリ内AI向けの本文ツール

アプリが起動するMCPには `SIGMA_STUDIO_MCP_TOOL_PROFILE=app` を渡します。このprofileでは本文編集の8入口を以下の4入口へ置き換え、`tools/list` にも新しい入口だけを公開します。環境変数を指定しない外部MCPは、上の「公開ツール」の名前・入力・説明を維持します。図形・表・グラフ・ライブラリなどの入口は共通です。

| アプリ用ツール | 操作と既存処理への対応 |
|---|---|
| `insert_content` | `content.format:"markdown"` を既存のMarkdown変換器でSigmaDocブロックへ変換し、`insert_body_content` へ渡します。囲み枠・明示的書式・paginationには `content:{format:"blocks",blocks:[...]}` を使います。 |
| `edit_text` | `edit.action:"patch"` は `apply_edits`、`"update"` は `update_rich_content`、`"replace_structure"` は `replace_block`。構造置換は完全な現在ブロックを読んでから使うfallbackです。 |
| `edit_problem` | `edit.action:"create"` / `"update"` を `create_problem_content` / `update_problem_content` へ振り分けます。 |
| `organize_blocks` | `edit.action:"move"` / `"delete"` を `move_blocks` / `delete_blocks` へ振り分けます。 |

`fileId` / `runId` / `expectedRevision` / `writeMode` と、対応する操作の `sourceReferences` は最上位です。操作別の入力は `edit` 内へ入れます。`insert_content` は `targetId` / `selectedId` / `area` を最上位、本文を `content` 内へ入れます。操作の種類によって必要な引数が異なるため、`edit` / `content` は判別可能なunionとして公開し、混在した引数や必須項目の不足を実行前に拒否します。

```json
{
  "fileId": "file_1",
  "runId": "run_1",
  "expectedRevision": 3,
  "edit": {
    "action": "patch",
    "operations": [
      {
        "op": "replace_text",
        "target": { "type": "text", "blockId": "p_1", "text": "変更前" },
        "replacement": "変更後"
      }
    ]
  }
}
```

この入力例は `edit_text` 用です。IDとrevisionは実行時に `get_edit_context` などで取得します。Markdownは段落・見出し・入れ子リスト・fenced code・太字・斜体・`$...$` / `$$...$$` 数式に対応し、通常のドル記号は `\$` と書きます。表・リンク・画像・blockquote・inline codeの構造変換は行いません。ホワイトボードでは既存の本文ツールと同じ制約が適用されます。

既存handlerの検証、対象の鮮度確認、run/roomへの帰属、1件の作業案への蓄積、dryRun、検証・previewをそのまま通します。本文を直接保存する新しい経路はありません。プロンプトはこのprofileに合わせた説明を使い、ユーザーの指示・選択テキスト・添付リソースは書き換えません。古い会話・スキルの呼び出し例より現在の `inputSchema` を優先する旨は、再開turnでも通知します。

Claudeの `--allowedTools` も同じツール名対応を使います。ただしカテゴリごとの実行許可は、MCPの公開スキーマ自体をカテゴリ別に削減する仕組みではありません。`sigma-doc-mcp-app-tools.test.ts` は両profileの実際の `tools/list` を比較し、公開定義のUTF-8 JSONサイズを計測します。この数値はモデルのトークン消費量やツール選択成功率ではありません。

## AI向けの選択・入力例

以下は外部MCPの入力例です。アプリ内AIでは上のprofileと現在の `inputSchema` に従います。

次の例の `fileId` / `targetId` / `expectedRevision` / `runId` はプレースホルダです。実行時は読み取りツールの返値に置き換えます。`writeMode` は通常省略し、pending proposalを作成します。

本文とインライン数式を教材末尾へ追加する例:

```json
{
  "fileId": "file_...",
  "targetId": "END_OF_DOCUMENT",
  "blocks": [
    {
      "type": "paragraph",
      "id": "ai_body_1",
      "runs": [
        "式 ",
        { "type": "math", "id": "ai_math_1", "tex": "x^2+1" },
        " を考える。"
      ]
    }
  ],
  "expectedRevision": 3,
  "runId": "run_..."
}
```

問題を新規作成する例:

```json
{
  "fileId": "file_...",
  "targetId": "p_1",
  "prompt": [
    {
      "id": "ai_prompt_1",
      "runs": [
        "方程式 ",
        { "type": "math", "id": "ai_prompt_math_1", "tex": "x^2-4=0" },
        " を解け。"
      ]
    }
  ],
  "answerTex": "x=\\pm2",
  "solution": [{ "id": "ai_solution_1", "text": "因数分解する。" }],
  "expectedRevision": 3,
  "runId": "run_..."
}
```

本文・見出しの文章変更は`apply_edits`の`replace_text`で差分だけを送り、既存書式を継承します。内容を変えず選択範囲の書式だけを変更する場合は同toolの`format_inline`を使います。`update_rich_content`は段落内run構造全体を意図的に再構成する場合、問題内の各領域は`update_problem_content`を使います。`replace_block`は部分patchではありません。専用toolで表せない構造変更に限り、先に`get_block`で完全な現在値を読み、`id` / `type`と変更しないfieldを保った置き換え後ブロック全体を`block`へ渡します。

選択ブロックは編集位置の手掛かりであり、編集範囲の上限ではありません。意味やレイアウト上必要なら、同じrun/room内で `update_rich_content` / `update_problem_content` と `insert_body_content` / `delete_blocks` / `move_blocks` を組み合わせ、1件の作業案としてブロックを分割・追加・削除・移動します。独立した説明文を配置目的だけで数式の `\text{...}` や `aligned` の1行に残さず、説明paragraphへ分離します。たとえば数式中の「よって，両辺を…」を左端へ出す場合は、元の数式paragraphを前半だけに更新し、その直後へ `align:"left"` の説明paragraphと後半の数式paragraphを順に挿入します。

本文とoverlayの操作対象は分けます。

- 本文・見出し: `get_block` / `apply_edits` / `update_rich_content` / `replace_block` / `delete_blocks` / `move_blocks`
- problem: `get_block` / `update_problem_content` / `replace_block` / `delete_blocks` / `move_blocks`
- 表・グラフ・図形: `get_document_outline` の `overlayShapes` / `apply_edits`（text/callout内の書式）/ `update_table` / `update_graph` / `update_graph3d` / `update_shape` / `align_shapes` / `delete_shapes`

書き込み後は `data.proposalCreated` だけで完了判定せず、`data.changeSummary` と `data.verification.validation` / `data.verification.preview` を確認します。`data.proposalCreated: true` は承認待ちであり、教材本体への反映済みを意味しません。

## Antigravity CLI (`agy --print`) 実行時の注意

Antigravity CLI (`agy`) は実機確認 (1.0.16〜1.1.5) で次の挙動が判明しており、`GeminiHeadlessClient` (`apps/desktop/electron/gemini-headless-client.ts`) の実装はこれを前提にしています。

- `--print` は値を取るGoスタイルのstringフラグで、フラグ単体では機能しません。現行CLIではプロンプト本体を `--print=<本文>` として渡します。stdinだけを渡す方法は `empty prompt` になり、`--print=@ファイルパス` はファイル内容をプロンプトとして展開せず、ファイルを読む依頼として扱われるため使用しません。`--print` の後に値なしで他のフラグを続けると、次のトークンをその値として消費してしまい以降のフラグが丸ごと無視されます。
- printモードはツールの許可確認を対話表示できません。未設定の権限は自動拒否されるため、アプリは `~/.gemini/antigravity-cli/settings.json` の `permissions.allow` に `mcp(sigma-studio-local/*)` と、Sigma Studioがそのrun用に生成するコンテキスト・添付・検証画像だけを対象にした `read_file(<userDataDir>/data/ai-run-context)` を冪等に追加します。Antigravityは添付画像を読む過程で`previews`の親ディレクトリも列挙するため、`previews`だけの旧ルールはこのrun-contextディレクトリのルールへ自動移行します。既存のモデル・信頼済みワークスペース・ほかの許可/拒否設定は保持し、教材ライブラリや提案保存先、`--dangerously-skip-permissions`、`mcp(*)`、`read_file(*)`のような全許可は使いません。
- printモードのstdoutは最終応答の**プレーンテキストのみ**で、Claude/Codexのようなツール呼び出しイベント(`tool_use` 等)は一切流れません。会話ID(`conversation`)を含むJSONイベントも出ません。会話IDは `--log-file` に指定したログファイルへ書かれる `printmode.go:179] Print mode: conversation=<id>, sending message` という行から回収し、`--conversation` によるresumeに使います(turn終了後、読み取り済みのログファイルはbest-effortで削除します)。
- printモードのCLIには呼び出したツール名を得る手段がありません(transcript.jsonlにも載りません)。そのため共有MCPサーバー (`apps/desktop/mcp/tool-activity.ts`) が全ツール呼び出しを自分で `ai-run-context/antigravity[-<runId>].tool-activity.jsonl` へ記録し(`SIGMA_STUDIO_MCP_PROVIDER=antigravity` のときのみ有効)、デスクトップ側 (`apps/desktop/electron/gemini-tool-activity-watcher.ts` を `gemini-edit.ts` がポーリング)がこれを読んでAI編集パネルの「ツール実行中... (ツール名)」表示に変換します。
- `@ファイル参照` で渡した画像はprintモードのモデルに届きません(実機確認)。MCPツールの結果として返されるimage content(`get_attached_media`)は届くため、添付画像は必ず `get_attached_media` 経由で渡します(プロンプトの誘導は `apps/desktop/electron/gemini-edit.ts` の `formatAttachmentInstruction` / `apps/desktop/src/lib/ai/mcp-edit-prompt.ts` を参照)。

## 編集ルール

SigmaDoc JSON が正本です。MCPツールは Tiptap JSON、HTML、LaTeX全文、overlay canvas の編集途中状態を正本として扱いません。

図形、画像、表、グラフの問題エリア所属は、shape専用fieldではなく `anchor.blockId` から導出します。`insert_shape` / `insert_table` / `insert_graph` / `insert_graph3d` の `area` は、対象problem内の実rich blockへ `block` anchorを張るための補助指定です。空の `lead` / `hints` / `solution` へ挿入する場合は、ツール側で空paragraphを作ってからそのIDへanchorします。

表(`tableShape`)・2Dグラフ(`graph2dShape`)・3Dグラフ(`graph3dShape`)・通常の図形は、いずれも本文ブロック(SigmaBlock)ではなくoverlay図形です。IDは `get_document_outline` の `overlayShapes` から確認し、表は `update_table`、2Dグラフは `update_graph`、3Dグラフは `update_graph3d`、通常図形は `update_shape`、整列は `align_shapes`、削除は `delete_shapes` を使ってください。誤って `delete_blocks` に図形/表/グラフのIDを渡した場合、またはその逆(`delete_shapes` に本文ブロックのIDを渡した場合)は、正しいツールを案内するエラーメッセージが返ります。

通常の図形・模式図・注記は`insert_shape`で編集可能なネイティブ図形として提案し、細かな位置・サイズ・重なりはユーザーがクライアントで仕上げます。元画像・参照図への忠実な再現、またはユーザーが見た目の一致を明示した場合だけvisual edit sessionを使います。その場合は`begin_visual_edit_session` → `visual_insert_shape` → `render_visual_edit_session` → `preview.previewFile`を`view_image`で開く → `inspect_visual_edit_session` → `review_visual_edit_session`(`previewCode`に画像右上の5文字コードを渡す)を必要なだけ繰り返し、最後に`propose_visual_edit_session`を呼びます。円・楕円・円弧は標準kindで作り、多数点の折れ線で近似しません。

### 視覚レビューの強制継続と状態ファイル

デスクトップのAI編集runは、各turnの完了後に、同じrunIdのvisual edit sessionが視覚レビュー合格・提案化または破棄まで到達したかを確認します。未完了セッションが残っている場合、同じ会話(thread/session)へ継続指示を送り、`render_visual_edit_session` → preview画像の実見 → `inspect_visual_edit_session` / `review_visual_edit_session` → 必要な修正 → `propose_visual_edit_session` のループを最大3回まで続けます。ChatGPTでは`previewFile`を`view_image`で開くように指示されます。3回継続しても未完了なら、AI編集結果に「図形の視覚レビューが合格しないまま終了しました。図形提案は作成されていません。」という警告を付けます。ユーザーがキャンセルした場合は継続せず、通常のキャンセル結果を返します。

MCPサーバーは、run-contextディレクトリへ次のrun単位のJSONをbest-effortで書き出します。

`<provider>-<runId>.visual-sessions.json`

`<provider>` は `claude` / `chatgpt` / `antigravity` のいずれかです。内容は次の形式です。

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "sessions": [
    {
      "sessionId": "visual_session_...",
      "targetId": "block_...",
      "operationCount": 1,
      "revision": 1,
      "lastReviewPassed": false,
      "proposed": false,
      "discarded": false
    }
  ]
}
```

Electron側が判定する未完了セッションは `operationCount > 0` かつ `proposed:false` かつ `discarded:false` です。ファイルが存在しない、JSONが壊れている、または書き込み先を解決できない場合は空として扱われ、状態ファイルの書き込み失敗がMCPツール実行や教材編集を失敗させることはありません。runIdを渡さないツール呼び出しは、このrun単位の強制継続の対象として紐付けられません。

保存済み素材は、AIが意味的に選べるように短い `description`、用途カードの `usage.useCases` / `usage.aliases` / `usage.avoidWhen`、画像内パーツ照合用の `visualConcepts`、接続点の `ports` を持てます。添付画像や参照図を再構成する場合は、まず画像内部を部品・記号・注記・接続構造に分解し、それぞれの一般名、用途、形状特徴を `list_materials` の `query` / `concepts` に渡して素材を探します。必要なら `get_material` で内容を確認してから `insert_material` で挿入します。合う素材がある場合は、通常の作図toolで再生成せず、保存済みcontentをcloneして使います。

書き込み系ツールでは `expectedRevision` が必須です。まず `list_local_documents` または `read_local_document` のsummaryで `fileId` と `revision` を確認してから渡してください。指定がない場合はツール呼び出し自体がエラーになります。`writeMode` の既定値は `"proposal"` です。提案を保存せず検証だけしたい場合は `writeMode:"dryRun"` を指定します。教材へ直接commitする経路はありません。

`expectedRevision` は完全一致でなくても、その書き込みが実際に触るブロック/overlay図形が `expectedRevision` 時点から変わっていなければ受理されます(renderer側の人間の編集は保存のたびにrevisionを進めるため、無関係な編集のたびに書き込みが失敗するのを防ぐための緩和です)。受理された場合はツール応答の `data.revisionReconciliation` に実際に使われた現在revisionが入るので、以後はそちらを `expectedRevision` に使ってください。触った対象自体が実際に変更されていた場合のみ `REVISION_MISMATCH` になり、`error.details.conflictBlockIds` / `error.details.conflictBlocks` に競合したブロックの現在の内容が入るので、それを踏まえて編集を作り直してから、`error.details` に含まれる現在revisionで再試行してください。`propose_visual_edit_session` もセッション開始時のrevisionを基準に同じ判定を行います。

書き込み系ツールおよび `begin_visual_edit_session` は任意の `runId` 引数も受け取ります。渡すと、作成されるpending proposalが呼び出し元のAIセッション(runId/roomId/turnId/sessionLabel)へ帰属します。プロンプトはエージェントに自分のrunIdを毎回渡すよう指示します。

`insert_body_content` / `create_problem_content` / `insert_table` / `insert_shape` / `insert_graph` / `insert_graph3d` / `insert_material` は `targetId` または `selectedId` が必須です。省略はできません(以前は無指定時に教材の最後のブロックへ黙って挿入していましたが、この暗黙フォールバックは廃止しました)。教材末尾に追加したい場合は `targetId: "END_OF_DOCUMENT"`、ホワイトボードへ図形・表・グラフを追加したい場合は `targetId: "CANVAS"` を明示的に指定してください。対象ブロックIDが分からない場合は `get_document_outline` / `search_document` / `get_block` (`get_blocks`)で確認します。

### Agentic RAG: 過去教材を参照して編集する

現在の教材内だけでなく、ユーザーが過去に作った教材ライブラリ全体から類似の問題・記述を探して今の編集に活かしたい場合は、次のループで進めます。

1. `search_library` にクエリを渡して呼びます。クエリの言い回しを変えて複数回呼ぶと、単語が完全一致しない類題も拾いやすくなります。類題探しが目的なら `scope: "problems"` を使うと、問題ブロック単位のヒットとprompt/tagsを含む詳しい抜粋が返るため、内容を読まなくても関連度をある程度判断できます。
2. ヒットした `fileId` に対して `get_document_outline` / `get_blocks` (必要なら `get_block`)を呼び、実際の内容を確認します。`read_local_document` は既定でsummaryを返しますが、対象確認にはさらに絞られた読み取りツールを優先します。
3. 参考にする内容を今の教材へ適用します(`insert_body_content` / `create_problem_content` / `update_rich_content` などの通常の書き込みツールを使います)。
4. 参照元の記録はアプリが自動で行います。`search_library` でヒットし **かつ実際に読んだ** 教材と、`get_mentioned_sigma_docs` のメンション教材が、書き込み時に自動で `sourceReferences` へ入ります(そのために読み取りツールにも `runId` を渡してください)。書き込みツールの `sourceReferences` 引数は補足用で、特定ブロックを参考にした場合に `blockId` を添えるといった用途に使います。自動記録分と同じ出典を指定しても1件に畳まれます。

`insert_body_content` / `create_problem_content` / `update_rich_content` / `update_problem_content` / `replace_block` / `insert_table` / `update_table` / `insert_graph` / `update_graph` / `insert_graph3d` / `update_graph3d` / `insert_material` は任意の `sourceReferences` 引数を受け取ります。配列で最大10件、次の種類を指定できます(自動記録分と合算した上で10件に切り詰められます)。

- `{ type: "document", fileId, title?, blockId?, note? }` - 参照した過去教材。`title` を省略すると、教材の現在のタイトルで自動的に補完されます。
- `{ type: "web", url, title? }` - 参照したWebページ。出典URLが分かる場合に指定します。
- `{ type: "webSearch", query }` - Web検索したがURLが得られない場合。Codexのweb検索イベントは検索語しか通知しないため、アプリがrun終了時にこの形で自動記録します(開けないURLを捏造しないための種別で、UIでもリンクにはなりません)。
- `{ type: "material", materialId, name? }` - 参照・挿入した保存済み素材。`insert_material` では `sourceReferences` を省略すると、挿入した素材自身がこの形で自動的に記録されます。

いずれも編集内容そのものには影響せず、デスクトップアプリの承認UIに「参照元」として表示されるだけです。壊れた/削除済みの `fileId` を渡しても書き込み自体は失敗せず、`title` の自動補完だけが行われません。

すべてのツールはこの共通形式をMCP `outputSchema`として公開します。正常応答は `{ "ok": true, "message": "...", "data": {...}, "nextAction"?: "..." }`、ツール実行エラーは `{ "ok": false, "error": { "code", "message", "retryable", "nextAction", "details"? } }` です。主なエラーcodeは `INVALID_INPUT` / `REVISION_MISMATCH` / `TARGET_REQUIRED` / `NOT_FOUND` / `INVALID_SESSION_STATE` / `PREVIEW_UNAVAILABLE` / `DOCUMENT_INVALID` / `PERMISSION_DENIED` / `TOOL_FAILED` です。inspection/reviewの品質不合格は通信・実行エラーではないため `ok:true` かつ `data.passed:false` で返ります。

書き込み系ツールの `data` は、教材全体やブロックごとの前後スナップショットを含む重い `draft` オブジェクトの代わりに、軽量な `changeSummary`(`operationSummaries` / `blockCount` / `revisionInfo.changedIds`)と `documentSummary`(`blockCount` / `revision` / `changedIds`)を返します。`data.proposal` も `nextDocument` と内部の `draft` を除いた要約です。教材全体が必要な場合は `read_local_document({detail:"full"})` を明示してください。

書き込み系ツールの成功時レスポンスには `data.verification` が付きます。`data.verification.validation` は変更後のSigmaDocを検証した結果(`ok` / `issues`(最大10件) / `issueCount`)です。`data.verification.preview` は可能であれば変更後の最初の対象ブロック周辺のページコンテキストPNGで、`source`(`"app-bridge"` / `"svg-fallback"` / `"none"`)、`warnings`、`previewFile`(取得できた場合の絶対PNGパス)を持ちます。PNGが取得できた場合、ChatGPT以外ではtool結果のimage contentとしても添付されます。ChatGPTでは`previewFile`を`view_image`で開いてください。render bridgeが使えない、または対象を特定できない場合は `source:"none"` になりますが、書き込み自体は失敗しません。既存内容や承認前の提案のブロック周辺は `render_block_context`、ページ全体と実際のページ割当は `render_page` を使ってください。

環境変数 `SIGMA_STUDIO_MCP_PROVIDER`(`claude` / `chatgpt` / `antigravity`)を設定すると、作成される提案にそのプロバイダが付記され、デスクトップ側の承認UIにも表示されます。未設定または不正な値の場合はプロバイダなし(`null`)として扱われます。

デスクトップ側で承認するとき、提案は現在の教材へ再適用されます。対象ブロック自体が削除・変更されて適用できない場合は失敗するため、その場合はMCP側でもう一度最新の `revision` と対象IDを読んで提案を作り直します。
