import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// ひらがな / カタカナ / CJK 統合漢字。コード中に直書きされた日本語を拾う。
const JAPANESE_CHARACTER = "[\\u3040-\\u309f\\u30a0-\\u30ff\\u4e00-\\u9fff]";
const UNTRANSLATED_JAPANESE_MESSAGE =
  "未翻訳の日本語リテラル。@/lib/i18n の t() 経由にするか、翻訳対象外なら対象パスから外す";

const noUntranslatedJapaneseLiteral = [
  "error",
  { selector: `Literal[value=/${JAPANESE_CHARACTER}/]`, message: UNTRANSLATED_JAPANESE_MESSAGE },
  { selector: `TemplateElement[value.raw=/${JAPANESE_CHARACTER}/]`, message: UNTRANSLATED_JAPANESE_MESSAGE },
  { selector: `JSXText[value=/${JAPANESE_CHARACTER}/]`, message: UNTRANSLATED_JAPANESE_MESSAGE },
];

const eslintConfig = [
  ...nextVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      ".next-electron/**",
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "dist-electron/**",
      "dist-mcp/**",
      "release/**",
      "build/**",
      // 計測用ビルドの退避先とレポート出力先 (どちらもビルド成果物 / 生成物)。
      "perf-out/**",
      "perf-reports/**",
    ],
  },
  {
    // OSネイティブダイアログ禁止 (docs/design-rules.md > Controls > Dialogs)。
    // 確認・入力・通知はアプリ内ダイアログコンポーネントで表示する。
    // OSファイルピッカー (dialog.showOpenDialog / showSaveDialog) だけが例外。
    rules: {
      "no-alert": "error",
      "no-restricted-syntax": [
        "error",
        {
          // OSが描くドロップダウン禁止 (docs/design-rules.md > Controls > Selects And Pickers)。
          selector: 'JSXOpeningElement[name.name="select"]',
          message: "ネイティブの <select> は使わない。@/components/ui/Select へ (docs/design-rules.md > Selects And Pickers)",
        },
        {
          selector: 'JSXOpeningElement:has(JSXAttribute[name.name="type"][value.value="color"])',
          message: "OSのカラーパネルは使わない。ColorPalette / 色作成ダイアログへ (docs/design-rules.md > Selects And Pickers)",
        },
        {
          selector: 'JSXOpeningElement:has(JSXAttribute[name.name="type"][value.value=/^(date|time|datetime-local|month|week)$/])',
          message: "OSの日付ピッカーは使わない。アプリ内UIで選ばせる (docs/design-rules.md > Selects And Pickers)",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "dialog",
          property: "showMessageBox",
          message: "OSダイアログは使わない。アプリ内ダイアログUIへ (docs/design-rules.md > Dialogs)",
        },
        {
          object: "dialog",
          property: "showErrorBox",
          message: "OSダイアログは使わない。アプリ内ダイアログUIへ (docs/design-rules.md > Dialogs)",
        },
      ],
    },
  },
  {
    // 未翻訳の日本語検出。編集時の即時フィードバック用に renderer / Electron の
    // ランタイム全体へ適用する。文脈を判定できる網羅的なゲートは Vitest 側。
    files: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "electron/**/*.ts",
      "electron/**/*.tsx",
    ],
    ignores: [
      // 辞書そのものは翻訳データ。英語辞書にも言語名の endonym (「日本語」) が入る。
      "src/lib/i18n/dictionaries/**",
      // テストは期待値として ja / en 双方の文言を直接書く。
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      // 教材文法・外部形式の照合トークンと、日本語を含む安定サンプル。
      "src/lib/heading-numbering.ts",
      "src/lib/tex-command-reference.ts",
      "src/lib/tex-environment-examples.ts",
      "src/lib/tex-import.ts",
      "src/lib/inline-math-symbol-buttons.ts",
      // OSフォント名、永続化互換値、教材内容・二言語検索語。
      "src/components/editor/editor-shell/constants.ts",
      "src/components/editor/editor-shell/material-metadata-draft.ts",
      "src/components/editor/materials/MaterialEditSurface.tsx",
      "src/components/editor/page-canvas/popover-anchors.ts",
      "src/lib/document-title.ts",
      "src/app/layout.tsx",
      // AI/MCP向けプロンプト・ツール契約・照合語彙。ユーザー可視UIは含めない。
      "src/lib/ai/mcp-tool-categories.ts",
      "src/lib/ai/sigma-doc-agent-tools.ts",
      "src/lib/ai/comment-mention.ts",
      "src/lib/ai/ai-rejection-prompt.ts",
      "src/lib/ai/applied-document-diff.ts",
      "src/lib/ai/ai-edit-attachment-names.ts",
      "src/lib/ai/ai-edit-reference.ts",
      "src/lib/ai/sigma-doc-edit-schema.ts",
      "electron/ai-skill-draft.ts",
      "electron/ai-edit.ts",
      // ひな形が教材へ書き込む図形名・共通部分名。作者がその場で書き換える教材の中身。
      "src/features/drawing/graph3d-presets.ts",
      // 教材へ挿入する記号、未使用の互換ラベル、開発者向け不変条件、モデルへの検証文。
      "src/components/editor/TextFlowEditor.tsx",
      "src/features/document/application/line-height.ts",
      "src/features/editor-state/react.tsx",
      "src/lib/document-tree.ts",
      // 別プロセス間の機械契約と開発者向け運用ログ。Vitest側では値単位で監査する。
      "electron/ai-edit-run-context.ts",
      "electron/ai-render-bridge.ts",
      "electron/main.ts",
      "electron/ipc/ai-edit.ts",
      // 保存される日本語既定名と提案summary、索引ログ、開発時invariantを含む。
      // Vitest側の INTENTIONAL_RUNTIME_JAPANESE がパス+値の組み合わせで限定監査する。
      "electron/local-sigma-doc-proposal-store.ts",
      "electron/local-sigma-doc-store.ts",
      "electron/local-library-record.ts",
      "electron/local-document-reconciler.ts",
    ],
    rules: {
      "no-restricted-syntax": noUntranslatedJapaneseLiteral,
    },
  },
];

export default eslintConfig;
