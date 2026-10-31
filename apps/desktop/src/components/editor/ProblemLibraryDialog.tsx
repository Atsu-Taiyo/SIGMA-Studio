"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BookOpen, CircleAlert, CircleCheck, CircleHelp, ExternalLink, FilePlus, Minus, RotateCw, SearchX, Tag } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Grid, Inline, Inset, Stack } from "@/components/ui/layout";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { Shimmer } from "@/components/ui/Shimmer";
import { Switch } from "@/components/ui/settings";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { MathEnvironmentProvider } from "@/features/rendering/adapters/react";
import type { SigmaDocument } from "@/features/document";
import { PrintBlock } from "@/components/print/print-static-blocks";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import { PROBLEM_LIBRARY_CATEGORIES, ProblemLibraryImportError, prepareLibraryProblemImport, problemSourceUrl, problemToSigmaDocument, readLibraryProblems, type LibraryProblem, type ProblemLibraryQuery } from "@/lib/problem-library";
import { withoutSolutions, type LibraryAccess, type LibraryProblemSummary, type LibrarySearchRequest } from "@/lib/problem-library-provider";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { FacetChips, FacetPanel, MAX_SELECTED_FACETS, useFacetTree } from "./ProblemLibraryFacets";
import styles from "./ProblemLibraryDialog.module.css";

interface Props {
  onImport(file: File): Promise<boolean>;
  onClose(): void;
}

type RequestMode = "recommended" | "results";
/**
 * Where problems come from. 受験数学研究所 is open to everyone; the library is shown only when the
 * server says the signed-in user may use it, under the name the server gives. Do not confuse either
 * with `LibraryProblem.source_name` / `source_label`, which is a problem's own origin (an exam, a book).
 */
type Source = "all" | "jukenmath" | "library";

const RECOMMENDED_LIMIT = 6;
const RESULTS_LIMIT = 20;
/** A multiple of every column count (3, 2, 1), so a full page never leaves a ragged last row. */
const LIBRARY_PAGE = 24;
const RECOMMENDED_QUERY: ProblemLibraryQuery = { sort: "likes", limit: RECOMMENDED_LIMIT };

const PROBLEM_SOURCE = { id: "jukenmath", originalUrl: problemSourceUrl } as const;

interface JukenRequest { query: ProblemLibraryQuery; mode: RequestMode }
interface JukenState { for: JukenRequest; problems: LibraryProblem[]; error: string | null }
type LibraryRequest = LibrarySearchRequest & { facets: string[]; limit: number };
interface LibraryState { for: LibraryRequest; results: LibraryProblemSummary[]; total: number; facetCounts: Record<string, number>; error: string | null }
type Item = { kind: "jukenmath"; problem: LibraryProblem } | { kind: "library"; problem: LibraryProblemSummary };

export function ProblemLibraryDialog({ onImport, onClose }: Props) {
  const t = useT("editor");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [facets, setFacets] = useState<string[]>([]);
  const [source, setSource] = useState<Source>("all");
  const [access, setAccess] = useState<LibraryAccess | null>(null);
  const [includeSolution, setIncludeSolution] = useState(true);
  const [jukenRequest, setJukenRequest] = useState<JukenRequest>({ query: RECOMMENDED_QUERY, mode: "recommended" });
  const [juken, setJuken] = useState<JukenState | null>(null);
  const [libraryRequest, setLibraryRequest] = useState<LibraryRequest>({ facets: [], limit: RECOMMENDED_LIMIT });
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const importingRef = useRef(false);
  const libraryRequestRef = useRef(libraryRequest);
  useEffect(() => { libraryRequestRef.current = libraryRequest; }, [libraryRequest]);

  // Members only: without a confirmed, named library nothing about it appears.
  const libraryLabel = access?.available ? access.label : undefined;
  const active: Source = libraryLabel ? source : "jukenmath";
  const showJuken = active !== "library";
  const showLibrary = active !== "jukenmath";
  const facetTree = useFacetTree(active === "library");

  useEffect(() => {
    let live = true;
    const bridge = getDesktopBridge()?.problems?.library;
    void (bridge ? bridge.access() : Promise.resolve<LibraryAccess>({ available: false }))
      .catch((): LibraryAccess => ({ available: false }))
      .then(result => { if (live) setAccess(result); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!showJuken) return;
    let live = true;
    const request = jukenRequest;
    const search = async () => {
      const bridge = getDesktopBridge()?.problems;
      if (!bridge) return { ok: false as const, error: t("problemLibrary.unavailable") };
      return bridge.search(request.query);
    };
    void search().then(result => {
      if (!live) return;
      if (!result.ok) { setJuken({ for: request, problems: [], error: result.error }); return; }
      try { setJuken({ for: request, problems: readLibraryProblems(result.search), error: null }); }
      catch { setJuken({ for: request, problems: [], error: t("problemLibrary.loadFailed") }); }
    }).catch(() => {
      if (live) setJuken({ for: request, problems: [], error: t("problemLibrary.loadFailed") });
    });
    return () => { live = false; };
  }, [jukenRequest, showJuken, t]);

  useEffect(() => {
    if (!showLibrary) return;
    let live = true;
    const request = libraryRequest;
    const bridge = getDesktopBridge()?.problems?.library;
    void (bridge ? bridge.search({ ...request, offset: 0 }) : Promise.resolve({ ok: false as const, error: t("problemLibrary.unavailable") }))
      .catch(() => ({ ok: false as const, error: t("problemLibrary.loadFailed") }))
      .then(result => {
        if (!live) return;
        setMore("idle");
        setLibrary(result.ok
          ? { for: request, results: result.search.results, total: result.search.total, facetCounts: result.search.facetCounts, error: null }
          : { for: request, results: [], total: 0, facetCounts: {}, error: result.error });
      });
    return () => { live = false; };
  }, [libraryRequest, showLibrary, t]);

  const jukenLoading = showJuken && juken?.for !== jukenRequest;
  const libraryLoading = showLibrary && library?.for !== libraryRequest;
  const jukenReady = showJuken && !jukenLoading ? juken : null;
  const libraryReady = showLibrary && !libraryLoading ? library : null;

  /**
   * Builds both providers' requests from the toolbar. The tag filter belongs to 受験数学研究所 and the
   * classification filters to the library, so each applies only when its own source is selected.
   */
  const run = (next: { keyword?: string; category?: string; facets?: string[]; source?: Source } = {}) => {
    const keyword = (next.keyword ?? query).trim() || undefined;
    const selectedSource = next.source ?? source;
    const jukenOnly = selectedSource === "jukenmath" || !libraryLabel;
    const tag = jukenOnly ? (next.category ?? category) || undefined : undefined;
    const classifications = selectedSource === "library" ? next.facets ?? facets : [];
    setImportError(null);
    setJukenRequest(!keyword && !tag ? { query: RECOMMENDED_QUERY, mode: "recommended" } : { query: { q: keyword, category: tag, sort: "likes", limit: RESULTS_LIMIT }, mode: "results" });
    setLibraryRequest({
      ...(keyword ? { q: keyword } : {}),
      facets: classifications,
      limit: selectedSource === "library" ? LIBRARY_PAGE : keyword ? RESULTS_LIMIT : RECOMMENDED_LIMIT,
    });
  };
  const showRecommended = () => {
    setQuery("");
    setCategory("");
    run({ keyword: "", category: "" });
  };
  const retryJuken = () => setJukenRequest(current => ({ ...current }));
  const retryLibrary = () => setLibraryRequest(current => ({ ...current }));
  const selectSource = (next: Source) => {
    if (next === source) return;
    setSource(next);
    run({ source: next });
  };
  const toggleFacet = (key: string) => {
    const next = facets.includes(key) ? facets.filter(item => item !== key) : [...facets, key].slice(0, MAX_SELECTED_FACETS);
    setFacets(next);
    run({ facets: next });
  };
  const clearFacets = () => {
    setFacets([]);
    run({ facets: [] });
  };
  const loadMore = async () => {
    const current = library;
    const bridge = getDesktopBridge()?.problems?.library;
    if (!current || !bridge || more === "loading") return;
    setMore("loading");
    try {
      const result = await bridge.search({ ...current.for, offset: current.results.length });
      // A newer search replaced the list while this page was loading; its rows belong to nothing on screen.
      if (libraryRequestRef.current !== current.for) return;
      if (!result.ok) { setMore("failed"); return; }
      setLibrary(state => {
        if (!state || state.for !== current.for) return state;
        const known = new Set(state.results.map(problem => problem.id));
        return { ...state, total: result.search.total, results: [...state.results, ...result.search.results.filter(problem => !known.has(problem.id))] };
      });
      setMore("idle");
    } catch {
      if (libraryRequestRef.current === current.for) setMore("failed");
    }
  };

  const dismiss = () => { if (!importingRef.current) onClose(); };
  const importDocument = async (key: string, title: string, prepare: () => Promise<SigmaDocument>) => {
    if (importingRef.current) return;
    importingRef.current = true;
    setImporting(key);
    setImportError(null);
    try {
      const document = await prepare();
      const file = new File([JSON.stringify(document)], `${title}.sigma`, { type: "application/json" });
      if (await onImport(file)) onClose();
      else setImportError(t("problemLibrary.importFailed"));
    } catch (caught) {
      // Only the helpers' own errors carry a translated, safe message; anything else stays generic.
      setImportError(caught instanceof ProblemLibraryImportError ? caught.message : t("problemLibrary.importFailed"));
    } finally {
      importingRef.current = false;
      setImporting(null);
    }
  };
  const importJuken = (problem: LibraryProblem) => importDocument(`jukenmath:${problem.id}`, problem.title,
    // Fetches and verifies the solution when the problem has one and it is wanted; it throws instead of importing the body alone.
    () => prepareLibraryProblemImport(problem, getDesktopBridge()?.problems, { includeSolution }));
  const importLibrary = (problem: LibraryProblemSummary) => importDocument(`library:${problem.id}`, problem.title, async () => {
    const bridge = getDesktopBridge()?.problems?.library;
    if (!bridge) throw new ProblemLibraryImportError(t("problemLibrary.restartRequired"));
    let result: Awaited<ReturnType<typeof bridge.get>>;
    try { result = await bridge.get({ id: problem.id }); }
    catch { throw new ProblemLibraryImportError(t("problemLibrary.importFailed")); }
    // The main process words its failures for the screen and never includes response bodies.
    if (!result.ok) throw new ProblemLibraryImportError(result.error);
    const document = parseSigmaDocument(result.document);
    return includeSolution ? document : withoutSolutions(document);
  });

  const items = useMemo<Item[]>(() => {
    const jukenItems: Item[] = (jukenReady?.problems ?? []).map(problem => ({ kind: "jukenmath", problem }));
    const libraryItems: Item[] = (libraryReady?.results ?? []).map(problem => ({ kind: "library", problem }));
    // Alternate the two providers so neither is pushed below the fold by the other.
    const mixed: Item[] = [];
    for (let index = 0; index < Math.max(jukenItems.length, libraryItems.length); index++) {
      if (jukenItems[index]) mixed.push(jukenItems[index]);
      if (libraryItems[index]) mixed.push(libraryItems[index]);
    }
    return mixed;
  }, [jukenReady, libraryReady]);

  const sourceName = (kind: "jukenmath" | "library") => kind === "library" ? libraryLabel ?? "" : t(`problemLibrary.sources.${PROBLEM_SOURCE.id}`);
  const failures = [
    ...(jukenReady?.error ? [{ kind: "jukenmath" as const, message: jukenReady.error, retry: retryJuken }] : []),
    ...(libraryReady?.error ? [{ kind: "library" as const, message: libraryReady.error, retry: retryLibrary }] : []),
  ];
  const providers = (showJuken ? 1 : 0) + (showLibrary ? 1 : 0);
  const allFailed = failures.length === providers;
  const pending = jukenLoading || libraryLoading;
  const nothingYet = items.length === 0 && pending;
  const mode: RequestMode = active === "library"
    ? (libraryRequest.q || libraryRequest.facets.length > 0 ? "results" : "recommended")
    : jukenRequest.mode;
  const busy = importing !== null;
  const heading = active === "library" ? libraryLabel! : t(`problemLibrary.${mode}`);
  const count = active === "library" ? libraryReady && !libraryReady.error ? libraryReady.total : null
    : active === "jukenmath" && mode === "results" && jukenReady && !jukenReady.error ? jukenReady.problems.length : null;

  return (
    <ModalFrame open onDismiss={dismiss} size="xl" ariaLabel={t("problemLibrary.title")}>
      <ModalHeader title={<span className={styles.title}><BookOpen size={18} aria-hidden="true" /><span>{t("problemLibrary.title")}</span></span>} onClose={dismiss} />
      <ModalBody className={styles.body} padding="none" scroll="hidden">
        <form className={styles.toolbar} role="search" onSubmit={event => {
          event.preventDefault();
          run();
        }}>
          <Inline gap="sm" wrap>
            {libraryLabel && <SourceSwitch value={source} libraryLabel={libraryLabel} disabled={busy} onChange={selectSource} />}
            <SearchField className={styles.search} data-modal-initial-focus value={query} onChange={setQuery} maxLength={active === "jukenmath" ? 500 : 200}
              placeholder={t("problemLibrary.placeholder")} aria-label={t("problemLibrary.keyword")} clearLabel={t("problemLibrary.clear")} enterKeyHint="search" disabled={busy} />
            {active === "jukenmath" && (
              // The shared Select keeps the keyboard and ARIA behaviour; the icon is a sibling because the trigger only renders its label.
              <div className={styles.tagFilter} data-active={category !== "" || undefined}>
                <Tag className={styles.tagIcon} size={14} aria-hidden="true" />
                <Select className={styles.tagTrigger} aria-label={t("problemLibrary.category")} value={category} disabled={busy}
                  onChange={value => { setCategory(value); run({ category: value }); }}
                  options={[
                    { value: "", label: t("problemLibrary.all"), content: <span className={styles.tagOptionAll}>{t("problemLibrary.all")}</span> },
                    ...PROBLEM_LIBRARY_CATEGORIES.map(({ value, key }) => {
                      const label = t(`problemLibrary.categories.${key}`);
                      return { value, label, content: <span className={styles.tagOption}><Tag size={12} aria-hidden="true" />{label}</span> };
                    }),
                  ]} />
              </div>
            )}
            <label className={styles.solutionToggle}>
              <Switch checked={includeSolution} label={t("problemLibrary.includeSolution")} disabled={busy} onCheckedChange={setIncludeSolution} />
              <span aria-hidden="true">{t("problemLibrary.includeSolution")}</span>
            </label>
          </Inline>
        </form>
        <div className={styles.main}>
          {active === "library" && <FacetPanel tree={facetTree} selected={facets} counts={library?.facetCounts ?? {}} disabled={busy} onToggle={toggleFacet} />}
          <Inset className={styles.results} space="xl">
            <Stack gap="lg">
              <Inline className={styles.heading} gap="md" justify="between">
                <Inline gap="sm" align="baseline">
                  <h3>{heading}</h3>
                  {count !== null && !pending && <span className={styles.count}>{t("problemLibrary.resultCount", { total: count })}</span>}
                </Inline>
                {active !== "library" && mode === "results" && <Button tone="ghost" size="sm" disabled={pending || busy} onClick={showRecommended}>{t("problemLibrary.recommend")}</Button>}
              </Inline>
              {active === "library" && <FacetChips selected={facets} disabled={busy} onRemove={toggleFacet} onClear={clearFacets} />}
              {importError && <Inset className={styles.notice} space="md" role="alert">
                <Inline gap="sm" align="start"><CircleAlert size={16} aria-hidden="true" /><span>{importError}</span></Inline>
              </Inset>}
              {/* With two providers, one that fails is reported here and the other's problems stay visible. */}
              {!allFailed && failures.map(failure => <Inset key={failure.kind} className={styles.notice} space="md" role="alert">
                <Inline gap="sm" align="center" justify="between">
                  <Inline gap="sm" align="start"><CircleAlert size={16} aria-hidden="true" />
                    <span>{t("problemLibrary.sourceFailed", { source: sourceName(failure.kind) })} {failure.message}</span></Inline>
                  <Button size="sm" tone="ghost" disabled={pending} onClick={failure.retry}><RotateCw size={14} aria-hidden="true" />{t("problemLibrary.retry")}</Button>
                </Inline>
              </Inset>)}
              {pending && <span className="visually-hidden" role="status">{t("problemLibrary.loading")}</span>}
              {nothingYet ? (
                <Grid className={styles.grid} columns={3} gap="md" responsive={false} aria-hidden="true">
                  {Array.from({ length: RECOMMENDED_LIMIT }, (_, index) => <ProblemCardSkeleton key={index} />)}
                </Grid>
              ) : !pending && allFailed ? (
                <Stack className={styles.state} gap="md" align="center" justify="center">
                  <CircleAlert size={24} aria-hidden="true" />
                  <span className={styles.stateMessage} role="alert">{failures.map(failure => failure.message).filter((message, index, list) => list.indexOf(message) === index).join(" ")}</span>
                  <Button size="sm" onClick={() => failures.forEach(failure => failure.retry())}><RotateCw size={14} aria-hidden="true" />{t("problemLibrary.retry")}</Button>
                </Stack>
              ) : items.length === 0 && !pending ? (
                <Stack className={styles.state} gap="md" align="center" justify="center">
                  <SearchX size={24} aria-hidden="true" />
                  <strong role="status">{t("problemLibrary.empty")}</strong>
                  {active === "library"
                    ? facets.length > 0 && <Button size="sm" disabled={busy} onClick={clearFacets}>{t("problemLibrary.clearFilters")}</Button>
                    : <Button size="sm" disabled={busy} onClick={showRecommended}>{t("problemLibrary.recommend")}</Button>}
                </Stack>
              ) : (
                <MathEnvironmentProvider>
                  <Grid className={styles.grid} columns={3} gap="md" responsive={false}>
                    {items.map(item => item.kind === "jukenmath"
                      ? <ProblemCard key={`jukenmath:${item.problem.id}`} problem={item.problem} badge={libraryLabel ? sourceName("jukenmath") : undefined}
                        includeSolution={includeSolution} busy={busy} importing={importing === `jukenmath:${item.problem.id}`} onImport={() => void importJuken(item.problem)} />
                      : <LibraryProblemCard key={`library:${item.problem.id}`} problem={item.problem} sourceName={sourceName("library")}
                        includeSolution={includeSolution} busy={busy} importing={importing === `library:${item.problem.id}`} onImport={() => void importLibrary(item.problem)} />)}
                    {/* The provider still answering keeps a few placeholders at the end instead of holding back the other. */}
                    {pending && Array.from({ length: 3 }, (_, index) => <ProblemCardSkeleton key={`pending-${index}`} />)}
                  </Grid>
                </MathEnvironmentProvider>
              )}
              {active === "library" && libraryReady && !libraryReady.error && libraryReady.results.length > 0 && (
                <Stack gap="sm" align="center">
                  <span className={styles.count}>{t("problemLibrary.showing", { total: libraryReady.total, shown: libraryReady.results.length })}</span>
                  {more === "failed" && <span className={styles.stateMessage} role="alert">{t("problemLibrary.moreFailed")}</span>}
                  {libraryReady.results.length < libraryReady.total && libraryReady.results.length < 10_000 && (
                    <Button size="sm" disabled={more === "loading" || busy} onClick={() => void loadMore()}>
                      {t(more === "loading" ? "problemLibrary.loadingMore" : "problemLibrary.more")}
                    </Button>
                  )}
                </Stack>
              )}
              {active === "all" && libraryReady && !libraryReady.error && libraryReady.total > libraryReady.results.length && (
                <Inline justify="center">
                  <Button size="sm" tone="ghost" disabled={busy} onClick={() => selectSource("library")}>
                    {t("problemLibrary.showAllInSource", { source: libraryLabel, total: libraryReady.total })}
                  </Button>
                </Inline>
              )}
            </Stack>
          </Inset>
        </div>
      </ModalBody>
    </ModalFrame>
  );
}

/** すべて / 受験数学研究所 / the library. A radio group, so arrow keys move between the sources. */
function SourceSwitch({ value, libraryLabel, disabled, onChange }: { value: Source; libraryLabel: string; disabled: boolean; onChange(source: Source): void }) {
  const t = useT("editor");
  const options: Array<{ value: Source; label: string }> = [
    { value: "all", label: t("problemLibrary.allSources") },
    { value: "jukenmath", label: t(`problemLibrary.sources.${PROBLEM_SOURCE.id}`) },
    { value: "library", label: libraryLabel },
  ];
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return <div className={styles.sourceSwitch} role="radiogroup" aria-label={t("problemLibrary.source")}>
    {options.map((option, index) => <button key={option.value} ref={element => { refs.current[index] = element; }} type="button" role="radio"
      aria-checked={value === option.value} tabIndex={value === option.value ? 0 : -1} disabled={disabled}
      title={option.label} onClick={() => onChange(option.value)} onKeyDown={event => move(event, index)}>
      <span>{option.label}</span>
    </button>)}
  </div>;
}

function SourceBadge({ name, kind }: { name: string; kind: "jukenmath" | "library" }) {
  return <span className={styles.sourceBadge} data-source={kind} title={name}>{name}</span>;
}

function importTitle(hasSolution: boolean | null | undefined, includeSolution: boolean) {
  if (!includeSolution) return hasSolution === false ? "problemLibrary.importTitle" : "problemLibrary.importWithoutSolutionTitle";
  return hasSolution === true ? "problemLibrary.importWithSolutionTitle" : "problemLibrary.importTitle";
}

function ProblemCard({ problem, badge, includeSolution, busy, importing, onImport }: {
  problem: LibraryProblem; badge?: string; includeSolution: boolean; busy: boolean; importing: boolean; onImport(): void;
}) {
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
  return <article className={styles.card} data-source="jukenmath" data-importing={importing || undefined} aria-labelledby={titleId}>
    <Inset space="lg">
      <Stack gap="md">
        <Stack gap="xs">
          <Inline className={styles.meta} gap="sm" wrap>
            {badge && <SourceBadge name={badge} kind="jukenmath" />}
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
            title={t(importTitle(problem.has_solution, includeSolution))}>
            <FilePlus size={14} aria-hidden="true" />{importLabel}
          </Button>
        </Inline>
      </Stack>
    </Inset>
  </article>;
}

/** A library problem: the server's preview blocks, its origin, solution status and a few tags. */
function LibraryProblemCard({ problem, sourceName, includeSolution, busy, importing, onImport }: {
  problem: LibraryProblemSummary; sourceName: string; includeSolution: boolean; busy: boolean; importing: boolean; onImport(): void;
}) {
  const t = useT("editor");
  const titleId = useId();
  const year = problem.exam_year && !problem.source_label?.includes(String(problem.exam_year)) ? t("problemLibrary.examYear", { year: problem.exam_year }) : null;
  const origin = [problem.source_label, year].filter(Boolean).join(" ");
  const importLabel = t(importing ? "problemLibrary.importing" : "problemLibrary.import");
  return <article className={styles.card} data-source="library" data-importing={importing || undefined} aria-labelledby={titleId}>
    <Inset space="lg">
      <Stack gap="md">
        <Stack gap="xs">
          <Inline className={styles.meta} gap="sm" wrap>
            <SourceBadge name={sourceName} kind="library" />
            <SolutionStatus hasSolution={problem.has_solution} />
          </Inline>
          <h4 id={titleId} className={styles.cardTitle}>{problem.title}</h4>
          {origin && <p className={styles.origin}>{origin}</p>}
        </Stack>
        {problem.preview.length > 0 && <div className={styles.preview}>
          {problem.preview.map(block => <PrintBlock key={block.id} unit={{ type: "block", id: block.id, block }} columnGapMm={8} />)}
        </div>}
        {problem.tags.length > 0 && <Inline gap="xs" wrap>
          {problem.tags.slice(0, 3).map(tag => <span key={tag} className={styles.categoryTag}>{tag}</span>)}
        </Inline>}
        <Inline gap="sm" justify="end">
          <Button size="sm" disabled={busy} onClick={onImport} aria-label={`${importLabel}：${problem.title}`}
            title={t(importTitle(problem.has_solution, includeSolution))}>
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
