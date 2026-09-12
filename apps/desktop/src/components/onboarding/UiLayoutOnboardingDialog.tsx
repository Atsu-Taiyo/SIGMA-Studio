"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, useState, type FunctionComponent } from "react";

import { useUiLayoutOnboardingVisible } from "@/components/onboarding/use-ui-layout-onboarding";
import { Grid } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import {
  useUiLayoutPreference,
  type UiLayoutMode,
  type UiLayoutPreference,
} from "@/lib/ui-layout-preference";

import styles from "./UiLayoutOnboardingDialog.module.css";
import { useT } from "@/lib/i18n/react";

/**
 * Word風クロームの模式図。タブ行 (1本目だけ選択中) と、見出し付きの
 * コマンドグループ 3 つ。スクリーンショットは使わず、面と線だけで描く。
 */
function WordLayoutPreview() {
  return (
    <span className={styles.preview} aria-hidden="true">
      <span className={styles.wordTabs}>
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={styles.wordTab} data-active={index === 0} />
        ))}
      </span>
      <span className={styles.wordRibbon}>
        {[0, 1, 2].map((index) => (
          <span key={index} className={styles.wordGroup}>
            <span className={styles.wordGroupBody} />
            <span className={styles.wordGroupLabel} />
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * Googleドキュメント風クロームの模式図。文字メニューの行と、
 * 1段だけのアイコン列。
 */
function DocsLayoutPreview() {
  return (
    <span className={styles.preview} aria-hidden="true">
      <span className={styles.docsMenubar}>
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={styles.docsMenuItem} />
        ))}
      </span>
      <span className={styles.docsToolbar}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
          <span key={index} className={styles.docsToolbarIcon} />
        ))}
      </span>
    </span>
  );
}

/**
 * 文言ではなく**辞書キー**を持つ。module 直下で `t()` を呼ぶと読み込み時の言語で
 * 焼き付き、言語を切り替えてもこの画面だけ元の言語で残る。
 */
const CHOICES: Array<{
  mode: UiLayoutMode;
  titleKey: "onboarding.wordTitle" | "onboarding.docsTitle";
  descriptionKey: "onboarding.wordDescription" | "onboarding.docsDescription";
  preview: FunctionComponent;
}> = [
  {
    mode: "word",
    titleKey: "onboarding.wordTitle",
    descriptionKey: "onboarding.wordDescription",
    preview: WordLayoutPreview,
  },
  {
    mode: "docs",
    titleKey: "onboarding.docsTitle",
    descriptionKey: "onboarding.docsDescription",
    preview: DocsLayoutPreview,
  },
];

/**
 * 初回起動時に一度だけ出るUI選択画面。src/app/page.tsx から EditorShell の隣に描く
 * (EditorShell の中に入れない) ので、packages/editor のバンドルには構造的に入らない
 * = 埋め込みでは実行時フラグ抜きに非表示になる。
 */
export function UiLayoutOnboardingDialog() {
  const t = useT("workspace");
  const title = t("onboarding.title");
  const [preference, updatePreference] = useUiLayoutPreference();
  const shouldShow = useUiLayoutOnboardingVisible({ isEmbedded: false });
  // 保存が失敗しても (読み取り専用プロファイル・容量超過) このセッションでは必ず閉じる。
  // モーダルは背面を inert にするので、閉じられないと編集画面ごと操作不能になる。
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const wasCompletedRef = useRef(preference.onboardingCompleted);

  // 「UIの選択画面を再表示」は完了フラグを false に戻すだけなので、
  // true → false へ変わったらセッション内の閉じた記録も戻す。
  useEffect(() => {
    if (wasCompletedRef.current && !preference.onboardingCompleted) {
      setDismissedThisSession(false);
    }
    wasCompletedRef.current = preference.onboardingCompleted;
  }, [preference.onboardingCompleted]);

  const close = (patch: Partial<UiLayoutPreference>) => {
    setDismissedThisSession(true);
    updatePreference(patch);
  };
  // × / Escape / 背景クリック。mode は書き換えず、完了だけ記録する。
  const skip = () => close({ onboardingCompleted: true });

  return (
    <ModalFrame
      open={shouldShow && !dismissedThisSession}
      onDismiss={skip}
      size="lg"
      ariaLabel={title}
    >
      <ModalHeader
        title={title}
        description={t("onboarding.footnote")}
        onClose={skip}
      />
      <ModalBody padding="xl">
        <Grid columns={2} gap="xl" className={styles.choices}>
          {CHOICES.map((choice) => {
            const selected = preference.mode === choice.mode;
            const Preview = choice.preview;
            return (
              <button
                key={choice.mode}
                type="button"
                className={styles.card}
                data-ui-layout-choice={choice.mode}
                data-selected={selected}
                aria-pressed={selected}
                // 何もせず Enter を押したときに閉じる (=スキップする) のではなく、
                // 今のレイアウトを選び直したことになるよう初期フォーカスを置く。
                data-modal-initial-focus={selected ? "" : undefined}
                // 選んだ時点で適用して閉じる。確認ボタンは挟まない。
                onClick={() => close({ mode: choice.mode, onboardingCompleted: true })}
              >
                <Preview />
                <span className={styles.cardTitle}>
                  {t(choice.titleKey)}
                  {selected ? <Check size={16} aria-hidden="true" /> : null}
                </span>
                <span className={styles.cardDescription}>{t(choice.descriptionKey)}</span>
              </button>
            );
          })}
        </Grid>
      </ModalBody>
    </ModalFrame>
  );
}
