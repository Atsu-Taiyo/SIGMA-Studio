"use client";

import { useId } from "react";
import type { TikzEnvironment } from "@/features/document";
import { MAX_TIKZ_ENVIRONMENT_LENGTH } from "@/features/document";
import { Stack } from "@/components/ui/layout";
import { SettingsField } from "@/components/ui/settings";
import { useT } from "@/lib/i18n/react";
import styles from "./Tikz.module.css";

export function TikzEnvironmentFields({ value, onChange }: {
  value: TikzEnvironment;
  onChange: (value: TikzEnvironment) => void;
}) {
  const t = useT("settings");
  const id = useId();
  return <Stack gap="lg">
    <SettingsField label={t("tikz.packages")} htmlFor={`${id}-packages`} description={t("tikz.packagesHelp")}>
      <textarea id={`${id}-packages`} className={styles.code} rows={3} spellCheck={false} maxLength={MAX_TIKZ_ENVIRONMENT_LENGTH}
        placeholder={String.raw`\usepackage{pgfplots}`} value={value.packages} onChange={(event) => onChange({ ...value, packages: event.target.value })} />
    </SettingsField>
    <SettingsField label={t("tikz.libraries")} htmlFor={`${id}-libraries`}>
      <input id={`${id}-libraries`} className={styles.code} spellCheck={false} maxLength={MAX_TIKZ_ENVIRONMENT_LENGTH}
        placeholder="calc, positioning" value={value.libraries} onChange={(event) => onChange({ ...value, libraries: event.target.value })} />
    </SettingsField>
    <SettingsField label={t("tikz.preamble")} htmlFor={`${id}-preamble`}>
      <textarea id={`${id}-preamble`} className={styles.code} rows={5} spellCheck={false} maxLength={MAX_TIKZ_ENVIRONMENT_LENGTH}
        placeholder={String.raw`\newcommand{\R}{\mathbb{R}}`} value={value.preamble} onChange={(event) => onChange({ ...value, preamble: event.target.value })} />
    </SettingsField>
  </Stack>;
}
