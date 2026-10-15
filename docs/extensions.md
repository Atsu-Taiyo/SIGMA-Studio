# 拡張機能 (Extensions)

拡張機能は、アプリへ機能を足すためにクラウドから取得する署名付きのパッケージです。アプリは取得・検証・実行の仕組み (**ホスト**) だけを持ち、拡張機能の名前も、メニューに並ぶ項目の文言も、対応するファイルの種類も、**署名付きカタログのデータ**として届きます。アプリのコードとインストーラーには、特定の拡張機能の名前を書きません。

## 所有と境界

| 場所 | 役割 |
| --- | --- |
| `electron/plugins/manifest.ts` | カタログの署名検証 (Ed25519) と形の検査。メニューの上限もここで固定する |
| `electron/plugins/manager.ts` | 取得・インストール・有効化・自動更新・権限の確認。版ごとにディスクへ残し、動いている処理は開始時の版に固定する |
| `electron/plugins/worker-runner.ts` | ワーカースレッドで1回だけ実行する。時間・メモリに上限があり、結果を受け取ったら止める |
| `electron/plugins/host.ts` | 保存先と本人のログインへつなぐ。書体の登録、項目の実行 (ファイル選択 → ワーカー → 結果の検証) |
| `electron/plugins/local-fonts.ts` | ワーカーが家族名で頼んだこのPCの書体だけを `queryLocalFonts` で読む |
| `electron/ipc/plugins.ts` | IPC の受け渡しと、信頼できるメインウィンドウへの通知 |
| `src/lib/extension-contracts.ts` | メニューの型と、描く前の検査 (`normalizeExtensionMenu`) |
| `src/components/editor/extensions/` | 拡張機能ダイアログ、メニューの購読 (`use-extension-menu.ts`) |

描画側 (renderer) が持つのは `window.sigmaPlugins` (状態・取得・有効化) と `window.sigmaExtensions` (メニューの内容・項目の実行) だけです。ホストが返す内容は描画側でも `normalizeExtensionMenu` を通し、形が正しいものだけを描きます。

## 信頼の根

1. **署名**: ビルドに埋め込んだ公開鍵 (`SIGMA_EXTENSIONS_PUBLIC_KEY`) で検証できるカタログだけを有効にする。署名のないものは何も有効にしない。カタログの `sequence` が巻き戻ったら拒否する。
2. **ファイルの完全性**: カタログに書かれたバイト数と SHA-256 が一致したファイルだけを置く。起動時と実行の直前にも、ディスク上の全ファイルを検証し直す。
3. **権限**: 本人のログインで決まる。クラウドが「この人はこの拡張機能を使える」と返したものだけが、状態・メニュー・実行・書体に現れる。権限が外れる、ログアウトする、別の人に代わると、その場で消える。動いている処理は終わるまで待ち、新しい処理は始めない。
4. **取得先の固定**: カタログの URL と同じオリジンだけに接続し、リダイレクトは拒否する。

ビルドの設定は `SIGMA_EXTENSIONS_CATALOG_URL` (`https://…/catalog`) と `SIGMA_EXTENSIONS_PUBLIC_KEY` (Ed25519 の公開鍵 PEM) です。どちらも公開してよい値で、秘密鍵は受け取りません。設定がないビルドでは、拡張機能の取得が「利用できません」になるだけで、ほかの機能は変わりません。開発・テストでは、配布版でないときだけ同名の環境変数で上書きできます。

## カタログのメニュー (`contributes.menu`)

拡張機能は、メニューバーの一番右の「拡張機能」に出す内容を、データで書きます。

```json
{
  "contributes": {
    "menu": {
      "sections": [{
        "title": "取り込み",
        "items": [
          { "type": "text", "text": "ファイルを選んで教材として取り込みます。" },
          { "type": "button", "id": "import-sample", "label": "サンプルを取り込む",
            "description": "対応するファイルを選びます", "icon": "file-input",
            "action": { "type": "import-file", "command": "convert", "extensions": [".smp"] } },
          { "type": "separator" }
        ]
      }]
    }
  }
}
```

- 項目は `button` / `text` / `separator`。`icon` はアプリが持つ固定の集合 (`EXTENSION_ICON_NAMES`) から選び、任意の画像は使えない。
- 上限: 見出し付きの区切り 8、項目 32、ボタンのラベル 80 文字、説明 200 文字、本文 300 文字、拡張子 8 個。制御文字は不可。
- `action` は主プロセスだけが知る。描画側へ渡すメニューには含まれず、描画側が送れるのは **拡張機能の id と項目の id だけ**。実行時の内容は検証済みのカタログから引き直す。
- 内容があるのは、インストール済み・有効・権限ありの拡張機能だけ。何も無ければ「拡張機能」メニュー自体を出さない。

## `import-file` の流れ

1. メニューの項目を押すと、描画側が `sigmaExtensions.run(拡張機能 id, 項目 id)` を呼ぶ。
2. ホストがファイル選択ダイアログ (OS) を出す。受け付けるのは、`action.extensions` に合う、64MB 以下の空でないファイルだけ。
3. 選ばれたファイルの中身と、`command`・ファイル名を、ワーカーへ渡す。**ワーカーが受け取るのは、選ばれたファイルだけ**で、ほかの教材・設定・ログイン情報には届かない。
4. ワーカーは `{ ok: true, result: { document, issues, localFontResources? } }` を返す。
   - `document` は `SigmaDocumentSchema` で検証し、`sigma.font-references` の数と中身が一致しないものは拒否する。
   - `issues` は `{ code, detail }` の配列 (最大 10,000 件)。`font-substitution` は代替した書体として、それ以外は「再現できていない点」として、取り込み後の通知に出る。
   - `localFontResources` は内容ハッシュを確かめてアプリのフォント置き場へ入れる (教材には Base64 で埋め込まない)。
5. 描画側が `recoverSigmaDocument` を通し、**別の教材として開く** (現在の教材は変更しない。保存の確認で止まれば取り込まない)。

ワーカーは、このPCの書体が要るときだけ `{ type: "local-font-request", families }` を投げ、`{ type: "local-font-response", fonts }` を受け取る。ホストは個数と文字列の形を検査し、拡張機能が自分で同梱している書体は読まない。

## 書体

拡張機能が同梱する書体は、内容ハッシュの資源として登録され、書体の選択に出る。配った拡張機能が有効で、権限があるあいだだけ見える。ユーザーが自分で追加した書体とは別で、「拡張機能」ダイアログの追加フォントには出ない。

## テスト

- `electron/plugins/*.test.ts`: 署名・改ざん・巻き戻り・不正な経路、権限の取り消しと本人の切り替え、更新と実行中の処理の競合、メニューと action の解決、項目の実行と結果の検証、実ワーカースレッドでの結合。
- `src/lib/extension-contracts.test.ts`、`use-extension-menu.test.tsx`: 描く前の検査と購読。
- `tests/electron/extensions-menu.spec.ts`: 実アプリで、メニューの位置・内容・取り込み・保存と再読み込み・権限が外れたときの消去。
- `scripts/extension-build-config.test.mjs`: ビルド設定 (秘密鍵や安全でない URL の拒否)。
