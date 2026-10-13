"use client";

import { useCallback, useState } from "react";

import type { AiImageAnnotation } from "@/lib/ai/ai-image-annotations";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";

import { MAX_AI_EDIT_ATTACHMENTS } from "./ai-chat-attachments";

export interface AiPendingAttachmentsController {
  attachments: AiEditAttachment[];
  add: (attachment: AiEditAttachment) => void;
  remove: (attachmentId: string) => void;
  /** 画像の中に付けたコメントを差し替える。 */
  setAnnotations: (attachmentId: string, annotations: AiImageAnnotation[]) => void;
  clear: () => void;
}

/** 古いものから押し出して、添付の上限に収める (最後に撮った画像を優先する)。 */
export function appendPendingAttachment(
  current: readonly AiEditAttachment[],
  next: AiEditAttachment,
): AiEditAttachment[] {
  return [...current.filter((attachment) => attachment.id !== next.id), next].slice(-MAX_AI_EDIT_ATTACHMENTS);
}

/** 添付の注記を差し替える。空にしたら項目ごと外し、注記の無い添付と同じ形に戻す。 */
export function withAttachmentAnnotations<T extends { id: string; annotations?: AiImageAnnotation[] }>(
  current: readonly T[],
  attachmentId: string,
  annotations: AiImageAnnotation[],
): T[] {
  let changed = false;
  const next = current.map((attachment) => {
    if (attachment.id !== attachmentId) {
      return attachment;
    }
    changed = true;
    if (annotations.length > 0) {
      return { ...attachment, annotations };
    }
    const rest = { ...attachment };
    delete rest.annotations;
    return rest;
  });
  return changed ? next : [...current];
}

/**
 * 入力欄の外で用意された添付 (範囲スクリーンショットの「AIに聞く」) の置き場。
 *
 * 入力欄は会話の切り替えやパネルの開き直しで下書きを作り直すので、その下書きの中には入れない。
 * 送信するか、×で外すか、AI面を閉じるまで、ここに残して入力欄へ差し込む。
 */
export function useAiPendingAttachments(): AiPendingAttachmentsController {
  const [attachments, setAttachments] = useState<AiEditAttachment[]>([]);
  const add = useCallback((attachment: AiEditAttachment) => {
    setAttachments((current) => appendPendingAttachment(current, attachment));
  }, []);
  const remove = useCallback((attachmentId: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }, []);
  const setAnnotations = useCallback((attachmentId: string, annotations: AiImageAnnotation[]) => {
    setAttachments((current) => withAttachmentAnnotations(current, attachmentId, annotations));
  }, []);
  const clear = useCallback(() => {
    setAttachments((current) => (current.length === 0 ? current : []));
  }, []);
  return { attachments, add, remove, setAnnotations, clear };
}
