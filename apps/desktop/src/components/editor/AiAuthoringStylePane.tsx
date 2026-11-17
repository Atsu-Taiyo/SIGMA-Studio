"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsField, SettingsSection, SettingsStatus, Switch } from "@/components/ui/settings";
import { AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleAPI, type AuthoringStyleItemView, type AuthoringStyleProfile } from "@/lib/ai/authoring-style";
import { useT } from "@/lib/i18n/react";

export function AiAuthoringStylePane({ api, workspaceId, id }: { id: string; api: AuthoringStyleAPI; workspaceId: string | null }) {
  const t = useT("settings");
  const [profile, setProfile] = useState<AuthoringStyleProfile | null>(null);
  const [content, setContent] = useState("");
  const [draftRevision, setDraftRevision] = useState("");
  const [learned, setLearned] = useState("");
  const [learnedRevision, setLearnedRevision] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const adoptNote = (value: AuthoringStyleProfile) => { setContent(value.userContent); setDraftRevision(value.revision); };
  const adoptLearned = (value: AuthoringStyleProfile) => { setLearned(value.generatedContent); setLearnedRevision(value.generatedRevision); };
  useEffect(() => {
    let cancelled = false;
    void api.read(workspaceId).then(value => {
      if (!cancelled) { setProfile(value); adoptNote(value); adoptLearned(value); }
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [api, workspaceId]);

  // A draft the user is typing is never replaced by the result of another action.
  const run = async (action: () => Promise<AuthoringStyleProfile>, replace: "none" | "note" | "learned" | "all" = "none") => {
    setBusy(true); setError(false);
    try {
      const value = await action();
      const learnedUntouched = profile !== null && learned === profile.generatedContent;
      setProfile(value);
      if (replace === "note" || replace === "all") adoptNote(value);
      if (replace === "learned" || replace === "all" || learnedUntouched) adoptLearned(value);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const dirty = profile !== null && content !== profile.userContent;
  const learnedDirty = profile !== null && learned !== profile.generatedContent;
  const evidence = (item: AuthoringStyleItemView) => item.origin === "user" ? t("authoringStyle.evidenceUser")
    : item.basis === "summary" ? t("authoringStyle.evidenceSummary", { documents: item.documents })
      : t(item.basis === "corrections" ? "authoringStyle.evidenceCorrections" : "authoringStyle.evidenceWriting", { count: item.support, documents: item.documents });
  const aiAdded = (profile?.items ?? []).filter(item => item.origin === "auto" && item.basis === "summary");
  return (
    <SettingsSection id={id} className="ai-settings-pane" title={t("authoringStyle.title")} description={t("authoringStyle.description")}>
      {error && <SettingsStatus tone="error">{t("authoringStyle.error")}</SettingsStatus>}
      {!profile ? <Shimmer>{t("ai.loading")}</Shimmer> : <Stack gap="lg">
        <SettingsField label={t(workspaceId ? "authoringStyle.workspaceEnabled" : "authoringStyle.enabled")}>
          <Switch label={t(workspaceId ? "authoringStyle.workspaceEnabled" : "authoringStyle.enabled")} checked={profile.enabled} disabled={busy} onCheckedChange={enabled => void run(() => api.setEnabled(workspaceId, enabled))} />
        </SettingsField>
        <SettingsField label={t("authoringStyle.aiSummary")} description={t("authoringStyle.aiSummaryDescription")}>
          <Switch label={t("authoringStyle.aiSummary")} checked={profile.aiSummary} disabled={busy || !profile.enabled} onCheckedChange={enabled => void run(() => api.setAiSummary(workspaceId, enabled))} />
        </SettingsField>
        <SettingsStatus>{t("authoringStyle.count", { count: profile.exampleCount })} / {t("authoringStyle.outcomes", { ...profile.outcomes })}</SettingsStatus>
        {profile.blockedLines > 0 && <SettingsStatus tone="error">{t("authoringStyle.blocked", { count: profile.blockedLines })}</SettingsStatus>}
        <Stack gap="xs">
          <label htmlFor="authoring-style-note">{t("authoringStyle.manual")}</label>
          <textarea id="authoring-style-note" className="ai-settings-textarea" value={content} maxLength={AUTHORING_STYLE_NOTE_LIMIT} disabled={busy} onChange={event => setContent(event.target.value)} />
          <small className="ai-settings-empty-hint" style={{ overflowWrap: "anywhere" }}>{profile.userPath}</small>
          <Inline gap="sm">
            <Button size="sm" disabled={busy || !dirty} onClick={() => void run(() => api.save({ workspaceId, content, expectedRevision: draftRevision }), "note")}>{t("authoringStyle.save")}</Button>
            <Button tone="ghost" size="sm" disabled={busy} onClick={() => void run(() => api.read(workspaceId), "all")}>{t("authoringStyle.reload")}</Button>
          </Inline>
        </Stack>
        {workspaceId && <Stack gap="xs">
          <label htmlFor="authoring-style-learned">{t("authoringStyle.learned")}</label>
          <textarea id="authoring-style-learned" className="ai-settings-textarea" value={learned} maxLength={AUTHORING_STYLE_NOTE_LIMIT} disabled={busy} placeholder={t("authoringStyle.empty")} onChange={event => setLearned(event.target.value)} />
          <small className="ai-settings-empty-hint">{t("authoringStyle.learnedHint")}</small>
          <small className="ai-settings-empty-hint" style={{ overflowWrap: "anywhere" }}>{profile.generatedPath}</small>
          <SettingsStatus>
            {t("authoringStyle.usage", { ...profile.usage })}
            {profile.lastReviewedAt && ` / ${t("authoringStyle.reviewed", { date: new Date(profile.lastReviewedAt).toLocaleString(), documents: profile.reviewedDocuments })}`}
            {profile.lastUpdate && ` / ${t("authoringStyle.updated", { ...profile.lastUpdate })}`}
          </SettingsStatus>
          <Inline gap="sm">
            <Button size="sm" disabled={busy || !learnedDirty} onClick={() => void run(() => api.saveLearned({ workspaceId, content: learned, expectedRevision: learnedRevision }), "learned")}>{t("authoringStyle.saveLearned")}</Button>
            <Button tone="ghost" size="sm" disabled={busy || learnedDirty || !profile.enabled} onClick={() => void run(() => api.review(workspaceId))}>{t("authoringStyle.review")}</Button>
            <Button tone="ghost" size="sm" disabled={busy || learnedDirty || !profile.canUndo} onClick={() => void run(() => api.undo(workspaceId))}>{t("authoringStyle.undo")}</Button>
          </Inline>
          {profile.pending.length > 0 && <Stack gap="xs">
            <strong>{t("authoringStyle.pendingTitle")}</strong>
            {profile.pending.map(change => (
              <Stack key={change.id} gap="xs" className="ai-settings-empty-hint">
                <span>{t(`authoringStyle.pending.${change.kind}`, { current: change.currentText, proposed: change.proposedText, count: change.support })}</span>
                <Inline gap="sm">
                  <Button size="sm" disabled={busy || learnedDirty} onClick={() => void run(() => api.resolvePending({ workspaceId, id: change.id, approve: true }))}>{t("authoringStyle.approve")}</Button>
                  <Button tone="ghost" size="sm" disabled={busy || learnedDirty} onClick={() => void run(() => api.resolvePending({ workspaceId, id: change.id, approve: false }))}>{t("authoringStyle.dismiss")}</Button>
                </Inline>
              </Stack>
            ))}
          </Stack>}
          {aiAdded.length > 0 && <Stack gap="xs">
            <strong>{t("authoringStyle.aiAddedTitle")}</strong>
            <small className="ai-settings-empty-hint">{t("authoringStyle.aiAddedHint")}</small>
            <ul>{aiAdded.map(item => <li key={item.id}>
              <Inline gap="sm">
                <span>{item.text}</span>
                <small className="ai-settings-empty-hint"><strong>{t("authoringStyle.aiAddedBadge")}</strong> {t("authoringStyle.aiAddedOn", { date: new Date(item.firstSeenAt).toLocaleDateString(), documents: item.documents })}</small>
                <Button tone="ghost" size="sm" aria-label={t("authoringStyle.aiAddedRemoveLabel", { text: item.text })} disabled={busy || learnedDirty}
                  onClick={() => void run(() => api.removeItem({ workspaceId, id: item.id }), "learned")}>{t("authoringStyle.aiAddedRemove")}</Button>
              </Inline>
            </li>)}</ul>
          </Stack>}
          {profile.items.length > 0 && <details>
            <summary>{t("authoringStyle.evidenceTitle")}</summary>
            <ul>{profile.items.map(item => <li key={item.id}>{item.text.replace(/^- /, "")} <small className="ai-settings-empty-hint">{item.basis === "summary" && item.origin === "auto" && <strong>{t("authoringStyle.aiAddedBadge")} </strong>}{evidence(item)}</small></li>)}</ul>
          </details>}
        </Stack>}
        <Button tone="ghost" size="sm" disabled={busy || dirty || learnedDirty} onClick={() => setConfirmReset(true)}>{t("authoringStyle.reset")}</Button>
      </Stack>}
      <ModalFrame open={confirmReset} onDismiss={() => setConfirmReset(false)} size="sm" ariaLabel={t("authoringStyle.reset")}>
        <ModalHeader title={t("authoringStyle.reset")} onClose={() => setConfirmReset(false)} />
        <ModalBody><Stack gap="lg">
          <p>{t(workspaceId ? "authoringStyle.resetWorkspace" : "authoringStyle.resetGlobal")}</p>
          <Button onClick={() => { setConfirmReset(false); void run(() => api.reset(workspaceId), "all"); }}>{t("authoringStyle.reset")}</Button>
        </Stack></ModalBody>
      </ModalFrame>
    </SettingsSection>
  );
}
