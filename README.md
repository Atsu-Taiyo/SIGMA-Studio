# Sigma Studio

理系教材を作成するオープンソースのエディタです。本文、数式、図形、グラフを組み合わせ、教材を編集してPDFに出力できます。

![本文・数式・図形を組み合わせたSigma Studioの編集画面](docs/images/editor-canvas.png)

[公式サイト・デモ](https://chocoschools.com/sigma-studio/) · [不具合報告・機能リクエスト](https://github.com/Atsu-Taiyo/SIGMA-Studio/issues/new/choose)

## ダウンロード

macOS / Windows向けのアプリは [GitHub Releases](https://github.com/Atsu-Taiyo/SIGMA-Studio/releases/latest) からダウンロードできます。

## 主な機能

- 数式を含む本文編集、図形・グラフ・表・画像の配置
- ページ形式の教材とホワイトボード
- SigmaDoc JSONによる保存、JSON・TeX・PowerPointのインポート
- 教材のPDF出力
- AIによる編集提案とローカルMCP連携
- Reactアプリに組み込めるEditor・Viewer

文書の正本はSigmaDoc JSONです。AI接続は利用するプロバイダの設定が必要です。

## 開発

Node.js 24とnpmを使います。リポジトリのルートで実行してください。

```sh
npm ci
npm run dev
```

Electronアプリの開発起動は `npm run electron:dev` です。
詳しい検証手順は [CONTRIBUTING.md](CONTRIBUTING.md)、構成は [アーキテクチャ](docs/architecture.md) を参照してください。

## Reactパッケージ

- [Editor](packages/editor/README.md): 編集用コンポーネント
- [Viewer](packages/viewer/README.md): 表示用コンポーネント
- [組み込みガイド](docs/embedding-guide.md)

## 問い合わせ・貢献

不具合や機能提案は、[Issue作成画面](https://github.com/Atsu-Taiyo/SIGMA-Studio/issues/new/choose) で「不具合報告」または「機能リクエスト」を選び、フォームに記入して送信してください。GitHubアカウントが必要です。
投稿内容と添付ファイルは公開されます。教材や画像を添付する際は、生徒名などの個人情報を取り除いてください。

変更を提案する際は、再現手順と実行した検証を添えてください。

## ライセンス

[MIT License](LICENSE)。同梱する第三者コンポーネントのライセンスも適用されます。

## 支援

Sigma Studioは、[SSS Education](https://sss-education.jp/) の支援を受けて開発しています。
開発を支えていただき、ありがとうございます。

<a href="https://sss-education.jp/">
  <img src="docs/images/sss-education.png" alt="SSS Education" width="300" />
</a>

Sigma Studioが役に立ったら、[GitHubでStar](https://github.com/Atsu-Taiyo/SIGMA-Studio)を付けていただけると、開発を続ける励みになります。
