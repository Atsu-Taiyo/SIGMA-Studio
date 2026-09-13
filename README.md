# Sigma Studio

理系教材を作成するオープンソースのエディタです。本文、数式、図形、グラフを組み合わせ、教材を編集してPDFに出力できます。

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

不具合や機能提案は [Issues](https://github.com/Atsu-Taiyo/SIGMA-Studio/issues) へお願いします。
変更を提案する際は、再現手順と実行した検証を添えてください。

## ライセンス

[MIT License](LICENSE)。同梱する第三者コンポーネントのライセンスも適用されます。
