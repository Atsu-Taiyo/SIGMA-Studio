"use client";

import { BASE_EDITOR_FONT_SIZE,BASE_EDITOR_LINE_HEIGHT,BASE_EDITOR_TEXT_COLOR,DEFAULT_FONT_FAMILY_VALUE,TEXT_FORMAT_STATE_EVENT } from "@/components/editor/editor-shell/constants";
import { EMPTY_BLOCK_STYLE_TOOLBAR_STATE,nextBlockStyleToolbarState,normalizeBoxedTextVariant,normalizeToolbarFontFamily,type BlockStyleToolbarState } from "@/components/editor/editor-shell/toolbar-formatting";
import { isMultiEditorTextRunSpan,subscribeTextRunSpan } from "@/components/editor/text-flow/text-run-span";
import { isTextFormatTargetNodeType,type TextFormatStateContext } from "@/components/tiptap/text-format-controller";
import { normalizeLineHeight,type BoxedVariant,type LineHeight } from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useCallback,useEffect,useRef,useState } from "react";

export function useTextFormattingState() {
  /** `null` = run 自身の指定なし。ツールバーは「自動」と出し、見出しの大きさを潰さない。 */
  const [textFontSize, setTextFontSize] = useState<number | null>(BASE_EDITOR_FONT_SIZE);
  const [textFontSizeMixed, setTextFontSizeMixed] = useState(false);
  const [fontSizeInput, setFontSizeInput] = useState(String(BASE_EDITOR_FONT_SIZE));
  const [boxedTextPaddingY, setBoxedTextPaddingY] = useState(0);
  const [boxedTextActive, setBoxedTextActive] = useState(false);
  // B/I/U mirror the caret: the editors publish isActive() for each mark on every
  // transaction, so the buttons light up while the caret sits inside a bold run.
  const [boldActive, setBoldActive] = useState(false);
  const [italicActive, setItalicActive] = useState(false);
  const [underlineActive, setUnderlineActive] = useState(false);
  // ブロック種別のトグル (箇条書き / 番号付き / 引用 / コード)。B/I/U と同じで、キャレットが
  // そのブロックの中にいる間ボタンが点く。
  const [blockStyleState, setBlockStyleState] = useState<BlockStyleToolbarState>(
    EMPTY_BLOCK_STYLE_TOOLBAR_STATE,
  );
  const [documentTextFormatTarget, setDocumentTextFormatTarget] = useState<TextFormatStateContext | null>(null);
  // チャンクを跨ぐ本文選択 (text-run-span) の有無。跨ぎドラッグは mousedown/mouseup の
  // ターゲットが別エディタになるため、selectedId だけではリボンの書式ボタンの enable を
  // 表しきれない場面がある (⌘A 直後など)。span が生きている間は書式適用先が確実にあるので、
  // enable 判定へ直接効かせる。同値 setState は React が bail するので、ドラッグ中の
  // span 通知が毎フレーム来ても再レンダーは跨ぎ選択の開始/終了時しか起きない。
  const [hasMultiEditorTextRunSpan, setHasMultiEditorTextRunSpan] = useState(false);
  useEffect(() => subscribeTextRunSpan(() => {
    setHasMultiEditorTextRunSpan(isMultiEditorTextRunSpan());
  }), []);
  const [boxedTextVariant, setBoxedTextVariant] = useState<BoxedVariant>("frame");
  // The toolbar variant/padding state mirrors the current selection (reset to
  // frame/0 when an unboxed range is selected), so it can't carry "last used".
  // This ref persists the last format the user applied and seeds the next insert.
  const lastBoxedFormatRef = useRef<{ paddingY: number; variant: BoxedVariant }>({ paddingY: 0, variant: "frame" });
  const getLastBoxedFormat = useCallback(() => lastBoxedFormatRef.current, []);
  const rememberBoxedFormat = useCallback((patch: Partial<{ paddingY: number; variant: BoxedVariant }>) => { lastBoxedFormatRef.current = { ...lastBoxedFormatRef.current, ...patch }; }, []);
  const [textColor, setTextColor] = useState("#111111");
  const [textBackgroundColor, setTextBackgroundColor] = useState<string | null>("#fff3c2");
  const [strokeColor, setStrokeColor] = useState<string | null>("#000000");
  const preferredFontFamilyRef = useRef(DEFAULT_FONT_FAMILY_VALUE);
  const [fontFamily, setFontFamily] = useState(DEFAULT_FONT_FAMILY_VALUE);
  const [lineHeight, setLineHeight] = useState<LineHeight>("1.75");
  const [lineHeightInput, setLineHeightInput] = useState("1.75");
  const [lineHeightInputError, setLineHeightInputError] = useState<string | null>(null);
  const [lineHeightCustomOpen, setLineHeightCustomOpen] = useState(false);
  const saveEditorFontFamilyPreference = useCallback((nextFontFamily: string) => {
    preferredFontFamilyRef.current = nextFontFamily;
    const bridge = getDesktopBridge();
    if (!bridge?.app.saveEditorPreferences) {
      return;
    }
    bridge.app.saveEditorPreferences({ fontFamily: nextFontFamily }).catch((error) => {
      console.warn("Failed to save editor font preference", error);
    });
  }, []);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.app.getEditorPreferences) {
      return;
    }

    let canceled = false;
    bridge.app.getEditorPreferences()
      .then((preferences) => {
        if (!canceled && typeof preferences.fontFamily === "string") {
          const nextFontFamily = normalizeToolbarFontFamily(preferences.fontFamily);
          preferredFontFamilyRef.current = nextFontFamily;
          setFontFamily(nextFontFamily);
        }
      })
      .catch((error) => {
        console.warn("Failed to load editor font preference", error);
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const handleTextFormatState = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (!detail) {
        return;
      }

      if (detail.target === "document") {
        const nodeType = detail.nodeType;
        const blockId = typeof detail.blockId === "string" ? detail.blockId : null;
        const nextTarget =
          detail.enabled === true &&
          isTextFormatTargetNodeType(nodeType)
            ? { enabled: true as const, nodeType, blockId }
            : null;
        setDocumentTextFormatTarget((current) => (
          current?.enabled === nextTarget?.enabled &&
          current?.nodeType === nextTarget?.nodeType &&
          current?.blockId === nextTarget?.blockId
            ? current
            : nextTarget
        ));
      }
      setBoldActive(detail.bold === true);
      setItalicActive(detail.italic === true);
      setUnderlineActive(detail.underline === true);
      setBoxedTextActive(detail.boxed === true);
      setBoldActive(detail.bold === true);
      setItalicActive(detail.italic === true);
      setUnderlineActive(detail.underline === true);
      if (typeof detail.boxedPaddingY === "number" && Number.isFinite(detail.boxedPaddingY)) {
        setBoxedTextPaddingY(detail.boxedPaddingY);
      }
      setBoxedTextVariant(normalizeBoxedTextVariant(detail.boxedVariant) ?? "frame");
      setBlockStyleState((current) => nextBlockStyleToolbarState(current, detail));
      // The toolbar shows the font this position is actually drawn with. It used to fall back to
      // `preferredFontFamilyRef` — the last font picked from the dropdown, persisted in settings —
      // which is a different thing entirely the moment the caret moves somewhere the user did not
      // set by hand. That preference is still kept, just no longer used as the displayed value.
      if (detail.fontFamilyMixed === true) {
        setFontFamily("");
      } else if (typeof detail.fontFamily === "string") {
        setFontFamily(normalizeToolbarFontFamily(detail.fontFamily));
      }
      setTextFontSizeMixed(detail.fontSizeMixed === true);
      if (typeof detail.fontSize === "number" && Number.isFinite(detail.fontSize)) {
        setTextFontSize(detail.fontSize);
      } else if (detail.fontSize === null) {
        setTextFontSize(null);
      }
      if (typeof detail.color === "string") {
        setTextColor(detail.color);
      } else if (detail.color === null) {
        setTextColor(BASE_EDITOR_TEXT_COLOR);
      }
      if (typeof detail.backgroundColor === "string") {
        setTextBackgroundColor(detail.backgroundColor);
      } else if (detail.backgroundColor === null) {
        setTextBackgroundColor(null);
      }
      const nextLineHeight = normalizeLineHeight(detail.lineHeight);
      if (nextLineHeight) {
        setLineHeight(nextLineHeight);
      } else if (detail.lineHeight === null) {
        setLineHeight(BASE_EDITOR_LINE_HEIGHT);
      }
    };

    window.addEventListener(TEXT_FORMAT_STATE_EVENT, handleTextFormatState);
    return () => window.removeEventListener(TEXT_FORMAT_STATE_EVENT, handleTextFormatState);
  }, []);

  return { textFontSize, setTextFontSize, textFontSizeMixed, setTextFontSizeMixed, fontSizeInput, setFontSizeInput, boxedTextPaddingY, setBoxedTextPaddingY, boxedTextActive, setBoxedTextActive, boldActive, setBoldActive, italicActive, setItalicActive, underlineActive, setUnderlineActive, blockStyleState, setBlockStyleState, documentTextFormatTarget, setDocumentTextFormatTarget, hasMultiEditorTextRunSpan, setHasMultiEditorTextRunSpan, boxedTextVariant, setBoxedTextVariant, textColor, setTextColor, textBackgroundColor, setTextBackgroundColor, strokeColor, setStrokeColor, fontFamily, setFontFamily, lineHeight, setLineHeight, lineHeightInput, setLineHeightInput, lineHeightInputError, setLineHeightInputError, lineHeightCustomOpen, setLineHeightCustomOpen, getLastBoxedFormat, rememberBoxedFormat, saveEditorFontFamilyPreference };
}
