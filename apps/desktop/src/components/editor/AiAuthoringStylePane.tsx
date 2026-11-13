"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsField, SettingsSection, SettingsStatus, Switch } from "@/components/ui/settings";
import { AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleAPI, type AuthoringStyleProfile } from "@/lib/ai/authoring-style";
import { useT } from "@/lib/i18n/react";

export function AiAuthoringStylePane({ api, workspaceId, id }: { id: string; api: AuthoringStyleAPI; workspaceId: string | null }) {
  const t = useT("settings");
  const [profile, setProfile] = useState<AuthoringStyleProfile | null>(null);
  const [content, setContent] = useState("");
  const [draftRevision, setDraftRevision] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api.read(workspaceId).then(value => {
      if (!cancelled) { setProfile(value); setContent(value.userContent); setDraftRevision(value.revision); }
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [api, workspaceId]);

  const run = async (action: () => Promise<AuthoringStyleProfile>, replaceContent = false) => {
    setBusy(true); setError(false);
    try {
      const value = await action();
      setProfile(value);
      if (replaceContent) { setContent(value.userContent); setDraftRevision(value.revision); }
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const dirty = profile && content !== profile.userContent;
  return (
    <SettingsSection id={id} className="ai-settings-pane" title={t("authoringStyle.title")} description={t("authoringStyle.description")}>
      {error && <SettingsStatus tone="error">{t("authoringStyle.error")}</SettingsStatus>}
      {!profile ? <Shimmer>{t("ai.loading")}</Shimmer> : <Stack gap="lg">
        <SettingsField label={t(workspaceId ? "authoringStyle.workspaceEnabled" : "authoringStyle.enabled")}>
          <Switch label={t(workspaceId ? "authoringStyle.workspaceEnabled" : "authoringStyle.enabled")} checked={profile.enabled} disabled={busy} onCheckedChange={enabled => void run(() => api.setEnabled(workspaceId, enabled))} />
        </SettingsField>
        <SettingsStatus>{t("authoringStyle.count", { count: profile.exampleCount })}</SettingsStatus>
        <Stack gap="xs">
          <label htmlFor="authoring-style-note">{t("authoringStyle.manual")}</label>
          <textarea id="authoring-style-note" className="ai-settings-textarea" value={content} maxLength={AUTHORING_STYLE_NOTE_LIMIT} disabled={busy} onChange={event => setContent(event.target.value)} />
          <small className="ai-settings-empty-hint" style={{ overflowWrap: "anywhere" }}>{profile.userPath}</small>
          <Inline gap="sm">
            <Button size="sm" disabled={busy || !dirty} onClick={() => void run(() => api.save({ workspaceId, content, expectedRevision: draftRevision }), true)}>{t("authoringStyle.save")}</Button>
            <Button tone="ghost" size="sm" disabled={busy} onClick={() => void run(() => api.read(workspaceId), true)}>{t("authoringStyle.reload")}</Button>
          </Inline>
        </Stack>
        <Stack gap="xs">
          <label htmlFor="authoring-style-learned">{t("authoringStyle.learned")}</label>
          <textarea id="authoring-style-learned" className="ai-settings-textarea" readOnly value={profile.generatedContent} placeholder={t("authoringStyle.empty")} />
          <small className="ai-settings-empty-hint" style={{ overflowWrap: "anywhere" }}>{profile.generatedPath}</small>
          {profile.generatedEdited && <SettingsStatus>{t("authoringStyle.protected")}</SettingsStatus>}
        </Stack>
        <Button tone="ghost" size="sm" disabled={busy || Boolean(dirty)} onClick={() => setConfirmReset(true)}>{t("authoringStyle.reset")}</Button>
      </Stack>}
      <ModalFrame open={confirmReset} onDismiss={() => setConfirmReset(false)} size="sm" ariaLabel={t("authoringStyle.reset")}>
        <ModalHeader title={t("authoringStyle.reset")} onClose={() => setConfirmReset(false)} />
        <ModalBody><Stack gap="lg">
          <p>{t(workspaceId ? "authoringStyle.resetWorkspace" : "authoringStyle.resetGlobal")}</p>
          <Button onClick={() => { setConfirmReset(false); void run(() => api.reset(workspaceId)); }}>{t("authoringStyle.reset")}</Button>
        </Stack></ModalBody>
      </ModalFrame>
    </SettingsSection>
  );
}
