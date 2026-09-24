"use client";

import { Check, Sparkles } from "lucide-react";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Inline, Stack } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";
import {
  FREE_PLAN,
  FREE_PLAN_FEATURES,
  formatUsd,
  PRO_PLAN,
  PRO_PLAN_FEATURES,
  type CollaborationPlanState,
} from "../model/plan";
import styles from "./plan.module.css";

/**
 * Paywall comparing the free and Pro plans side by side. It only presents the
 * plans: without `onUpgrade` the checkout action stays disabled until billing ships.
 */
export function CollaborationPlanDialog({ plan, reason = "account", layer, onClose, onUpgrade, billingAvailable = false }: {
  plan: Exclude<CollaborationPlanState, "unavailable">;
  reason?: "account" | "hierarchyShare" | "documentLimit";
  layer?: "base" | "nested";
  onClose: () => void;
  onUpgrade?: () => void;
  billingAvailable?: boolean;
}) {
  const t = useT("chrome");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const billing = getDesktopBridge()?.sharedCatalog?.billing;
  const upgrade = onUpgrade ?? (billing && billingAvailable ? () => {
    setBusy(true); setError(false);
    void billing(plan === "free" ? "checkout" : "portal").catch(() => setError(true)).finally(() => setBusy(false));
  } : undefined);
  const billingPeriod = <span>{t("collaboration.plan.billingPeriod")}</span>;
  return (
    <ModalFrame open onDismiss={onClose} size="lg" layer={layer}>
      <ModalHeader
        title={t("collaboration.plan.title")}
        description={t(reason === "documentLimit" ? "collaboration.plan.documentLimit" : reason === "hierarchyShare" ? "collaboration.plan.hierarchyRequired" : "collaboration.plan.description")}
        onClose={onClose}
      />
      <ModalBody>
        <p>{t("collaboration.plan.trialTerms")}</p>
        {error && <p role="alert">{t("collaboration.error")}</p>}
        {plan !== "free" && <Button disabled={busy || !upgrade} onClick={upgrade}>{t("collaboration.plan.manageBilling")}</Button>}
        <div className={styles.plans}>
          <PlanCard
            mark={<PlanMark particles={FREE_PARTICLES} />}
            name={t("collaboration.plan.free.name")}
            tagline={t("collaboration.plan.free.tagline")}
            price={formatUsd(FREE_PLAN.priceUsd)}
            priceNote={billingPeriod}
            action={plan === "free" ? (
              <Button size="lg" className={styles.cta} disabled>{t("collaboration.plan.currentPlan")}</Button>
            ) : null}
            featuresLabel={t("collaboration.plan.free.featuresLabel")}
            features={FREE_PLAN_FEATURES.map((feature) => t(`collaboration.plan.free.features.${feature}`))}
          />
          <PlanCard
            emphasized
            mark={<PlanMark particles={PRO_PARTICLES} />}
            name={t("collaboration.plan.pro.name")}
            tagline={t("collaboration.plan.pro.tagline")}
            price={formatUsd(PRO_PLAN.priceUsd)}
            priceNote={<>{billingPeriod}<span>{t("collaboration.plan.perUser")}</span></>}
            action={plan === "pro" ? (
              <Inline gap="sm" justify="center" className={styles.status} role="status">
                <Check size={16} aria-hidden="true" />
                {t("collaboration.plan.proActive")}
              </Inline>
            ) : (
              <Stack gap="sm">
                <Button tone="primary" size="lg" className={styles.cta} disabled={busy || !upgrade} onClick={upgrade}>
                  <Sparkles size={16} aria-hidden="true" />
                  {t("collaboration.plan.upgrade")}
                </Button>
                {!upgrade && <span className={styles.note}>{t("collaboration.plan.checkoutPending")}</span>}
                {plan === "trial" && <span className={styles.note}>{t("collaboration.plan.trialActive")}</span>}
              </Stack>
            )}
            featuresLabel={t("collaboration.plan.pro.featuresLabel")}
            features={PRO_PLAN_FEATURES.map((feature) => t(`collaboration.plan.pro.features.${feature}`, { limit: PRO_PLAN.collaboratorLimit }))}
          />
        </div>
      </ModalBody>
    </ModalFrame>
  );
}

function PlanCard({ emphasized = false, mark, name, tagline, price, priceNote, action, featuresLabel, features }: {
  emphasized?: boolean;
  mark: ReactNode;
  name: string;
  tagline: string;
  price: string;
  priceNote: ReactNode;
  action: ReactNode;
  featuresLabel: string;
  features: string[];
}) {
  const headingId = useId();
  return (
    <section className={styles.plan} data-emphasized={emphasized} aria-labelledby={headingId}>
      <Stack gap="md" className={styles.planSection}>
        {mark}
        <Stack gap="xs">
          <h3 id={headingId} className={styles.planName}>{name}</h3>
          <span className={styles.tagline}>{tagline}</span>
        </Stack>
      </Stack>
      <Inline gap="sm" className={styles.planSection}>
        <span className={styles.amount}>{price}</span>
        <Stack gap="none" className={styles.priceNote}>{priceNote}</Stack>
      </Inline>
      <div className={styles.planSection}>{action}</div>
      <Stack gap="md" className={styles.planFeatures}>
        <span className={styles.featuresLabel}>{featuresLabel}</span>
        <Stack as="ul" gap="sm" className={styles.featureList} aria-label={featuresLabel}>
          {features.map((feature) => (
            <li key={feature}>
              <Inline gap="sm" align="start">
                <Check size={15} className={styles.check} aria-hidden="true" />
                <span>{feature}</span>
              </Inline>
            </li>
          ))}
        </Stack>
      </Stack>
    </section>
  );
}

/**
 * Display-style \sum (U+2211) from KaTeX_Size2-Regular (MIT, bundled with the
 * app's math fonts), normalized to a 32.37 × 34 box.
 */
const SUM_PATH = "M0.12 0.05Q0.19 0 14.81 0L29.43 0L30.84 3.28Q31.16 4.03 31.55 4.95Q31.94 5.88 32.12 6.29Q32.30 6.70 32.37 6.82L31.40 6.82L31.23 6.48Q30.24 4.49 28.07 3.23Q25.35 1.58 20.40 1.26Q19.21 1.19 11.85 1.17L4.76 1.17L4.95 1.43Q16.20 16.81 16.25 16.95Q16.27 17 16.25 17.10L3.42 31.72Q3.42 31.74 8.55 31.74Q18.87 31.74 19.70 31.69Q23.02 31.52 24.82 31.09Q28.39 30.21 30.41 27.83Q30.92 27.18 31.40 26.08L32.37 26.08Q32.30 26.23 30.84 30.21L29.43 33.98L14.84 34Q0.22 34 0.15 33.95Q0 33.90 0 33.73Q0 33.68 0.05 33.59L0.90 32.64Q1.72 31.67 3.35 29.81Q4.98 27.95 6.56 26.18Q13.02 18.82 12.99 18.77Q12.99 18.75 12.19 17.67Q11.39 16.59 9.63 14.17Q7.87 11.75 6.48 9.86L0.02 1.00L0 0.63Q0 0.12 0.12 0.05Z";
/** Particles leave the open side of the Σ; this is where each flight starts. */
const PARTICLE_ORIGIN = { x: 26, y: 24 };

interface Particle { x: number; y: number; r: number; delay: number }
const FREE_PARTICLES: readonly Particle[] = [
  { x: 41, y: 19, r: 2, delay: -0.3 },
  { x: 46, y: 26, r: 1.6, delay: -1.5 },
  { x: 40, y: 32, r: 1.2, delay: -2.6 },
];
const PRO_PARTICLES: readonly Particle[] = [
  { x: 40, y: 15, r: 1.6, delay: -0.2 },
  { x: 47, y: 21, r: 2.4, delay: -1.1 },
  { x: 53, y: 11, r: 1.3, delay: -2 },
  { x: 45, y: 30, r: 1.8, delay: -2.8 },
  { x: 57, y: 25, r: 1.8, delay: -0.7 },
  { x: 53, y: 35, r: 2.2, delay: -1.6 },
  { x: 40, y: 37, r: 1.2, delay: -2.4 },
  { x: 64, y: 16, r: 1.1, delay: -3.1 },
  { x: 66, y: 31, r: 1.4, delay: -1.9 },
  { x: 61, y: 40, r: 1, delay: -3.4 },
];

/** Σ with particles streaming out; more particles reach farther on Pro. */
function PlanMark({ particles }: { particles: readonly Particle[] }) {
  return (
    <svg className={styles.mark} viewBox="0 0 72 48" aria-hidden="true">
      <path className={styles.sum} d={SUM_PATH} transform="translate(2 7)" />
      {particles.map((particle) => (
        <circle
          key={`${particle.x}:${particle.y}`}
          className={styles.particle}
          cx={particle.x}
          cy={particle.y}
          r={particle.r}
          style={{
            "--particle-from-x": `${PARTICLE_ORIGIN.x - particle.x}px`,
            "--particle-from-y": `${PARTICLE_ORIGIN.y - particle.y}px`,
            "--particle-drift-x": `${(particle.x - PARTICLE_ORIGIN.x) * 0.2}px`,
            "--particle-drift-y": `${(particle.y - PARTICLE_ORIGIN.y) * 0.2}px`,
            animationDelay: `${particle.delay}s`,
          } as CSSProperties}
        />
      ))}
    </svg>
  );
}
