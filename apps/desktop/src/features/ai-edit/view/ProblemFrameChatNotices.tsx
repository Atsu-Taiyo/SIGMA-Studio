"use client";

import { Square } from "lucide-react";

import type { PageCanvasEditorProps } from "@/components/editor/PageCanvasEditor";
import { Button, IconButton } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { Shimmer } from "@/components/ui/Shimmer";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { AI_FRAME_DRAWING, type SigmaDocument } from "@/features/document";
import { findBlock } from "@/lib/document-tree";
import { useT } from "@/lib/i18n/react";
import { applyProblemFrameDrawing } from "@/lib/problem-frame";
import { addProblemFrameToLibrary, getProblemFrameLibrary } from "@/lib/problem-frame-library";

import {
  problemFrameChatStore,
  useProblemFrameChatNotices,
  useProblemFrameChatSessions,
} from "../application/problem-frame-chat-store";
import { isProblemFrameChatRunning, type ProblemFrameChatDrawing } from "../model/problem-frame-chat";
import { frameSvgDataUrl } from "./ProblemFrameChatTranscript";
import styles from "./ProblemFrameChat.module.css";

interface NoticesProps {
  documentIdentityKey: string | null | undefined;
  document: SigmaDocument;
  /** The editor's own block update, so a drawing lands on the problem the way the frame dialog puts it. */
  onChange: PageCanvasEditorProps["onChange"];
}

/**
 * What happens to a frame the reader asked the AI for and then closed the dialog on: a small status
 * while it is being drawn, and, when it is done, a dialog that says so. One notice at a time, for the
 * problems of this document; the drawing itself stays in the conversation, so dismissing the notice
 * never loses it.
 */
export function ProblemFrameChatNotices(props: NoticesProps) {
  return (
    <>
      <ProblemFrameChatBusy documentIdentityKey={props.documentIdentityKey} />
      <ProblemFrameChatNoticeDialog {...props} />
    </>
  );
}

/** Shown only while a run has nobody watching it: with the dialog open, the conversation is the status. */
function ProblemFrameChatBusy({ documentIdentityKey }: Pick<NoticesProps, "documentIdentityKey">) {
  const t = useT("settings");
  const sessions = useProblemFrameChatSessions();
  const working = [...sessions.values()].filter((session) =>
    session.documentIdentityKey === (documentIdentityKey ?? "")
    && isProblemFrameChatRunning(session)
    && !problemFrameChatStore.isWatched(session.key));
  if (working.length === 0) {
    return null;
  }
  return (
    <div className={styles.busy} role="status" data-testid="problem-custom-frame-ai-busy">
      <Shimmer>{t("problem.custom.notice.working")}</Shimmer>
      <IconButton
        label={t("problem.custom.aiStop")}
        tone="ghost"
        size="sm"
        onClick={() => working.forEach((session) => problemFrameChatStore.cancel(session.key))}
      >
        <Square size={12} fill="currentColor" aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function ProblemFrameChatNoticeDialog({ documentIdentityKey, document, onChange }: NoticesProps) {
  const t = useT("settings");
  const notices = useProblemFrameChatNotices();
  const notice = notices.find((candidate) => candidate.documentIdentityKey === (documentIdentityKey ?? ""));
  if (!notice) {
    return null;
  }

  const found = findBlock(document, notice.problemId);
  const problem = found?.type === "problem" ? found : null;
  const drawing = notice.drawing;
  const dismiss = () => problemFrameChatStore.dismissNotice(notice.id);
  const applyToProblem = (target: NonNullable<typeof problem>, applied: ProblemFrameChatDrawing) => {
    const options = { slice: AI_FRAME_DRAWING.slice };
    onChange(target.id, (block) => applyProblemFrameDrawing(block, applied, options));
    // The dialog keeps every frame it puts on a problem on the shelf too; do the same here.
    const custom = applyProblemFrameDrawing(target, applied, options).frame?.custom;
    if (custom) {
      addProblemFrameToLibrary(custom, t("problem.custom.libraryDefaultName", { number: getProblemFrameLibrary().length + 1 }));
    }
    problemFrameChatStore.markApplied(notice.key, notice.id);
  };
  const title = t(
    notice.kind === "drawn"
      ? "problem.custom.notice.drawnTitle"
      : notice.kind === "failed"
        ? "problem.custom.notice.failedTitle"
        : "problem.custom.notice.replyTitle",
  );

  return (
    <ModalFrame open onDismiss={dismiss} size="sm" ariaLabel={title}>
      <ModalHeader title={title} onClose={dismiss} />
      <ModalBody padding="xl">
        <Stack gap="lg" data-testid="problem-custom-frame-ai-notice">
          {notice.kind === "drawn" && <p className={styles.message}>{t("problem.custom.notice.drawnBody")}</p>}
          {drawing && (
            <div className={styles.noticePreview}>
              {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URL, not a fetched image */}
              <img
                className={styles.drawingImage}
                src={frameSvgDataUrl(drawing.svg)}
                alt={t("problem.custom.chat.drawingAlt")}
                width={drawing.width}
                height={drawing.height}
              />
            </div>
          )}
          {notice.message && <p className={styles.message}>{notice.message}</p>}
          {notice.error && <p role="alert" className={styles.error}>{notice.error}</p>}
          {drawing && <p className={styles.note}>{t("problem.custom.notice.keptNote")}</p>}
          <Inline justify="end" gap="sm">
            <Button size="md" onClick={dismiss}>{t("problem.custom.notice.close")}</Button>
            {drawing && problem && (
              <Button
                size="md"
                tone="primary"
                data-testid="problem-custom-frame-ai-notice-use"
                onClick={() => {
                  applyToProblem(problem, drawing);
                  dismiss();
                }}
              >
                {t("problem.custom.notice.useOnProblem")}
              </Button>
            )}
          </Inline>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
