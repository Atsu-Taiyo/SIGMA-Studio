"use client";
import { Trash2 } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import {
  createAiImageAnnotationId,
  createAiImageAnnotationShape,
  isAiImageAnnotationRegion,
  MAX_AI_IMAGE_ANNOTATION_COMMENT_LENGTH,
  MAX_AI_IMAGE_ANNOTATIONS,
  normalizeAiImageAnnotations,
  type AiImageAnnotation,
} from "@/lib/ai/ai-image-annotations";
import { useT } from "@/lib/i18n/react";
import type { AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import { OverlayPreviewSvg } from "./AiChatPreviewImages";
import { AiImageAnnotationMarks, type AiImageAnnotationShape } from "./AiImageAnnotationMarks";
import styles from "./AiImageAnnotation.module.css";

export interface AiImageAnnotationDialogProps {
  /** data URL など、そのまま `<img>` に渡せる画像。 */
  src: string;
  /**
   * 選択図形のプレビュー。グラフや文字は foreignObject の中を紙面のCSSで描くので、`<img>` では
   * 白紙になる。入力欄のサムネと同じく、文書の中へそのまま描いて見せる。
   */
  shapePreview?: AiEditShapeOnlyPreview;
  name: string;
  naturalSize?: { width: number; height: number } | null;
  annotations: readonly AiImageAnnotation[];
  /** 追加・編集・削除のたびに呼ぶ (閉じたときにまとめて確定しない)。 */
  onChange: (annotations: AiImageAnnotation[]) => void;
  onClose: () => void;
}

interface Point {
  x: number;
  y: number;
}

interface Draft {
  /** 既存の注記を直しているときはそのid。新しい注記は null。 */
  id: string | null;
  shape: AiImageAnnotationShape;
  text: string;
}

const DIALOG_BADGE_RADIUS = 11;
/** 書きかけのカードと注記の間 (px)。番号の丸と重ならない距離。 */
const CARD_GAP = 14;
const STAGE_EDGE = 8;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 書きかけのカードを注記のすぐ下 (入らなければ上) に置き、段の左右からはみ出さないよう寄せる。
 * 測ってから置くので、位置が決まるまでは見せない (CSS の既定は visibility: hidden)。
 */
function placeCommentCard(stage: HTMLElement, frame: HTMLElement, card: HTMLElement, shape: AiImageAnnotationShape): void {
  const frameWidth = frame.offsetWidth;
  const frameHeight = frame.offsetHeight;
  const anchorX = frame.offsetLeft + shape.x * frameWidth;
  const shapeTop = frame.offsetTop + shape.y * frameHeight;
  const shapeBottom = frame.offsetTop + (shape.y + (shape.height ?? 0)) * frameHeight;
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const left = Math.min(
    Math.max(STAGE_EDGE, anchorX - DIALOG_BADGE_RADIUS),
    Math.max(STAGE_EDGE, stage.clientWidth - cardWidth - STAGE_EDGE),
  );
  const stageHeight = stage.clientHeight;
  const below = shapeBottom + CARD_GAP;
  const above = shapeTop - DIALOG_BADGE_RADIUS * 3 - CARD_GAP - cardHeight;
  const fitsBelow = below + cardHeight <= stageHeight - STAGE_EDGE;
  const fitsAbove = above >= STAGE_EDGE;
  // どちらにも入らなければ、空きの大きい側に寄せて段の中へ収める。
  const preferred = fitsBelow || (!fitsAbove && stageHeight - shapeBottom >= shapeTop) ? below : above;
  const top = Math.min(
    Math.max(STAGE_EDGE, preferred),
    Math.max(STAGE_EDGE, stageHeight - cardHeight - STAGE_EDGE),
  );
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.visibility = "visible";
}

/** 画像の中の場所を選んでコメントを付ける画面。注記は呼び出し側が持ち、ここは編集だけを担う。 */
export function AiImageAnnotationDialog({
  src,
  shapePreview,
  name,
  naturalSize = null,
  annotations,
  onChange,
  onClose,
}: AiImageAnnotationDialogProps) {
  const t = useT("ai");
  const tCommon = useT("common");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<{ pointerId: number; start: Point; current: Point } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loadedSize, setLoadedSize] = useState<{ width: number; height: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageSize = loadedSize ?? naturalSize;
  const limitReached = annotations.length >= MAX_AI_IMAGE_ANNOTATIONS;
  const draftIndex = draft
    ? (draft.id ? annotations.findIndex((annotation) => annotation.id === draft.id) : annotations.length)
    : -1;

  const commitDraft = (current: Draft | null = draft) => {
    if (!current) {
      return;
    }
    const comment = current.text.trim();
    if (comment.length > 0) {
      const next = current.id
        ? annotations.map((annotation) => (annotation.id === current.id ? { ...annotation, comment } : annotation))
        : [...annotations, { id: createAiImageAnnotationId(), ...current.shape, comment }];
      onChange(normalizeAiImageAnnotations(next));
    }
    setDraft(null);
  };

  const removeAnnotation = (annotationId: string) => {
    onChange(annotations.filter((annotation) => annotation.id !== annotationId));
    if (draft?.id === annotationId) {
      setDraft(null);
    }
    setHoveredId((current) => (current === annotationId ? null : current));
  };

  const openExisting = (annotationId: string) => {
    if (draft && draft.id !== annotationId && draft.text.trim()) {
      commitDraft();
    }
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation) {
      return;
    }
    setDraft({
      id: annotation.id,
      shape: isAiImageAnnotationRegion(annotation)
        ? { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height }
        : { x: annotation.x, y: annotation.y },
      text: annotation.comment,
    });
  };

  const toImagePoint = (event: ReactPointerEvent<HTMLElement>): Point | null => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: clampUnit((event.clientX - rect.left) / rect.width),
      y: clampUnit((event.clientY - rect.top) / rect.height),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    // 書きかけがあれば、文字が入っていれば残し、空なら捨ててから次の場所を選ぶ。
    const addsDraft = Boolean(draft && !draft.id && draft.text.trim());
    if (draft) {
      commitDraft();
    }
    if (annotations.length + (addsDraft ? 1 : 0) >= MAX_AI_IMAGE_ANNOTATIONS) {
      return;
    }
    const point = toImagePoint(event);
    if (!point) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, start: point, current: point });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const point = toImagePoint(event);
    if (point) {
      setDrag({ ...drag, current: point });
    }
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const end = cancelled ? drag.start : (toImagePoint(event) ?? drag.current);
    setDrag(null);
    if (cancelled) {
      return;
    }
    setDraft({ id: null, shape: createAiImageAnnotationShape(drag.start, end), text: "" });
  };

  // 書きかけのカードを開いたら、すぐ打てるよう入力欄へ焦点を置く。
  const draftKey = draft ? `${draft.id ?? "new"}:${draft.shape.x}:${draft.shape.y}` : null;
  useEffect(() => {
    if (!draftKey) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, [draftKey]);

  // 書きかけのカードを置く (`placeCommentCard`)。窓の大きさ・画像の枠・入力欄の高さ (つまみで伸ばしたとき) が変わったら置き直す。
  const draftShape = draft?.shape ?? null;
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    const card = cardRef.current;
    if (!draftShape || !stage || !frame || !card) {
      return;
    }
    const place = () => placeCommentCard(stage, frame, card, draftShape);
    place();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(place);
    observer.observe(stage);
    observer.observe(frame);
    observer.observe(card);
    return () => observer.disconnect();
  }, [draftShape, imageSize]);

  const handleTextareaKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
      return;
    }
    if (event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitDraft();
    }
  };

  const dragShape = drag ? createAiImageAnnotationShape(drag.start, drag.current) : null;
  const pendingMark = draft && !draft.id
    ? { shape: draft.shape, index: annotations.length }
    : dragShape
      ? { shape: dragShape, index: annotations.length }
      : null;
  const activeId = draft?.id ?? hoveredId;
  const imageAspect = imageSize ? imageSize.width / Math.max(1, imageSize.height) : null;

  return (
    <ModalFrame
      open
      size="xl"
      onDismiss={() => {
        commitDraft();
        onClose();
      }}
      closeOnEscape={!draft && !drag}
      surfaceClassName={styles.dialog}
      data-ai-image-annotation-dialog=""
    >
      <ModalHeader
        title={t("imageAnnotation.title")}
        description={t("imageAnnotation.hint")}
        onClose={() => {
          commitDraft();
          onClose();
        }}
      />
      <ModalBody padding="none" className={styles.body}>
        <div className={styles.layout}>
          <div ref={stageRef} className={styles.stage} role="group" aria-label={t("imageAnnotation.stageAria")}>
            <div
              ref={frameRef}
              className={styles.frame}
              style={imageAspect
                ? {
                  "--ai-image-annotation-frame-width": `min(100%, calc(var(--ai-image-annotation-stage-max-height) * ${imageAspect}))`,
                  "--ai-image-annotation-image-width": "100%",
                } as CSSProperties
                : undefined}
            >
              {shapePreview && imageAspect ? (
                <OverlayPreviewSvg
                  preview={shapePreview}
                  className={`${styles.image} ${styles.svgImage}`}
                  aria-label={name}
                  style={{ aspectRatio: `${imageAspect}` }}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- data URL の添付画像をそのまま見せる
                <img
                  className={styles.image}
                  src={src}
                  alt={name}
                  draggable={false}
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } = event.currentTarget;
                    if (naturalWidth > 0 && naturalHeight > 0) {
                      setLoadedSize({ width: naturalWidth, height: naturalHeight });
                    }
                  }}
                />
              )}
              <div
                ref={surfaceRef}
                className={styles.surface}
                data-ai-image-annotation-surface=""
                data-limit-reached={limitReached ? "true" : undefined}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => finishDrag(event, false)}
                onPointerCancel={(event) => finishDrag(event, true)}
              />
              <AiImageAnnotationMarks
                annotations={annotations}
                badgeRadius={DIALOG_BADGE_RADIUS}
                activeId={activeId}
                draft={pendingMark}
                onSelect={openExisting}
                onHover={setHoveredId}
              />
            </div>
            {draft && (
              <div
                ref={cardRef}
                className={styles.card}
                role="group"
                aria-label={t("imageAnnotation.mark", { replace: { index: draftIndex + 1 } })}
              >
                <span className={styles.cardBadge} aria-hidden="true">{draftIndex + 1}</span>
                <textarea
                  ref={textareaRef}
                  className={styles.cardInput}
                  rows={3}
                  value={draft.text}
                  maxLength={MAX_AI_IMAGE_ANNOTATION_COMMENT_LENGTH}
                  placeholder={t("imageAnnotation.placeholder")}
                  aria-label={t("imageAnnotation.mark", { replace: { index: draftIndex + 1 } })}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    setDraft((current) => (current ? { ...current, text } : current));
                  }}
                  onKeyDown={handleTextareaKeyDown}
                />
                <div className={styles.cardActions}>
                  {draft.id ? (
                    <IconButton
                      label={t("imageAnnotation.delete")}
                      tone="ghost"
                      size="sm"
                      onClick={() => draft.id && removeAnnotation(draft.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </IconButton>
                  ) : null}
                  <span className={styles.cardSpacer} />
                  <Button tone="ghost" size="sm" onClick={() => setDraft(null)}>
                    {tCommon("actions.cancel")}
                  </Button>
                  <Button tone="primary" size="sm" disabled={draft.text.trim().length === 0} onClick={() => commitDraft()}>
                    {draft.id ? tCommon("actions.save") : tCommon("actions.add")}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <aside className={styles.panel} aria-label={t("imageAnnotation.listTitle")}>
            <div className={styles.panelTitle}>
              <span>{t("imageAnnotation.listTitle")}</span>
              {annotations.length > 0 ? <span className={styles.panelCount}>{annotations.length}</span> : null}
            </div>
            {annotations.length === 0 ? (
              <p className={styles.empty}>{t("imageAnnotation.empty")}</p>
            ) : (
              <ol className={styles.list}>
                {annotations.map((annotation, index) => (
                  <li
                    key={annotation.id}
                    className={styles.listItem}
                    data-active={annotation.id === activeId ? "true" : undefined}
                    onMouseEnter={() => setHoveredId(annotation.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <button
                      type="button"
                      className={styles.listMain}
                      aria-label={t("imageAnnotation.edit", { replace: { index: index + 1 } })}
                      onClick={() => openExisting(annotation.id)}
                    >
                      <span className={styles.listBadge} aria-hidden="true">{index + 1}</span>
                      <span className={styles.listText}>{annotation.comment}</span>
                    </button>
                    <IconButton
                      label={t("imageAnnotation.delete")}
                      tone="ghost"
                      size="sm"
                      onClick={() => removeAnnotation(annotation.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </IconButton>
                  </li>
                ))}
              </ol>
            )}
            {limitReached ? (
              <p className={styles.limit}>{t("imageAnnotation.limit", { replace: { max: MAX_AI_IMAGE_ANNOTATIONS } })}</p>
            ) : null}
          </aside>
        </div>
      </ModalBody>
      <footer className={styles.footer}>
        <Button
          tone="primary"
          onClick={() => {
            commitDraft();
            onClose();
          }}
        >
          {t("imageAnnotation.done")}
        </Button>
      </footer>
    </ModalFrame>
  );
}
