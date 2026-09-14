# 教材ファイルを開く

Sigma Studioから書き出す教材は `.sigma` ファイルです。中身は従来と同じSigmaDoc JSONです。
この関連付けに対応した版をインストールすると、`.sigma` をダブルクリックしてSigma Studioで開けます。
別のアプリが開く場合は、OSの「このアプリケーションで開く」「プログラムから開く」でSigma Studioを選んでください。
既定アプリの選択はOSの設定に従います。

以前の `.sigma.json`、`.sigmadoc.json`、`.json` 教材も、アプリの「開く」から読み込めます。
新しいファイルとして書き出すと `.sigma` になります。旧ファイルをOSから直接開きたい場合は、
コピーを作ってファイル名の末尾全体を `.sigma` に変更する方法もあります。JSONの中身を変える必要はありません。
旧形式の `.sigma.json` / `.sigmadoc.json` は、Sigma Studioを明示指定したOSの「開く」やコマンドラインから渡された場合も受け付けます。

開いたファイルはライブラリの**新しい教材として取り込まれます**。編集中の教材は切替前に保存します。
保存できなければ切り替えません。元のダウンロードファイルは変更されず、編集はアプリ内の教材へ保存されます。
編集した内容をファイルで渡す場合は、改めて書き出してください。

## 拡張子とOS連携の設計

`.sigma.json` の末尾は `.json` なので、全OSで独立した関連付けとして扱えるとは限りません。
Appleの [`pathExtension`](https://developer.apple.com/documentation/foundation/nsstring/pathextension) は最後のピリオド以降を拡張子と定義しています。
Microsoftの [`Path.GetExtension`](https://learn.microsoft.com/en-us/dotnet/api/system.io.path.getextension) も末尾からピリオドを探し、
[Windowsのファイル種別](https://learn.microsoft.com/en-us/windows/win32/shell/fa-file-types) は拡張子とProgIDで登録します。
このため移植可能な関連付けは単一の `.sigma` とし、一般JSONの関連付けを登録しません。
Linuxの[Shared MIME-info](https://specifications.freedesktop.org/shared-mime-info/latest-single/) は複合拡張子のglobにも対応しますが、
配布形式はOS間で統一します。独自MIMEは `application/x-sigma-studio` です。

[Electronの仕様](https://www.electronjs.org/docs/latest/api/app#event-open-file-macos)に従って、macOSの `open-file` は `ready` 前から購読します。
Windows/Linuxの初回起動はargv、追加起動は `second-instance` で受け取ります。追加起動の作業ディレクトリで解決した
パスを `requestSingleInstanceLock` のデータに入れ、Chromiumによる引数の変更にも影響されないようにします。
二番目のプロセスは保存ストアやAIセッションの初期化前に終了します。

mainはOSから受け取ったパスだけを保持し、rendererはライブラリの準備完了後に順番に取り込みます。
購読前のイベント、準備中の複数指定、workspace画面からの復帰に対応し、受領の確認まではキューを保持します。
読み込みとスキーマ検査の失敗は既存の画面内ステータスで表示します。
内部の `data/documents/*.sigmadoc.json`、ライブラリID、SigmaDocスキーマ、既存教材のファイル名は移行しません。

## 配布時の確認

[`fileAssociations`](https://www.electron.build/docs/api/electron-builder.interface.fileassociation/) は `.sigma` のみを宣言します。
macOSのInfo.plist、Windows NSIS/AppX、LinuxのMIME/desktop entryの生成に使います。
開発用Electronの起動だけでは、OSへのインストールや関連付けの動作は確認できません。
現在の標準配布対象はmacOS/Windowsで、Linux配布物は未提供です。

配布前には各対象OSで、未起動時と起動中のダブルクリック、複数選択、日本語・空白を含むパス、
編集→別ファイルを開く→保存再読込、アンインストールを確認してください。
Windowsではユーザー単位/全ユーザーのインストールとAppXも別々に確認します。
一般 `.json` の既定アプリが変わっていないことも確認します。
ローカル検証のためにインストーラを公開したり、OSの既定アプリを強制変更したりしないでください。
