"use client";

import { useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { LinkConfirmationRequest } from "@/lib/link-confirmation";
import { Button } from "./ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "./ui/Modal";
import { Inline, Stack } from "./ui/layout";
import styles from "./LinkConfirmationDialog.module.css";

export function LinkConfirmationDialog() {
  const t = useT("chrome");
  const [request, setRequest] = useState<LinkConfirmationRequest | null>(null);
  useEffect(() => {
    const api = getDesktopBridge()?.linkConfirmation;
    if (!api) return;
    let generation = 0;
    const update = () => {
      const current = ++generation;
      void api.pending().then(value => { if (current === generation) setRequest(value); }).catch(() => {});
    };
    const unsubscribe = api.onChanged(update);
    update();
    return () => { generation++; unsubscribe(); };
  }, []);
  if (!request) return null;
  const respond = (approved: boolean) => { void getDesktopBridge()?.linkConfirmation?.respond(request.id, approved); };
  return <ModalFrame open layer="nested" size="sm" onDismiss={() => respond(false)}>
    <ModalHeader title={t("linkConfirmation.title")} description={t("linkConfirmation.description")} onClose={() => respond(false)} />
    <ModalBody><Stack gap="lg">
      <div className={styles.destination} dir="ltr">
        <strong>{request.host}</strong>
        <code>{request.url}</code>
      </div>
      {request.warnings.length > 0 && <ul className={styles.warnings}>
        {request.warnings.map(warning => <li key={warning}>{t(`linkConfirmation.${warning}`)}</li>)}
      </ul>}
      <p className={styles.note}>{t("linkConfirmation.unverified")}</p>
      <Inline justify="end" gap="sm">
        <Button data-modal-initial-focus tone="secondary" onClick={() => respond(false)}>{t("linkConfirmation.cancel")}</Button>
        <Button tone="primary" onClick={() => respond(true)}>{t(request.destination === "external" ? "linkConfirmation.openExternal" : "linkConfirmation.open")}</Button>
      </Inline>
    </Stack></ModalBody>
  </ModalFrame>;
}
