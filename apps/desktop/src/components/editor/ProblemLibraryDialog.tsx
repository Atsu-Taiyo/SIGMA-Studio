"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BookOpen, CircleAlert, CircleCheck, CircleHelp, ExternalLink, FilePlus, Minus, RotateCw, Search, SearchX, Tag, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { Grid, Inline, Inset, Stack } from "@/components/ui/layout";
import { Select } from "@/components/ui/Select";
import { Shimmer } from "@/components/ui/Shimmer";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { MathEnvironmentProvider } from "@/features/rendering/adapters/react";
import { PrintBlock } from "@/components/print/print-static-blocks";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import { PROBLEM_LIBRARY_CATEGORIES, ProblemLibraryImportError, prepareLibraryProblemImport, problemSourceUrl, problemToSigmaDocument, readLibraryProblems, type LibraryProblem, type ProblemLibraryQuery } from "@/lib/problem-library";
import styles from "./ProblemLibraryDialog.module.css";

interface Props {
  onImport(file: File): Promise<boolean>;
  onClose(): void;
}

type RequestMode = "recommended" | "results";
// A load failure replaces the list; an import failure keeps the cards so the user can simply try again.
interface LibraryError { kind: "load" | "import"; message: string }

const RECOMMENDED_LIMIT = 6;
const RECOMMENDED_QUERY: ProblemLibraryQuery = { sort: "likes", limit: RECOMMENDED_LIMIT };

/**
 * The provider a problem comes from. Only 受験数学研究所 is connected today and `problems.search`
 * takes no provider argument, so every result belongs to this one. A second provider needs a
 * bridge parameter, an entry in the dictionary's `sources`, and a source filter in the toolbar.
 * Do not confuse it with `LibraryProblem.source_name`, which is the problem's own origin.
 */
const PROBLEM_SOURCE = { id: "jukenmath", originalUrl: problemSourceUrl } as const;

export function ProblemLibraryDialog({ onImport, onClose }: Props) {
  const t = useT("editor");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [problems, setProblems] = useState<LibraryProblem[]>([]);
  const [request, setRequest] = useState<{ query: ProblemLibraryQuery; mode: RequestMode }>({ query: RECOMMENDED_QUERY, mode: "recommended" });
  const { mode } = request;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LibraryError | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const importingRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const load = (query: ProblemLibraryQuery, mode: RequestMode) => {
    setLoading(true);
    setError(null);
    setProblems([]);
    setRequest({ query, mode });
  };
  useEffect(() => {
    let active = true;
    const search = async () => {
      const bridge = getDesktopBridge()?.problems;
      if (!bridge) return { ok: false as const, error: t("problemLibrary.unavailable") };
      return bridge.search(request.query);
    };
    void search().then(result => {
      if (!active) return;
      if (!result.ok) { setError({ kind: "load", message: result.error }); return; }
      setProblems(readLibraryProblems(result.search));
    }).catch(() => {
      if (active) setError({ kind: "load", message: t("problemLibrary.loadFailed") });
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request, t]);

  // No keyword and no category is the recommendation view; anything else is a search.
  const run = (keyword: string, categoryValue: string) => {
    const q = keyword.trim() || undefined;
    const selected = categoryValue || undefined;
    if (!q && !selected) load(RECOMMENDED_QUERY, "recommended");
    else load({ q, category: selected, sort: "likes", limit: 20 }, "results");
  };
  const showRecommended = () => {
    setQuery("");
    setCategory("");
    load(RECOMMENDED_QUERY, "recommended");
  };

  const dismiss = () => { if (!importingRef.current) onClose(); };
  const importProblem = async (problem: LibraryProblem) => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(problem.id);
    setError(null);
    try {
      // Fetches and verifies the solution when the problem has one; it throws instead of importing the body alone.
      const document = await prepareLibraryProblemImport(problem, getDesktopBridge()?.problems);
      const file = new File([JSON.stringify(document)], `${problem.title}.sigma`, { type: "application/json" });
      if (await onImport(file)) onClose();
      else setError({ kind: "import", message: t("problemLibrary.importFailed") });
    } catch (caught) {
      // Only the helper's own errors carry a translated, safe message; anything else stays generic.
      setError({ kind: "import", message: caught instanceof ProblemLibraryImportError ? caught.message : t("problemLibrary.importFailed") });
    } finally {
      importingRef.current = false;
      setImporting(null);
    }
  };

  const showResultCount = mode === "results" && !loading && !error;
  return (
    <ModalFrame open onDismiss={dismiss} size="xl" ariaLabel={t("problemLibrary.title")}>
      <ModalHeader title={<span className={styles.title}><BookOpen size={18} aria-hidden="true" /><span>{t("problemLibrary.title")}</span></span>} onClose={dismiss} />
      <ModalBody className={styles.body} padding="none" scroll="hidden">
        <form className={styles.toolbar} role="search" onSubmit={event => {
          event.preventDefault();
          run(query, category);
        }}>
          <Inline gap="sm" wrap>
            <div className={styles.search}>
              <Search size={16} aria-hidden="true" />
              <input ref={searchInputRef} data-modal-initial-focus value={query} onChange={event => setQuery(event.target.value)} maxLength={500}
                placeholder={t("problemLibrary.placeholder")} aria-label={t("problemLibrary.keyword")} enterKeyHint="search" disabled={!!importing} />
              {query && <IconButton label={t("problemLibrary.clear")} tone="ghost" size="sm" disabled={!!importing} onClick={() => {
                setQuery("");
                searchInputRef.current?.focus();
              }}><X size={15} aria-hidden="true" /></IconButton>}
            </div>
            {/* The shared Select keeps the keyboard and ARIA behaviour; the icon is a sibling because the trigger only renders its label. */}
            <div className={styles.tagFilter} data-active={category !== "" || undefined}>
              <Tag className={styles.tagIcon} size={14} aria-hidden="true" />
              <Select className={styles.tagTrigger} aria-label={t("problemLibrary.category")} value={category} disabled={!!importing}
                onChange={value => { setCategory(value); run(query, value); }}
                options={[
                  { value: "", label: t("problemLibrary.all"), content: <span className={styles.tagOptionAll}>{t("problemLibrary.all")}</span> },
                  ...PROBLEM_LIBRARY_CATEGORIES.map(({ value, key }) => {
                    const label = t(`problemLibrary.categories.${key}`);
                    return { value, label, content: <span className={styles.tagOption}><Tag size={12} aria-hidden="true" />{label}</span> };
                  }),
                ]} />
            </div>
          </Inline>
        </form>
        <Inset className={styles.results} space="xl">
          <Stack gap="lg">
            <Inline className={styles.heading} gap="md" justify="between">
              <Inline gap="sm" align="baseline">
                <h3>{t(`problemLibrary.${mode}`)}</h3>
                {showResultCount && <span className={styles.count}>{t("problemLibrary.resultCount", { total: problems.length })}</span>}
              </Inline>
              {mode === "results" && <Button tone="ghost" size="sm" disabled={loading || !!importing} onClick={showRecommended}>{t("problemLibrary.recommend")}</Button>}
            </Inline>
            {error?.kind === "import" && <Inset className={styles.notice} space="md" role="alert">
              <Inline gap="sm" align="start"><CircleAlert size={16} aria-hidden="true" /><span>{error.message}</span></Inline>
            </Inset>}
            {loading && <span className="visually-hidden" role="status">{t("problemLibrary.loading")}</span>}
            {loading ? (
              <Grid className={styles.grid} columns={3} gap="md" responsive={false} aria-hidden="true">
                {Array.from({ length: RECOMMENDED_LIMIT }, (_, index) => <ProblemCardSkeleton key={index} />)}
              </Grid>
            ) : error?.kind === "load" ? (
              <Stack className={styles.state} gap="md" align="center" justify="center">
                <CircleAlert size={24} aria-hidden="true" />
                <span className={styles.stateMessage} role="alert">{error.message}</span>
                <Button size="sm" onClick={() => load(request.query, mode)}><RotateCw size={14} aria-hidden="true" />{t("problemLibrary.retry")}</Button>
              </Stack>
            ) : problems.length === 0 ? (
              <Stack className={styles.state} gap="md" align="center" justify="center">
                <SearchX size={24} aria-hidden="true" />
                <strong role="status">{t("problemLibrary.empty")}</strong>
                <Button size="sm" disabled={!!importing} onClick={showRecommended}>{t("problemLibrary.recommend")}</Button>
              </Stack>
            ) : (
              <MathEnvironmentProvider>
                <Grid className={styles.grid} columns={3} gap="md" responsive={false}>
                  {problems.map(problem => <ProblemCard key={problem.id} problem={problem} busy={importing !== null}
                    importing={importing === problem.id} onImport={() => void importProblem(problem)} />)}
                </Grid>
              </MathEnvironmentProvider>
            )}
          </Stack>
        </Inset>
      </ModalBody>
    </ModalFrame>
  );
}

function ProblemCard({ problem, busy, importing, onImport }: { problem: LibraryProblem; busy: boolean; importing: boolean; onImport(): void }) {
  const t = useT("editor");
  const titleId = useId();
  const preview = useMemo(() => {
    try {
      const block = problemToSigmaDocument(problem).content[0];
      return block.type === "problem" ? block.prompt : null;
    } catch { return null; }
  }, [problem]);
  // The API sends Japanese category identifiers; show the localized name when we know it.
  const knownCategory = PROBLEM_LIBRARY_CATEGORIES.find(({ value }) => value === problem.category);
  const categoryLabel = knownCategory ? t(`problemLibrary.categories.${knownCategory.key}`) : problem.category;
  const sourceName = t(`problemLibrary.sources.${PROBLEM_SOURCE.id}`);
  const originalUrl = PROBLEM_SOURCE.originalUrl(problem);
  const importLabel = t(importing ? "problemLibrary.importing" : "problemLibrary.import");
  return <article className={styles.card} data-importing={importing || undefined} aria-labelledby={titleId}>
    <Inset space="lg">
      <Stack gap="md">
        <Stack gap="xs">
          <Inline className={styles.meta} gap="sm" wrap>
            {categoryLabel && <span className={styles.categoryTag}>{categoryLabel}</span>}
            <SolutionStatus hasSolution={problem.has_solution} />
          </Inline>
          <h4 id={titleId} className={styles.cardTitle}>{problem.title}</h4>
          {/* The problem's own origin (e.g. an exam), not the provider named in the footer. */}
          {problem.source_name && <p className={styles.origin}>{problem.source_name}</p>}
        </Stack>
        <div className={styles.preview}>{preview ? preview.map(block => <PrintBlock key={block.id} unit={{ type: "block", id: block.id, block }} columnGapMm={8} />) : <p className={styles.previewFailed}>{t("problemLibrary.conversionFailed")}</p>}</div>
        <Inline gap="sm" justify="between">
          <a className={styles.sourceLink} href={originalUrl} onClick={event => {
            event.preventDefault();
            void getDesktopBridge()?.shell.openExternal(originalUrl);
          }} title={t("problemLibrary.openOriginal")} aria-label={`${sourceName}：${t("problemLibrary.openOriginal")}（${problem.title}）`}>
            <span>{sourceName}</span><ExternalLink size={13} aria-hidden="true" />
          </a>
          <Button size="sm" disabled={busy || !preview} onClick={onImport} aria-label={`${importLabel}：${problem.title}`}
            title={t(problem.has_solution === true ? "problemLibrary.importWithSolutionTitle" : "problemLibrary.importTitle")}>
            <FilePlus size={14} aria-hidden="true" />{importLabel}
          </Button>
        </Inline>
      </Stack>
    </Inset>
  </article>;
}

/**
 * Whether the problem comes with a solution. Only an explicit true/false is stated; a missing value
 * is "not checked" rather than a guess, because importing relies on it.
 */
function SolutionStatus({ hasSolution }: { hasSolution: boolean | null | undefined }) {
  const t = useT("editor");
  const state = hasSolution === true ? "available" : hasSolution === false ? "none" : "unknown";
  const Icon = state === "available" ? CircleCheck : state === "none" ? Minus : CircleHelp;
  return <span className={styles.solution} data-solution={state}>
    <Icon size={12} aria-hidden="true" />{t(`problemLibrary.solutionState.${state}`)}
  </span>;
}

/** Same skeleton as ProblemCard (meta, title, preview, footer), so the load does not change the card's structure. */
function ProblemCardSkeleton() {
  return <div className={`${styles.card} ${styles.skeleton}`}>
    <Inset space="lg">
      <Stack gap="md">
        <Stack gap="xs">
          <Inline className={styles.meta}><Shimmer variant="surface" className={styles.skeletonTag} /></Inline>
          <Shimmer variant="surface" className={styles.skeletonTitle} />
        </Stack>
        <Stack gap="md">
          {[100, 94, 88, 96, 52].map(width => <Shimmer key={width} variant="surface" className={styles.skeletonLine} style={{ width: `${width}%` }} />)}
        </Stack>
        <Inline gap="sm" justify="between">
          <Shimmer variant="surface" className={styles.skeletonLink} />
          <Shimmer variant="surface" className={styles.skeletonButton} />
        </Inline>
      </Stack>
    </Inset>
  </div>;
}
