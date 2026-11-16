"use client";

import { useEffect, useRef, useState } from "react";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Stack } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";
import { USAGE_GUIDE_URL } from "@/lib/project-links";
import { OPEN_USAGE_MANUAL_EVENT } from "@/lib/usage-manual";
import { resolveManualHeading } from "./manual-scroll-spy";
import styles from "./UsageManual.module.css";

const SECTIONS = [
  { id: "workspace", level: 2 },
  { id: "create", level: 3 },
  { id: "bookmarks", level: 3 },
  { id: "sidebar", level: 3 },
  { id: "editor", level: 2 },
  { id: "tabs", level: 3 },
  { id: "tools", level: 3 },
  { id: "files", level: 2 },
  { id: "export", level: 3 },
] as const;

export function UsageManual() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_USAGE_MANUAL_EVENT, show);
    return () => window.removeEventListener(OPEN_USAGE_MANUAL_EVENT, show);
  }, []);
  return open ? <ManualContents onClose={() => setOpen(false)} /> : null;
}

function ManualContents({ onClose }: { onClose(): void }) {
  const t = useT("workspace");
  const viewportRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>(`manual-${SECTIONS[0].id}`);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      const top = viewport.getBoundingClientRect().top;
      const headings = Array.from(viewport.querySelectorAll<HTMLElement>("[data-manual-heading]")).map(heading => ({
        id: heading.id, level: Number(heading.dataset.manualHeading), top: heading.getBoundingClientRect().top - top,
      }));
      const atEnd = viewport.scrollTop > 0 && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
      const next = resolveManualHeading(headings, 24, atEnd);
      if (next) setActiveId(next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(viewport);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <ModalFrame open onDismiss={onClose} size="xl">
      <ModalHeader title={t("manual.title")} onClose={onClose} />
      <ModalBody scroll="hidden" className={styles.body}>
        <div className={styles.layout}>
          <Stack as="nav" gap="xs" className={styles.toc} aria-label={t("manual.toc")}>
            {SECTIONS.map(section => <a key={section.id} href={`#manual-${section.id}`} data-level={section.level} aria-current={activeId === `manual-${section.id}` ? "location" : undefined} onClick={event => {
              event.preventDefault();
              const viewport = viewportRef.current;
              const heading = viewport?.querySelector<HTMLElement>(`#manual-${section.id}`);
              if (!viewport || !heading) return;
              viewport.scrollTo({ top: viewport.scrollTop + heading.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24, behavior: "instant" });
              heading.focus({ preventScroll: true });
              setActiveId(heading.id);
            }}>{t(`manual.sections.${section.id}.title`)}</a>)}
          </Stack>
          <div ref={viewportRef} className={styles.content} data-manual-viewport="" role="region" aria-label={t("manual.title")} tabIndex={0}>
            <Stack gap="xl">
              {SECTIONS.map(section => {
                const Heading = section.level === 2 ? "h2" : "h3";
                return <Stack as="section" gap="sm" key={section.id}>
                  <Heading id={`manual-${section.id}`} data-manual-heading={section.level} tabIndex={-1}>{t(`manual.sections.${section.id}.title`)}</Heading>
                  <p>{t(`manual.sections.${section.id}.body`)}</p>
                </Stack>;
              })}
              <a href={USAGE_GUIDE_URL} target="_blank" rel="noopener noreferrer">{t("manual.fullGuide")}</a>
            </Stack>
          </div>
        </div>
      </ModalBody>
    </ModalFrame>
  );
}
