"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { Shimmer } from "@/components/ui/Shimmer";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import { facetKeyParts, type LibraryFacet } from "@/lib/problem-library-provider";
import styles from "./ProblemLibraryDialog.module.css";

/** At most this many classifications can be combined; the server rejects more. */
export const MAX_SELECTED_FACETS = 20;
const ROOT = "";

type Level = { status: "loading" } | { status: "error" } | { status: "ready"; facets: LibraryFacet[] };

/**
 * The library's classification tree, one level per request. Levels are kept for the dialog's
 * lifetime, so leaving the library source and coming back keeps what was opened.
 */
export function useFacetTree(enabled: boolean) {
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const requested = useRef(new Set<string>());
  const load = useCallback((parent: string | null, force = false) => {
    const key = parent ?? ROOT;
    if (requested.current.has(key) && !force) return;
    requested.current.add(key);
    setLevels(current => ({ ...current, [key]: { status: "loading" } }));
    const bridge = getDesktopBridge()?.problems?.library;
    void (bridge ? bridge.facets({ parent }) : Promise.resolve({ ok: false as const, error: "" }))
      .catch(() => ({ ok: false as const, error: "" }))
      .then(result => setLevels(current => ({ ...current, [key]: result.ok ? { status: "ready", facets: result.facets } : { status: "error" } })));
  }, []);
  useEffect(() => {
    if (!enabled || requested.current.has(ROOT)) return;
    // Deferred so the first level is requested after the panel has painted, not during the render that showed it.
    const timer = setTimeout(() => load(null), 0);
    return () => clearTimeout(timer);
  }, [enabled, load]);
  return { levels, load };
}

interface PanelProps {
  tree: ReturnType<typeof useFacetTree>;
  selected: readonly string[];
  /** Counts within the current results: every top-level key, and the children of each selected key. */
  counts: Readonly<Record<string, number>>;
  disabled: boolean;
  onToggle(key: string): void;
}

/** Classification filters, grouped by `type` (単元, 難易度, 大学 …) as the server names them. */
export function FacetPanel({ tree, selected, counts, disabled, onToggle }: PanelProps) {
  const t = useT("editor");
  const root = tree.levels[ROOT];
  const sections = useMemo(() => {
    if (root?.status !== "ready") return [];
    const byType = new Map<string, LibraryFacet[]>();
    for (const facet of root.facets) byType.set(facet.type, [...(byType.get(facet.type) ?? []), facet]);
    return [...byType].map(([type, facets]) => ({ type, facets, groups: new Set(facets.map(facet => facet.group)).size }));
  }, [root]);
  return <nav className={styles.facetPanel} aria-label={t("problemLibrary.filterPanel")}>
    {!root || root.status === "loading" ? (
      <Stack gap="md" aria-hidden="true">
        {[64, 88, 72, 80, 56].map(width => <Shimmer key={width} variant="surface" className={styles.skeletonLine} style={{ width: `${width}%` }} />)}
        <span className="visually-hidden" role="status">{t("problemLibrary.facetsLoading")}</span>
      </Stack>
    ) : root.status === "error" ? (
      <Stack gap="sm" align="start">
        <span className={styles.facetMessage} role="alert">{t("problemLibrary.facetsFailed")}</span>
        <Button size="sm" tone="ghost" onClick={() => tree.load(null, true)}><RotateCw size={14} aria-hidden="true" />{t("problemLibrary.retry")}</Button>
      </Stack>
    ) : sections.length === 0 ? (
      <span className={styles.facetMessage}>{t("problemLibrary.facetsEmpty")}</span>
    ) : (
      <Stack gap="md">
        {sections.map(section => <FacetSection key={section.type} {...section} tree={tree} selected={selected} counts={counts} disabled={disabled} onToggle={onToggle} />)}
      </Stack>
    )}
  </nav>;
}

function FacetSection({ type, facets, groups, ...rest }: { type: string; facets: LibraryFacet[]; groups: number } & PanelProps) {
  const [open, setOpen] = useState(true);
  return <section className={styles.facetSection}>
    <button type="button" className={styles.facetSectionToggle} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      <span>{type}</span>
    </button>
    {open && <ul className={styles.facetList} role="list">
      {/* When two groups share a type (an exam database and a common scheme, say), the group is shown under the value. */}
      {facets.map(facet => <FacetNode key={facet.key} facet={facet} parent={null} depth={0} showGroup={groups > 1} {...rest} />)}
    </ul>}
  </section>;
}

function FacetNode({ facet, parent, depth, showGroup, tree, selected, counts, disabled, onToggle }: {
  facet: LibraryFacet; parent: string | null; depth: number; showGroup: boolean;
} & PanelProps) {
  const t = useT("editor");
  const [expanded, setExpanded] = useState(false);
  const isSelected = selected.includes(facet.key);
  const level = tree.levels[facet.key];
  // A count is only meaningful where the server reported one for the current results; elsewhere nothing is shown.
  const count = facet.key in counts ? counts[facet.key] : parent === null || selected.includes(parent) ? 0 : undefined;
  const atLimit = !isSelected && selected.length >= MAX_SELECTED_FACETS;
  const toggleExpanded = () => {
    if (!expanded) tree.load(facet.key);
    setExpanded(value => !value);
  };
  return <li>
    <div className={styles.facetRow}>
      {facet.hasChildren ? (
        <button type="button" className={styles.facetExpand} aria-expanded={expanded}
          aria-label={t(expanded ? "problemLibrary.collapseFacet" : "problemLibrary.expandFacet", { label: facet.label })} onClick={toggleExpanded}>
          {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        </button>
      ) : <span className={styles.facetExpandSpacer} aria-hidden="true" />}
      <button type="button" className={styles.facetOption} aria-pressed={isSelected} disabled={disabled || atLimit}
        data-empty={count === 0 || undefined} data-facet-key={facet.key} onClick={() => onToggle(facet.key)}>
        <span className={styles.facetLabel}>
          {facet.label}
          {showGroup && depth === 0 && <span className={styles.facetGroup}>{facet.group}</span>}
        </span>
        {count !== undefined && <span className={styles.facetCount}>{count}</span>}
      </button>
    </div>
    {/* Nested lists indent by one step in CSS, so depth needs no inline geometry. */}
    {expanded && <ul className={styles.facetList} role="list">
      {!level || level.status === "loading" ? <li className={styles.facetMessage}>{t("problemLibrary.facetsLoading")}</li>
        : level.status === "error" ? <li className={styles.facetMessage} role="alert">{t("problemLibrary.facetsFailed")}</li>
          : level.facets.map(child => <FacetNode key={child.key} facet={child} parent={facet.key} depth={depth + 1} showGroup={false}
            tree={tree} selected={selected} counts={counts} disabled={disabled} onToggle={onToggle} />)}
    </ul>}
  </li>;
}

/** The selected classifications as removable chips. Labels come from the key, so they never wait for the tree. */
export function FacetChips({ selected, disabled, onRemove, onClear }: { selected: readonly string[]; disabled: boolean; onRemove(key: string): void; onClear(): void }) {
  const t = useT("editor");
  if (selected.length === 0) return null;
  return <Inline className={styles.chips} gap="xs" wrap>
    {selected.map(key => {
      const { type, path } = facetKeyParts(key);
      const label = `${type}: ${path.join(" › ")}`;
      return <span key={key} className={styles.chip} title={label}>
        <span className={styles.chipLabel}>{label}</span>
        <button type="button" className={styles.chipRemove} disabled={disabled} aria-label={t("problemLibrary.removeFilter", { label })} onClick={() => onRemove(key)}>
          <X size={12} aria-hidden="true" />
        </button>
      </span>;
    })}
    <Button size="sm" tone="ghost" disabled={disabled} onClick={onClear}>{t("problemLibrary.clearFilters")}</Button>
  </Inline>;
}
