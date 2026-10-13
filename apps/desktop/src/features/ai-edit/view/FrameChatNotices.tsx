"use client";

import { Square } from "lucide-react";

import type { PageCanvasEditorProps } from "@/components/editor/PageCanvasEditor";
import { Button, IconButton } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { Shimmer } from "@/components/ui/Shimmer";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { AI_FRAME_DRAWING, type SigmaDocument } from "@/features/document";
import { applyBoxFrameDrawing } from "@/lib/box-blocks";
import { applyCustomFrameDrawing, customFrameImageSrc, type CustomFrameTargetKind } from "@/lib/custom-frame";
import { findBlock } from "@/lib/document-tree";
import { useT } from "@/lib/i18n/react";
import { applyProblemFrameDrawing } from "@/lib/problem-frame";
import { addFrameToLibrary, getFrameLibrary } from "@/lib/frame-library";

import {
  frameChatStore,
  useFrameChatNotices,
  useFrameChatSessions,
} from "../application/frame-chat-store";
import { isFrameChatRunning, type FrameChatDrawing } from "../model/frame-chat";
import styles from "./FrameChat.module.css";

/** Which kind of block a target id names; a notice for a block that is no longer that kind offers no "use". */
const TARGET_BLOCK_TYPE: Record<CustomFrameTargetKind, "problem" | "boxBlock"> = {
  problem: "problem",
  box: "boxBlock",
};

interface NoticesProps {
  documentIdentityKey: string | null | undefined;
  document: SigmaDocument;
  /** The editor's own block update, so a drawing lands on the block the way the frame dialog puts it. */
  onChange: PageCanvasEditorProps["onChange"];
}

/**
 * What happens to a frame the reader asked the AI for and then closed the dialog on: a small status
 * while it is being drawn, and, when it is done, a dialog that says so. One notice at a time, for the
 * problems and boxes of this document; the drawing itself stays in the conversation, so dismissing
 * the notice never loses it.
 */
export function FrameChatNotices(props: NoticesProps) {
  return (
    <>
      <FrameChatBusy documentIdentityKey={props.documentIdentityKey} />
      <FrameChatNoticeDialog {...props} />
    </>
  );
}

/** Shown only while a run has nobody watching it: with the dialog open, the conversation is the status. */
function FrameChatBusy({ documentIdentityKey }: Pick<NoticesProps, "documentIdentityKey">) {
  const t = useT("settings");
  const sessions = useFrameChatSessions();
  const working = [...sessions.values()].filter((session) =>
    session.documentIdentityKey === (documentIdentityKey ?? "")
    && isFrameChatRunning(session)
    && !frameChatStore.isWatched(session.key));
  if (working.length === 0) {
    return null;
  }
  return (
    <div className={styles.busy} role="status" data-testid="custom-frame-ai-busy">
      <Shimmer>{t("frame.notice.working")}</Shimmer>
      <IconButton
        label={t("frame.aiStop")}
        tone="ghost"
        size="sm"
        onClick={() => working.forEach((session) => frameChatStore.cancel(session.key))}
      >
        <Square size={12} fill="currentColor" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function FrameChatNoticeDialog({ documentIdentityKey, document, onChange }: NoticesProps) {
  const t = useT("settings");
  const notices = useFrameChatNotices();
  const notice = notices.find((candidate) => candidate.documentIdentityKey === (documentIdentityKey ?? ""));
  if (!notice) {
    return null;
  }

  const found = findBlock(document, notice.target.id);
  const target = found?.type === TARGET_BLOCK_TYPE[notice.target.kind] ? found : null;
  const drawing = notice.drawing;
  const dismiss = () => frameChatStore.dismissNotice(notice.id);
  const applyToTarget = (block: NonNullable<typeof target>, applied: FrameChatDrawing) => {
    const options = { slice: AI_FRAME_DRAWING.slice };
    const applyDrawing = notice.target.kind === "box" ? applyBoxFrameDrawing : applyProblemFrameDrawing;
    onChange(block.id, (current) => applyDrawing(current, applied, options));
    // The dialog keeps every frame it puts on a block on the shelf too; do the same here.
    const previous = block.type === "problem" || block.type === "boxBlock" ? block.frame?.custom : undefined;
    addFrameToLibrary(
      applyCustomFrameDrawing(previous, applied, options),
      t("frame.libraryDefaultName", { number: getFrameLibrary().length + 1 }),
    );
    frameChatStore.markApplied(notice.key, notice.id);
  };
  const title = t(
    notice.kind === "drawn"
      ? "frame.notice.drawnTitle"
      : notice.kind === "failed"
        ? "frame.notice.failedTitle"
        : "frame.notice.replyTitle",
  );

  return (
    <ModalFrame open onDismiss={dismiss} size="sm" ariaLabel={title}>
      <ModalHeader title={title} onClose={dismiss} />
      <ModalBody padding="xl">
        <Stack gap="lg" data-testid="custom-frame-ai-notice">
          {notice.kind === "drawn" && <p className={styles.message}>{t(`frame.target.${notice.target.kind}.noticeDrawnBody`)}</p>}
          {drawing && (
            <div className={styles.noticePreview}>
              {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URL, not a fetched image */}
              <img
                className={styles.drawingImage}
                src={customFrameImageSrc(drawing.svg)}
                alt={t("frame.chat.drawingAlt")}
                width={drawing.width}
                height={drawing.height}
              />
            </div>
          )}
          {notice.message && <p className={styles.message}>{notice.message}</p>}
          {notice.error && <p role="alert" className={styles.error}>{notice.error}</p>}
          {drawing && <p className={styles.note}>{t(`frame.target.${notice.target.kind}.noticeKept`)}</p>}
          <Inline justify="end" gap="sm">
            <Button size="md" onClick={dismiss}>{t("frame.notice.close")}</Button>
            {drawing && target && (
              <Button
                size="md"
                tone="primary"
                data-testid="custom-frame-ai-notice-use"
                onClick={() => {
                  applyToTarget(target, drawing);
                  dismiss();
                }}
              >
                {t(`frame.target.${notice.target.kind}.noticeUse`)}
              </Button>
            )}
          </Inline>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
