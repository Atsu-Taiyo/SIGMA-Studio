"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsField, SettingsSection, SettingsStatus, Switch } from "@/components/ui/settings";
import { AUTHORING_STYLE_LEARNED_LIMIT, AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleAPI, type AuthoringStyleItemView, type AuthoringStyleProfile } from "@/lib/ai/authoring-style";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  // In a shared workspace the switches that hold for everyone, and the reset, are its owner's and admins'.
  const wide = profile?.sync.wide ?? null;
  const manage = profile?.sync.manage ?? true;
  const heldOff = (name: "enabled" | "aiSummary") => !manage && wide !== null && !wide[name];
  const waiting = (profile?.memberEntries ?? []).filter(entry => !entry.declined);
  const declined = (profile?.memberEntries ?? []).filter(entry => entry.declined);
  const decide = (ids: string[], approve: boolean) => void run(() => api.resolveMemberEntries({ workspaceId: workspaceId!, ids, approve }));
  return (
    <SettingsSection id={id} className="ai-settings-pane" title={t("authoringStyle.title")} description={t("authoringStyle.description")}>
      {error && <SettingsStatus tone="error">{t("authoringStyle.error")}</SettingsStatus>}
      {!profile ? <Shimmer>{t("ai.loading")}</Shimmer> : <Stack gap="lg">
        <SettingsField label={t(workspaceId ? "authoringStyle.workspaceEnabled" : "authoringStyle.enabled")}>
          <Switch label={t(workspaceId ? "authoringStyle.workspaceEnabled" : "authoringStyle.enabled")} checked={profile.enabled} disabled={busy || (heldOff("enabled") && !profile.enabled)} onCheckedChange={enabled => void run(() => api.setEnabled(workspaceId, enabled))} />
        </SettingsField>
        <SettingsField label={t("authoringStyle.aiSummary")} description={t("authoringStyle.aiSummaryDescription")}>
          <Switch label={t("authoringStyle.aiSummary")} checked={profile.aiSummary} disabled={busy || !profile.enabled || (heldOff("aiSummary") && !profile.aiSummary)} onCheckedChange={enabled => void run(() => api.setAiSummary(workspaceId, enabled))} />
        </SettingsField>
        <SettingsField label={t("authoringStyle.autoApply")} description={t("authoringStyle.autoApplyDescription")}>
          <Switch label={t("authoringStyle.autoApply")} checked={profile.autoApply} disabled={busy || !profile.enabled} onCheckedChange={enabled => void run(() => api.setAutoApply(workspaceId, enabled))} />
        </SettingsField>
        {!workspaceId && profile.sync.available && <Stack gap="xs">
          <SettingsField label={t("authoringStyle.sync")} description={t("authoringStyle.syncDescription")}>
            <Switch label={t("authoringStyle.sync")} checked={profile.sync.enabled} disabled={busy || (!profile.sync.enabled && (!profile.sync.signedIn || profile.sync.pro === false))} onCheckedChange={enabled => void run(() => api.setSync(workspaceId, enabled), "all")} />
          </SettingsField>
          <SettingsStatus tone={["error", "limit", "other-account"].includes(profile.sync.state) ? "error" : undefined}>
            {t(`authoringStyle.syncState.${profile.sync.state}`)}{profile.sync.enabled && profile.sync.pro !== false && profile.sync.lastSyncedAt ? ` ${t("authoringStyle.syncedAt", { at: new Date(profile.sync.lastSyncedAt).toLocaleString() })}` : ""}
          </SettingsStatus>
          {profile.sync.enabled && <div className="ai-settings-actions">
            {profile.sync.state === "other-account"
              ? <Button size="sm" disabled={busy || dirty} onClick={() => void run(() => api.relinkSync(workspaceId), "all")}>{t("authoringStyle.syncRelink")}</Button>
              : <Button tone="ghost" size="sm" disabled={busy || dirty || !profile.sync.signedIn || profile.sync.pro === false} onClick={() => void run(() => api.syncNow(workspaceId), "all")}>{t("authoringStyle.syncNow")}</Button>}
            <Button tone="ghost" size="sm" disabled={busy || !profile.sync.signedIn || profile.sync.state === "other-account"} onClick={() => setConfirmDelete(true)}>{t("authoringStyle.syncDelete")}</Button>
          </div>}
        </Stack>}
        {workspaceId && profile.sync.available && profile.sync.scope !== "account" && <SettingsStatus>{t(`authoringStyle.syncScope.${profile.sync.scope}`)}</SettingsStatus>}
        {workspaceId && wide !== null && <SettingsStatus>{t(manage ? "authoringStyle.manageManager" : "authoringStyle.manageMember")}</SettingsStatus>}
        {(heldOff("enabled") || heldOff("aiSummary")) && <SettingsStatus>{t("authoringStyle.wideOff", { names: (["enabled", "aiSummary"] as const).filter(heldOff).map(name => t(`authoringStyle.wideName.${name}`)).join(" / ") })}</SettingsStatus>}
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
          <textarea id="authoring-style-learned" className="ai-settings-textarea" value={learned} maxLength={AUTHORING_STYLE_LEARNED_LIMIT} disabled={busy} placeholder={t("authoringStyle.empty")} onChange={event => setLearned(event.target.value)} />
          <small className="ai-settings-empty-hint">{t("authoringStyle.learnedHint")}</small>
          <small className="ai-settings-empty-hint" style={{ overflowWrap: "anywhere" }}>{profile.generatedPath}</small>
          <SettingsStatus>
            {t("authoringStyle.usage", { ...profile.usage })}
            {profile.lastReviewedAt && ` / ${t("authoringStyle.reviewed", { date: new Date(profile.lastReviewedAt).toLocaleString(), documents: profile.reviewedDocuments })}`}
            {profile.lastUpdate && ` / ${t("authoringStyle.updated", { rewritten: 0, removed: 0, ...profile.lastUpdate })}`}
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
          {profile.autoChanges.length > 0 && <Stack gap="xs" data-testid="authoring-style-auto-changes">
            <strong>{t("authoringStyle.autoChangesTitle")}</strong>
            <small className="ai-settings-empty-hint">{t("authoringStyle.autoChangesHint")}</small>
            <ul>{[...profile.autoChanges].reverse().map(change => <li key={change.id}>
              <Inline gap="sm">
                <span>{t(`authoringStyle.autoChange.${change.kind}`, { before: change.before, after: change.after })}</span>
                <small className="ai-settings-empty-hint" style={{ whiteSpace: "nowrap" }}>{t(`authoringStyle.autoChangeReason.${change.reason}`)} / {new Date(change.at).toLocaleDateString()}</small>
                <Button tone="ghost" size="sm" aria-label={t("authoringStyle.autoChangeRevertLabel", { text: change.before })} disabled={busy || learnedDirty}
                  onClick={() => void run(() => api.revertAutoChange({ workspaceId, id: change.id }), "learned")}>{t("authoringStyle.autoChangeRevert")}</Button>
              </Inline>
            </li>)}</ul>
          </Stack>}
          {(waiting.length > 0 || declined.length > 0) && <Stack gap="xs" data-testid="authoring-style-member-entries">
            <strong>{t("authoringStyle.memberTitle", { count: waiting.length })}</strong>
            <small className="ai-settings-empty-hint">{t("authoringStyle.memberHint")}</small>
            <ul>{waiting.map(entry => <li key={entry.id}>
              <Inline gap="sm">
                <span>{entry.text}</span>
                <small className="ai-settings-empty-hint" style={{ whiteSpace: "nowrap" }}><strong>{t(`authoringStyle.memberKind.${entry.kind}`)}</strong></small>
                <Button size="sm" aria-label={t("authoringStyle.memberApproveLabel", { text: entry.text })} disabled={busy} onClick={() => decide([entry.id], true)}>{t("authoringStyle.memberApprove")}</Button>
                <Button tone="ghost" size="sm" aria-label={t("authoringStyle.memberDeclineLabel", { text: entry.text })} disabled={busy} onClick={() => decide([entry.id], false)}>{t("authoringStyle.memberDecline")}</Button>
              </Inline>
            </li>)}</ul>
            {waiting.length > 1 && <Inline gap="sm"><Button tone="ghost" size="sm" disabled={busy} onClick={() => decide(waiting.map(entry => entry.id), true)}>{t("authoringStyle.memberApproveAll")}</Button></Inline>}
            {declined.length > 0 && <details>
              <summary>{t("authoringStyle.memberDeclinedTitle", { count: declined.length })}</summary>
              <ul>{declined.map(entry => <li key={entry.id}>
                <Inline gap="sm">
                  <span>{entry.text}</span>
                  <small className="ai-settings-empty-hint" style={{ whiteSpace: "nowrap" }}><strong>{t(`authoringStyle.memberKind.${entry.kind}`)}</strong></small>
                  <Button tone="ghost" size="sm" aria-label={t("authoringStyle.memberApproveLabel", { text: entry.text })} disabled={busy} onClick={() => decide([entry.id], true)}>{t("authoringStyle.memberApprove")}</Button>
                </Inline>
              </li>)}</ul>
            </details>}
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
        <Button tone="ghost" size="sm" disabled={busy || dirty || learnedDirty || !manage} onClick={() => setConfirmReset(true)}>{t("authoringStyle.reset")}</Button>
      </Stack>}
      <ModalFrame open={confirmDelete} onDismiss={() => setConfirmDelete(false)} size="sm" ariaLabel={t("authoringStyle.syncDelete")}>
        <ModalHeader title={t("authoringStyle.syncDelete")} onClose={() => setConfirmDelete(false)} />
        <ModalBody><Stack gap="lg">
          <p>{t("authoringStyle.syncDeleteConfirm")}</p>
          <Button onClick={() => { setConfirmDelete(false); void run(() => api.deleteSynced(workspaceId), "all"); }}>{t("authoringStyle.syncDelete")}</Button>
        </Stack></ModalBody>
      </ModalFrame>
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
