import type { common as ja } from "../ja/common";
import type { TranslationsOf } from "../types";

/** 対応する日本語 namespace と同時に埋める。詳細は `../ja/common.ts` を参照。 */
export const common = {
  actions: {
    ok: "OK",
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    delete: "Delete",
    add: "Add",
    edit: "Edit",
    apply: "Apply",
    retry: "Retry",
    back: "Back",
    next: "Next",
    details: "Details",
  },
  shortcutAria: "Shortcut {{shortcut}}",
  color: {
    paletteAria: "Choose a color",
    standard: "Standard colors",
    custom: "Custom",
    customEmpty: "None yet",
    create: "Create a color",
    createWithOpacity: "Create a color and opacity",
    transparent: "Transparent",
    presetSimpleLight: "Simple (light)",
    mixed: "Mixed",
    noFill: "No fill",
    opacityPercent: "Opacity {{percent}}%",
    hue: "Hue",
    saturationValue: "Saturation and brightness",
    saturationValueText: "Saturation {{saturation}}%, brightness {{value}}%",
    opacity: "Opacity",
    opacityInput: "Opacity (%)",
    hex: "Hex code",
    red: "Red",
    green: "Green",
    blue: "Blue",
  },
  status: {
    loading: "Loading…",
    saving: "Saving…",
    saved: "Saved",
    error: "Something went wrong",
  },
} satisfies TranslationsOf<typeof ja>;
