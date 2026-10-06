import { useEffect, useMemo, useState } from "react";
import {
  SigmaDocEditor,
  SigmaDocViewer,
  parseSigmaDocument,
  type SigmaDocViewerError,
  type SigmaDocViewerPart,
  type SigmaDocument,
} from "@sigma-studio/editor";

import { createSampleDocument } from "./sample-document";

const STORAGE_KEY = "sigma-sdk-answer-share-document-v2";
const PARTS: Array<{ value: SigmaDocViewerPart; label: string }> = [
  { value: "problem", label: "問題" },
  { value: "solution", label: "解答" },
  { value: "comments", label: "コメント" },
];
const PRESETS: Array<{
  label: string;
  parts?: readonly SigmaDocViewerPart[];
  hideProblemNumbers: boolean;
  maxHeightPx?: number;
}> = [
  { label: "完全版", hideProblemNumbers: false },
  {
    label: "問題だけ",
    parts: ["problem"],
    hideProblemNumbers: false,
    maxHeightPx: 620,
  },
  {
    label: "解答だけ",
    parts: ["solution"],
    hideProblemNumbers: true,
    maxHeightPx: 620,
  },
  {
    label: "問題＋解答",
    parts: ["problem", "solution"],
    hideProblemNumbers: false,
    maxHeightPx: 760,
  },
  {
    label: "コメントだけ",
    parts: ["comments"],
    hideProblemNumbers: true,
    maxHeightPx: 360,
  },
  {
    label: "高さ240px",
    parts: ["problem", "solution", "comments"],
    hideProblemNumbers: false,
    maxHeightPx: 240,
  },
];

export function App() {
  const [route, setRoute] = useHashRoute();
  const [document, setDocument] = useState<SigmaDocument>(() => loadDocument());
  const [parts, setParts] = useState<readonly SigmaDocViewerPart[] | undefined>(
    ["problem", "solution"],
  );
  const [hideProblemNumbers, setHideProblemNumbers] = useState(false);
  const [maxHeightPx, setMaxHeightPx] = useState<number | undefined>(760);
  const [viewerError, setViewerError] = useState<SigmaDocViewerError | null>(
    null,
  );

  const go = (nextRoute: "share" | "editor") => {
    window.location.hash =
      nextRoute === "editor"
        ? "#/editor/calculus-proof"
        : "#/answers/calculus-proof";
    setRoute(nextRoute);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (route === "editor") {
    return (
      <EditorPage
        document={document}
        onChange={(next) => {
          setDocument(next);
        }}
        onSave={async (next) => {
          // ホストは document を onChange 経由で既に所有している。ここで
          // setDocument(next) すると、保存に要した遅延の間にユーザーが入力を
          // 続けていた場合、古いスナップショットで最新の入力を上書きしてしまい、
          // それがまた dirty 化→自動保存→再度この onSave…と自走ループになる。
          // onSave は永続化専用。
          await new Promise((resolve) => window.setTimeout(resolve, 320));
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        }}
      />
    );
  }

  const snippet = viewerSnippet(parts, hideProblemNumbers, maxHeightPx);

  return (
    <div className="answer-site">
      <SiteHeader onEdit={() => go("editor")} />

      <main className="answer-main">
        <nav className="breadcrumbs" aria-label="パンくず">
          <a href="#/answers">解答一覧</a>
          <span>/</span>
          <a href="#/tags/calculus">微積分</a>
          <span>/</span>
          <strong>面積関数と漸化式</strong>
        </nav>

        <article className="answer-article">
          <header className="answer-hero">
            <div className="answer-vote" aria-label="評価">
              <button type="button" aria-label="役に立った">
                △
              </button>
              <strong>128</strong>
              <span>保存 34</span>
            </div>
            <div className="answer-hero__body">
              <div className="tag-row">
                <span>高校数学</span>
                <span>微積分</span>
                <span>数列</span>
                <span>証明</span>
              </div>
              <h1>面積関数から始める積分の証明と、漸化式の見抜き方</h1>
              <p className="answer-lead">
                問題文を読むところから検算までを、一つのSigmaDocとして共有した解答です。
                途中式を飛ばさず、なぜその置換を選ぶのか、別解がどこで同じ構造に合流するのかまで記録しました。
              </p>
              <div className="author-line">
                <span className="author-avatar" aria-hidden="true">
                  佐
                </span>
                <div>
                  <strong>佐伯 直人</strong>
                  <span>数学科教員・2026年7月25日更新・読了約18分</span>
                </div>
                <button type="button">フォロー</button>
              </div>
            </div>
          </header>

          <div className="answer-layout">
            <section className="answer-content" id="answer-content">
              <div className="prose-intro">
                <p>
                  この解答では、計算結果だけではなく「どの量を関数として置くか」を中心に説明します。
                  まず図形的な意味を保ったまま積分へ移り、最後に微分して元の条件へ戻ることで、式変形の妥当性を確認します。
                </p>
                <aside>
                  <strong>このページで試せること</strong>
                  <span>
                    Viewerの表示範囲・問題番号・高さ制限を変更し、同じSigmaDocが用途別にどう見えるか比較できます。
                  </span>
                </aside>
              </div>

              {viewerError ? (
                <p className="viewer-error" role="alert">
                  {viewerError.message}
                </p>
              ) : null}

              <section
                className="embed-card"
                aria-labelledby="material-heading"
              >
                <header className="embed-card__header">
                  <div>
                    <span>EMBEDDED SIGMADOC</span>
                    <h2 id="material-heading">{document.metadata.title}</h2>
                  </div>
                  <button type="button" onClick={() => go("editor")}>
                    この教材を編集
                  </button>
                </header>
                <div className="viewer-stage">
                  <SigmaDocViewer
                    document={document}
                    visibleParts={parts}
                    hideProblemNumbers={hideProblemNumbers}
                    maxHeightPx={maxHeightPx}
                    onError={setViewerError}
                  />
                </div>
                <footer className="embed-card__footer">
                  <span>正本: SigmaDoc v{document.version}</span>
                  <span>{document.content.length} blocks</span>
                  <span>docId: {document.docId}</span>
                </footer>
              </section>

              <section className="implementation-note">
                <span className="section-kicker">組み込みコード</span>
                <h2>今表示しているパラメータ</h2>
                <p>
                  操作パネルの変更が、そのまま下のReact
                  propsへ反映されています。元のSigmaDocオブジェクトは変更されません。
                </p>
                <pre>
                  <code>{snippet}</code>
                </pre>
              </section>

              <section className="discussion">
                <div>
                  <span className="section-kicker">解答へのコメント</span>
                  <h2>議論と補足</h2>
                </div>
                <article>
                  <span className="comment-avatar">美</span>
                  <div>
                    <strong>美濃部</strong>
                    <p>
                      第2問の帰納法で、仮定を使う場所が解答内に明示されているので追いやすかったです。偶奇で分ける別解も見てみたいです。
                    </p>
                    <span>12分前・役に立った 6</span>
                  </div>
                </article>
                <article>
                  <span className="comment-avatar">佐</span>
                  <div>
                    <strong>
                      佐伯 直人 <small>投稿者</small>
                    </strong>
                    <p>
                      ありがとうございます。SigmaDoc内の「コメント」領域に、偶奇性だけを先に確認する補足を追加しました。
                    </p>
                    <span>5分前</span>
                  </div>
                </article>
              </section>
            </section>

            <aside
              className="parameter-panel"
              aria-label="SigmaDoc表示パラメータ"
            >
              <div className="parameter-panel__sticky">
                <span className="section-kicker">表示を試す</span>
                <h2>埋め込み設定</h2>
                <p>
                  同じ教材を問題ページ、解答ページ、コメント欄などへ出し分けます。
                </p>

                <div className="preset-grid">
                  {PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.label}
                      onClick={() => {
                        setParts(preset.parts);
                        setHideProblemNumbers(preset.hideProblemNumbers);
                        setMaxHeightPx(preset.maxHeightPx);
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <fieldset>
                  <legend>visibleParts</legend>
                  {PARTS.map((part) => (
                    <label key={part.value}>
                      <input
                        type="checkbox"
                        checked={parts?.includes(part.value) ?? false}
                        onChange={() => {
                          const current = new Set(parts ?? []);
                          if (current.has(part.value))
                            current.delete(part.value);
                          else current.add(part.value);
                          setParts([...current]);
                        }}
                      />
                      <span>{part.label}</span>
                    </label>
                  ))}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setParts(undefined)}
                  >
                    未指定（完全版）
                  </button>
                </fieldset>

                <label className="switch-row">
                  <span>
                    <strong>問題番号を隠す</strong>
                    <small>hideProblemNumbers</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={hideProblemNumbers}
                    onChange={(event) =>
                      setHideProblemNumbers(event.currentTarget.checked)
                    }
                  />
                </label>

                <label className="range-field">
                  <span>
                    <strong>表示高さ</strong>
                    <code>
                      {maxHeightPx === undefined
                        ? "制限なし"
                        : `${maxHeightPx}px`}
                    </code>
                  </span>
                  <input
                    type="range"
                    min={200}
                    max={1200}
                    step={40}
                    value={maxHeightPx ?? 1200}
                    onChange={(event) =>
                      setMaxHeightPx(Number(event.currentTarget.value))
                    }
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setMaxHeightPx(undefined)}
                  >
                    高さ制限を解除
                  </button>
                </label>

                <dl className="parameter-output">
                  <div>
                    <dt>visibleParts</dt>
                    <dd>{parts ? parts.join(", ") || "[]" : "undefined"}</dd>
                  </div>
                  <div>
                    <dt>hideProblemNumbers</dt>
                    <dd>{String(hideProblemNumbers)}</dd>
                  </div>
                  <div>
                    <dt>maxHeightPx</dt>
                    <dd>{maxHeightPx ?? "undefined"}</dd>
                  </div>
                </dl>
              </div>
            </aside>
          </div>
        </article>
      </main>

      <footer className="site-footer">
        <strong>数理ノート</strong>
        <span>@sigma-studio/editor 実装例</span>
      </footer>
    </div>
  );
}

function EditorPage({
  document,
  onChange,
  onSave,
}: {
  document: SigmaDocument;
  onChange: (document: SigmaDocument) => void;
  onSave: (document: SigmaDocument) => Promise<void>;
}) {
  return (
    <SigmaDocEditor
      className="editor-page"
      document={document}
      onChange={onChange}
      onSave={onSave}
    />
  );
}

function SiteHeader({ onEdit }: { onEdit: () => void }) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="site-brand" href="#/answers">
          <span className="site-brand__mark">Σ</span>
          <span>数理ノート</span>
        </a>
        <nav className="site-nav" aria-label="メインナビゲーション">
          <a href="#/questions">問題を探す</a>
          <a href="#/answers" aria-current="page">
            みんなの解答
          </a>
          <a href="#/collections">教材集</a>
        </nav>
        <label className="site-search">
          <span aria-hidden="true">⌕</span>
          <input aria-label="問題や解答を検索" placeholder="問題や解答を検索" />
        </label>
        <button type="button" className="header-edit-button" onClick={onEdit}>
          教材を編集
        </button>
        <span className="user-avatar" aria-label="ユーザーメニュー">
          A
        </span>
      </div>
    </header>
  );
}

function viewerSnippet(
  parts: readonly SigmaDocViewerPart[] | undefined,
  hideProblemNumbers: boolean,
  maxHeightPx: number | undefined,
) {
  const lines = [
    "<SigmaDocViewer",
    "  document={sigmaDoc}",
    parts
      ? `  visibleParts={${JSON.stringify(parts)}}`
      : "  // visibleParts未指定 = 完全版",
    hideProblemNumbers
      ? "  hideProblemNumbers"
      : "  hideProblemNumbers={false}",
    maxHeightPx
      ? `  maxHeightPx={${maxHeightPx}}`
      : "  // maxHeightPx未指定 = 高さ制限なし",
    "/>",
  ];
  return lines.join("\n");
}

function loadDocument(): SigmaDocument {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return parseSigmaDocument(JSON.parse(stored));
  } catch {
    // The example remains usable when storage is unavailable or stale.
  }
  return createSampleDocument();
}

function useHashRoute() {
  const resolveRoute = () =>
    window.location.hash.startsWith("#/editor")
      ? ("editor" as const)
      : ("share" as const);
  const [route, setRoute] = useState<"share" | "editor">(resolveRoute);
  useEffect(() => {
    const onHashChange = () => setRoute(resolveRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return [route, setRoute] as const;
}
