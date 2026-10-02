"use client";

import { MAX_LINE_HEIGHT,MIN_LINE_HEIGHT,normalizeLineHeight,stepLineHeight } from "@/features/document";
import { createTranslator } from "@/lib/i18n";
import type { MouseEvent,PointerEvent as ReactPointerEvent } from "react";
import { useCallback,useEffect,useRef } from "react";

interface LineHeightPorts {
  enabled: boolean;
  lineHeight: string;
  menuOpen: boolean;
  customOpen: boolean;
  setLineHeight: (value: string) => void;
  setLineHeightInput: (value: string) => void;
  setLineHeightInputError: (value: string | null) => void;
  applyFormat: (command: "lineHeight", value: string) => void;
  t: ReturnType<typeof createTranslator<"chrome">>;
}
export function useLineHeightControl({ enabled: canUseLineHeight, lineHeight, menuOpen: lineHeightMenuOpen, customOpen: lineHeightCustomOpen, setLineHeight, setLineHeightInput, setLineHeightInputError, applyFormat: applyInlineFormat, t }: LineHeightPorts) {
  const lineHeightStepDelayTimerRef = useRef<number | null>(null);
  const lineHeightStepRepeatTimerRef = useRef<number | null>(null);
  const lineHeightStepCurrentRef = useRef<string | null>(null);
  const LINE_HEIGHT_LONG_PRESS_DELAY_MS = 400;
  const LINE_HEIGHT_LONG_PRESS_INTERVAL_MS = 120;
  const applyLineHeight = (nextLineHeightValue: string, options: { updateInput?: boolean } = {}): boolean => {
    if (!canUseLineHeight) {
      return false;
    }

    const nextLineHeight = normalizeLineHeight(nextLineHeightValue);
    if (!nextLineHeight) {
      setLineHeightInputError(t("format.lineHeight.inputError", { min: MIN_LINE_HEIGHT, max: MAX_LINE_HEIGHT }));
      return false;
    }

    setLineHeight(nextLineHeight);
    if (options.updateInput !== false) {
      setLineHeightInput(nextLineHeight);
    }
    setLineHeightInputError(null);
    applyInlineFormat("lineHeight", nextLineHeight);
    return true;
  };

  const stopLineHeightStepping = useCallback(() => {
    if (lineHeightStepDelayTimerRef.current !== null) {
      window.clearTimeout(lineHeightStepDelayTimerRef.current);
      lineHeightStepDelayTimerRef.current = null;
    }
    if (lineHeightStepRepeatTimerRef.current !== null) {
      window.clearInterval(lineHeightStepRepeatTimerRef.current);
      lineHeightStepRepeatTimerRef.current = null;
    }
    lineHeightStepCurrentRef.current = null;
  }, []);

  const applyLineHeightStep = (direction: "increase" | "decrease"): boolean => {
    const currentLineHeight = lineHeightStepCurrentRef.current ?? lineHeight;
    const nextLineHeight = stepLineHeight(currentLineHeight, direction);
    if (nextLineHeight === currentLineHeight) {
      stopLineHeightStepping();
      return false;
    }
    lineHeightStepCurrentRef.current = nextLineHeight;
    return applyLineHeight(nextLineHeight);
  };

  const startLineHeightStepping = (event: ReactPointerEvent<HTMLButtonElement>, direction: "increase" | "decrease") => {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }
    event.preventDefault();
    stopLineHeightStepping();
    if (!applyLineHeightStep(direction)) {
      return;
    }
    lineHeightStepDelayTimerRef.current = window.setTimeout(() => {
      lineHeightStepDelayTimerRef.current = null;
      if (!applyLineHeightStep(direction)) {
        return;
      }
      lineHeightStepRepeatTimerRef.current = window.setInterval(() => {
        applyLineHeightStep(direction);
      }, LINE_HEIGHT_LONG_PRESS_INTERVAL_MS);
    }, LINE_HEIGHT_LONG_PRESS_DELAY_MS);
  };

  const handleLineHeightStepClick = (event: MouseEvent<HTMLButtonElement>, direction: "increase" | "decrease") => {
    if (event.detail === 0) {
      applyLineHeightStep(direction);
    }
  };

  useEffect(() => stopLineHeightStepping, [stopLineHeightStepping]);

  useEffect(() => {
    if (!lineHeightMenuOpen || !lineHeightCustomOpen) {
      stopLineHeightStepping();
    }
  }, [lineHeightCustomOpen, lineHeightMenuOpen, stopLineHeightStepping]);

  return { applyLineHeight, startLineHeightStepping, handleLineHeightStepClick, stopLineHeightStepping };
}
