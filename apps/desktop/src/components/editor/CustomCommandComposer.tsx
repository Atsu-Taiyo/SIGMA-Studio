"use client";

import { Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { ColorPalette } from "@/components/editor/ColorPalette";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { Button, IconButton } from "@/components/ui/Button";
import { Select, type SelectItem } from "@/components/ui/Select";
import { normalizeLineHeight } from "@/features/document";
import {
  CUSTOM_BLOCK_STYLE_VALUES,
  formatCustomCommandDescription,
  type CustomBlockStyleValue,
  type EditorCommandId,
  type EditorCustomCommandAction,
  type ResolvedEditorCommand,
} from "@/lib/editor-command-shortcuts";
import { useT } from "@/lib/i18n/react";

type CustomActionKind = EditorCustomCommandAction["type"];

interface FontFamilyOption {
  label: string;
  value: string;
}

interface StepDraft {
  key: number;
  kind: CustomActionKind;
  value: string;
  color: string;
}

export interface CustomCommandComposerProps {
  fontFamilyOptions: readonly FontFamilyOption[];
  /** 「既存のコマンドを実行」で選べる組み込みコマンド (表示用に文言を解決済み)。 */
  builtInCommands: readonly ResolvedEditorCommand[];
  onSubmit: (input: { label: string; actions: EditorCustomCommandAction[] }) => void;
  /** 値が足りないなどで作れなかったとき。ダイアログのステータス行へ知らせるのは呼び出し側。 */
  onInvalid: () => void;
}

/**
 * 選べる操作の並び。グループは「何に効くか」で分け、上から順に文字 → 段落 → 図形 → その他。
 * 表示ラベルは `settings.commands.action.<kind>`、グループ名は `settings.commands.kindGroup.<id>`。
 */
const CUSTOM_ACTION_GROUPS: ReadonlyArray<{
  id: "text" | "paragraph" | "shape" | "other";
  kinds: readonly CustomActionKind[];
}> = [
  { id: "text", kinds: ["textFormat", "fontFamily", "fontSize", "textColor", "textBackgroundColor"] },
  { id: "paragraph", kinds: ["blockStyle", "textAlign", "lineHeight"] },
  { id: "shape", kinds: ["overlayStrokeColor", "overlayFillColor", "overlayLineDash", "overlayLineWidth"] },
  { id: "other", kinds: ["command"] },
];

const DEFAULT_TEXT_COLOR = "#111827";
const DEFAULT_HIGHLIGHT_COLOR = "#fff3c2";

/**
 * カスタムコマンドの作成欄。名前と「操作」の並びだけを持つ 1 枚のフォームで、開閉も段階もない。
 * 操作は 1 行 = 種類 + 値。複数行あれば上から順に実行される。
 */
export function CustomCommandComposer({
  fontFamilyOptions,
  builtInCommands,
  onSubmit,
  onInvalid,
}: CustomCommandComposerProps) {
  const t = useT("settings");
  const tCommand = useT("command");
  const createStep = (kind: CustomActionKind) => createStepDraft(kind, fontFamilyOptions, builtInCommands);
  const [label, setLabel] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>(() => [createStep("textFormat")]);

  const kindOptions = useMemo<SelectItem[]>(
    () => CUSTOM_ACTION_GROUPS.map((group) => ({
      label: t(`commands.kindGroup.${group.id}`),
      options: group.kinds.map((kind) => ({ value: kind, label: t(`commands.action.${kind}`) })),
    })),
    [t],
  );

  const updateStep = (key: number, patch: Partial<StepDraft>) => {
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  };

  const submit = () => {
    const actions: EditorCustomCommandAction[] = [];
    for (const step of steps) {
      const action = buildCustomCommandAction(step.kind, step.value, step.color);
      if (!action) {
        onInvalid();
        return;
      }
      actions.push(action);
    }

    // 名前が空なら操作の内容そのものを名前にする (「何をするコマンドか」が名前で読める)。
    const name = label.trim() || formatCustomCommandDescription(actions, tCommand);
    onSubmit({ label: name, actions });
    setLabel("");
    setSteps([createStep("textFormat")]);
  };

  return (
    <section className="custom-command-panel" aria-label={t("commands.customPanelAria")}>
      <div className="custom-command-heading">
        <strong>{t("commands.customPanelTitle")}</strong>
        <span>{t("commands.customPanelHint")}</span>
      </div>
      <input
        className="custom-command-name"
        value={label}
        aria-label={t("commands.customName")}
        onChange={(event) => setLabel(event.target.value)}
        placeholder={t("commands.customNamePlaceholder")}
      />
      <ol className="custom-command-steps">
        {steps.map((step, index) => (
          <li className="custom-command-step" key={step.key}>
            <span className="custom-command-step-number">{t("commands.customStep", { n: index + 1 })}</span>
            <Select
              aria-label={`${t("commands.customKind")} ${index + 1}`}
              value={step.kind}
              options={kindOptions}
              onChange={(kind) => {
                const nextKind = kind as CustomActionKind;
                updateStep(step.key, {
                  kind: nextKind,
                  value: defaultCustomActionValue(nextKind, fontFamilyOptions, builtInCommands),
                  color: defaultCustomActionColor(nextKind),
                });
              }}
            />
            <div className="custom-command-value-field">
              <CustomCommandValueField
                actionKind={step.kind}
                value={step.value}
                color={step.color}
                fontFamilyOptions={fontFamilyOptions}
                builtInCommands={builtInCommands}
                onValueChange={(value) => updateStep(step.key, { value })}
                onColorChange={(color) => updateStep(step.key, { color })}
              />
            </div>
            {steps.length > 1 ? (
              <IconButton
                label={t("commands.removeStep", { n: index + 1 })}
                tone="ghost"
                size="sm"
                onClick={() => setSteps((current) => current.filter((item) => item.key !== step.key))}
              >
                <X size={15} />
              </IconButton>
            ) : <span aria-hidden="true" />}
          </li>
        ))}
      </ol>
      <div className="custom-command-actions">
        <Button
          tone="secondary"
          onClick={() => setSteps((current) => [...current, createStep("textFormat")])}
        >
          <Plus size={15} />
          {t("commands.addStep")}
        </Button>
        <Button tone="primary" onClick={submit}>
          <Plus size={15} />
          {t("commands.add")}
        </Button>
      </div>
    </section>
  );
}

// 行の key。作り直しても再利用されなければよいので、コンポーネントの外で数える。
let stepKeySeed = 0;

function createStepDraft(
  kind: CustomActionKind,
  fontFamilyOptions: readonly FontFamilyOption[],
  builtInCommands: readonly ResolvedEditorCommand[],
): StepDraft {
  stepKeySeed += 1;
  return {
    key: stepKeySeed,
    kind,
    value: defaultCustomActionValue(kind, fontFamilyOptions, builtInCommands),
    color: defaultCustomActionColor(kind),
  };
}

function defaultCustomActionValue(
  kind: CustomActionKind,
  fontFamilyOptions: readonly FontFamilyOption[],
  builtInCommands: readonly ResolvedEditorCommand[],
): string {
  if (kind === "fontFamily") return fontFamilyOptions[0]?.value ?? "";
  if (kind === "fontSize") return "16";
  if (kind === "lineHeight") return "1.75";
  if (kind === "textAlign") return "center";
  if (kind === "blockStyle") return "h2";
  if (kind === "textFormat") return "bold";
  if (kind === "overlayLineDash") return "dashed";
  if (kind === "overlayLineWidth") return "m";
  if (kind === "command") return builtInCommands[0]?.id ?? "";
  // 色を持つ種類は「色を指定」から始める。
  return "color";
}

function defaultCustomActionColor(kind: CustomActionKind): string {
  return kind === "textBackgroundColor" || kind === "overlayFillColor"
    ? DEFAULT_HIGHLIGHT_COLOR
    : DEFAULT_TEXT_COLOR;
}

function buildCustomCommandAction(
  kind: CustomActionKind,
  value: string,
  color: string,
): EditorCustomCommandAction | null {
  if (kind === "fontFamily") {
    const fontFamily = value.trim();
    return fontFamily ? { type: "fontFamily", value: fontFamily } : null;
  }
  if (kind === "fontSize") {
    const size = Number(value);
    return value.trim() !== "" && Number.isFinite(size)
      ? { type: "fontSize", value: Math.min(96, Math.max(8, size)) }
      : null;
  }
  if (kind === "lineHeight") {
    const lineHeight = normalizeLineHeight(value);
    return lineHeight ? { type: "lineHeight", value: lineHeight } : null;
  }
  if (kind === "textAlign" && isOneOf(value, ["left", "center", "right", "justify"])) {
    return { type: "textAlign", value };
  }
  if (kind === "blockStyle" && isOneOf(value, CUSTOM_BLOCK_STYLE_VALUES)) {
    return { type: "blockStyle", value };
  }
  if (kind === "textFormat" && isOneOf(value, ["bold", "italic", "underline", "boxed"])) {
    return { type: "textFormat", command: value };
  }
  if (kind === "textColor") {
    return { type: "textColor", value: color };
  }
  if (kind === "textBackgroundColor") {
    return { type: "textBackgroundColor", value: value === "none" ? null : color };
  }
  if (kind === "overlayStrokeColor") {
    return { type: "overlayStrokeColor", value: value === "none" ? null : color };
  }
  if (kind === "overlayFillColor") {
    return { type: "overlayFillColor", value: value === "none" ? null : color };
  }
  if (kind === "overlayLineDash" && isOneOf(value, ["solid", "dashed", "dotted"])) {
    return { type: "overlayLineDash", value };
  }
  if (kind === "overlayLineWidth" && isOneOf(value, ["s", "m", "l", "xl"])) {
    return { type: "overlayLineWidth", value };
  }
  if (kind === "command" && value) {
    return { type: "command", commandId: value as EditorCommandId };
  }
  return null;
}

function isOneOf<const Value extends string>(value: string, candidates: readonly Value[]): value is Value {
  return (candidates as readonly string[]).includes(value);
}

function CustomCommandValueField({
  actionKind,
  value,
  color,
  fontFamilyOptions,
  builtInCommands,
  onValueChange,
  onColorChange,
}: {
  actionKind: CustomActionKind;
  value: string;
  color: string;
  fontFamilyOptions: readonly FontFamilyOption[];
  builtInCommands: readonly ResolvedEditorCommand[];
  onValueChange: (value: string) => void;
  onColorChange: (value: string) => void;
}) {
  const t = useT("settings");
  if (actionKind === "fontFamily") {
    const listId = "custom-command-font-families";
    return (
      <>
        <input
          list={listId}
          value={value}
          aria-label={t("commands.field.fontFamily")}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder='"Yu Mincho", serif'
        />
        <datalist id={listId}>
          {fontFamilyOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </datalist>
      </>
    );
  }

  if (actionKind === "fontSize") {
    return (
      <input
        type="number"
        min={8}
        max={96}
        step={1}
        value={value}
        aria-label={t("commands.field.fontSize")}
        onChange={(event) => onValueChange(event.target.value)}
      />
    );
  }

  if (actionKind === "lineHeight") {
    return (
      <input
        type="number"
        min={0.8}
        max={3}
        step={0.05}
        value={value}
        aria-label={t("commands.field.lineHeight")}
        onChange={(event) => onValueChange(event.target.value)}
      />
    );
  }

  if (actionKind === "textColor") {
    return <ColorValueField color={color} onColorChange={onColorChange} />;
  }

  if (actionKind === "textBackgroundColor" || actionKind === "overlayStrokeColor" || actionKind === "overlayFillColor") {
    const label = actionKind === "textBackgroundColor"
      ? t("commands.field.textBackground")
      : actionKind === "overlayStrokeColor" ? t("commands.field.stroke") : t("commands.field.fill");
    return (
      <>
        <Select
          aria-label={label}
          value={value === "none" ? "none" : "color"}
          options={[
            { value: "color", label: t("commands.field.colorSpecify") },
            { value: "none", label: t("commands.field.colorNone") },
          ]}
          onChange={onValueChange}
        />
        {value === "none" ? null : <ColorValueField color={color} onColorChange={onColorChange} />}
      </>
    );
  }

  if (actionKind === "textAlign") {
    return (
      <Select
        aria-label={t("commands.field.textAlign")}
        value={value}
        onChange={onValueChange}
        options={[
          { value: "left", label: t("commands.value.alignLeft") },
          { value: "center", label: t("commands.value.alignCenter") },
          { value: "right", label: t("commands.value.alignRight") },
          { value: "justify", label: t("commands.value.alignJustify") },
        ]}
      />
    );
  }

  if (actionKind === "blockStyle") {
    return (
      <Select
        aria-label={t("commands.field.blockStyle")}
        value={value}
        onChange={onValueChange}
        options={CUSTOM_BLOCK_STYLE_VALUES.map((style) => ({
          value: style,
          label: t(`commands.value.${BLOCK_STYLE_VALUE_KEYS[style]}`),
        }))}
      />
    );
  }

  if (actionKind === "textFormat") {
    return (
      <Select
        aria-label={t("commands.field.textFormat")}
        value={value}
        onChange={onValueChange}
        options={[
          { value: "bold", label: t("commands.value.formatBold") },
          { value: "italic", label: t("commands.value.formatItalic") },
          { value: "underline", label: t("commands.value.formatUnderline") },
          { value: "boxed", label: t("commands.value.formatBoxed") },
        ]}
      />
    );
  }

  if (actionKind === "overlayLineDash") {
    return (
      <Select
        aria-label={t("commands.field.lineDash")}
        value={value}
        onChange={onValueChange}
        options={[
          { value: "solid", label: t("commands.value.dashSolid") },
          { value: "dashed", label: t("commands.value.dashDashed") },
          { value: "dotted", label: t("commands.value.dashDotted") },
        ]}
      />
    );
  }

  if (actionKind === "overlayLineWidth") {
    return (
      <Select
        aria-label={t("commands.field.lineWidth")}
        value={value}
        onChange={onValueChange}
        options={[
          { value: "s", label: t("commands.value.widthS") },
          { value: "m", label: t("commands.value.widthM") },
          { value: "l", label: t("commands.value.widthL") },
          { value: "xl", label: t("commands.value.widthXl") },
        ]}
      />
    );
  }

  return (
    <BuiltInCommandField
      value={value}
      builtInCommands={builtInCommands}
      onValueChange={onValueChange}
    />
  );
}

const BLOCK_STYLE_VALUE_KEYS: Record<
  CustomBlockStyleValue,
  "blockParagraph" | "blockH1" | "blockH2" | "blockH3" | "blockBulletList" | "blockOrderedList" | "blockOrderedListParen" | "blockQuote" | "blockCode"
> = {
  paragraph: "blockParagraph",
  h1: "blockH1",
  h2: "blockH2",
  h3: "blockH3",
  bulletList: "blockBulletList",
  orderedList: "blockOrderedList",
  orderedListParen: "blockOrderedListParen",
  quote: "blockQuote",
  code: "blockCode",
};

/** 組み込みコマンドをカテゴリごとにまとめて選ぶ。 */
function BuiltInCommandField({
  value,
  builtInCommands,
  onValueChange,
}: {
  value: string;
  builtInCommands: readonly ResolvedEditorCommand[];
  onValueChange: (value: string) => void;
}) {
  const t = useT("settings");
  const options = useMemo<SelectItem[]>(() => {
    const groups: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [];
    for (const command of builtInCommands) {
      const option = { value: command.id, label: command.label };
      const group = groups.find((item) => item.label === command.category);
      if (group) {
        group.options.push(option);
      } else {
        groups.push({ label: command.category, options: [option] });
      }
    }
    return groups;
  }, [builtInCommands]);

  return (
    <Select
      aria-label={t("commands.field.command")}
      value={value}
      options={options}
      onChange={onValueChange}
    />
  );
}

/**
 * 色はOSのカラーパネルではなく、アプリ内の見本 + 色作成ダイアログから選ぶ
 * (docs/design-rules.md > Controls > Selects And Pickers)。
 */
function ColorValueField({
  color,
  onColorChange,
}: {
  color: string;
  onColorChange: (value: string) => void;
}) {
  const t = useT("settings");
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="custom-command-color-button"
        aria-label={t("commands.field.color")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="custom-command-color-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
        <code>{color}</code>
      </button>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        className="color-popover"
        ariaLabel={t("commands.field.color")}
        zIndex="var(--z-modal-nested)"
      >
        <ColorPalette
          value={color}
          onChange={(next) => {
            if (next) onColorChange(next);
            setOpen(false);
          }}
        />
      </ToolbarPopover>
    </>
  );
}
