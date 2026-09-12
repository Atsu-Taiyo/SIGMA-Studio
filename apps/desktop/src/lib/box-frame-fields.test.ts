import { describe, expect, it } from "vitest";

import { createBoxBlock, mergeBoxFrame, resolveBoxFrame } from "@/lib/box-blocks";
import {
  boxFrameFields,
  type BoxFrameChoiceField,
  type BoxFrameColorField,
  type BoxFrameField,
} from "@/lib/box-frame-fields";
import { createTranslator } from "@/lib/i18n";

const LOCALES = ["ja", "en"] as const;

function fieldsFor(styleId: string): BoxFrameField[] {
  return boxFrameFields(resolveBoxFrame(createBoxBlock(styleId)));
}

function ids(styleId: string): string[] {
  return fieldsFor(styleId).map((field) => field.id);
}

function fieldById(styleId: string, id: string): BoxFrameField {
  const field = fieldsFor(styleId).find((candidate) => candidate.id === id);
  if (!field) {
    throw new Error(`no field ${id} for ${styleId}`);
  }
  return field;
}

function colorField(styleId: string, id: string): BoxFrameColorField {
  const field = fieldById(styleId, id);
  if (field.kind !== "color") {
    throw new Error(`${id} is not a color field`);
  }
  return field;
}

function choiceField(styleId: string, id: string): BoxFrameChoiceField {
  const field = fieldById(styleId, id);
  if (field.kind !== "choice") {
    throw new Error(`${id} is not a choice field`);
  }
  return field;
}

describe("箱の見た目で決められる項目", () => {
  it("offers the same colors to every style, and the decoration rows each style actually has", () => {
    // 装飾を持たない箱でも、色と枠線の種類はいつでも決められる。
    expect(ids("fancybox")).toEqual([
      "backgroundColor",
      "borderColor",
      "borderStyle",
      "titleColor",
      "titleFontWeight",
      "bodyColor",
    ]);

    expect(ids("titlebox")).toContain("titleBackgroundColor");
    expect(ids("titlebox")).toEqual(expect.arrayContaining([
      "titleBand.heightPx",
      "titleBand.ruleWidthPx",
      "titleBand.ruleColor",
    ]));

    expect(ids("tabbox")).toEqual(expect.arrayContaining([
      "titleBackgroundColor",
      "titleTab.heightPx",
      "titleTab.radiusPx",
      "titleTab.offsetXPx",
    ]));

    expect(ids("theorembox")).toEqual(expect.arrayContaining(["leftBar.widthPx", "leftBar.color"]));
    expect(ids("doublebox")).toEqual(expect.arrayContaining(["doubleRule.color"]));
    expect(ids("ruledbox")).toEqual(expect.arrayContaining(["horizontalRules.color"]));
    expect(ids("tcolorbox-note")).toEqual(expect.arrayContaining([
      "notebookRules.bindingColor",
      "notebookRules.ringColor",
    ]));

    // 帯もタブも無い箱に「タイトルの地色」は出さない (どこにも塗られないため)。
    expect(ids("fancybox")).not.toContain("titleBackgroundColor");
  });

  it("writes a decoration color without dropping the other decorations", () => {
    // cornerbox は装飾を 2 つ持つ。片方を書き換えたときにもう片方が消えないこと。
    const frame = resolveBoxFrame(createBoxBlock("cornerbox"));
    const field = colorField("cornerbox", "cornerSquares.color");
    const patched = mergeBoxFrame(frame, field.patch("#2563eb") as never);

    expect(patched.decorations?.map((decoration) => decoration.type))
      .toEqual(frame.decorations?.map((decoration) => decoration.type));
    expect(patched.decorations?.find((decoration) => decoration.type === "cornerSquares"))
      .toMatchObject({ color: "#2563eb" });
    expect(patched.decorations?.find((decoration) => decoration.type === "titleDoubleRule"))
      .toMatchObject({ ruleColor: "#111111" });
  });

  it("puts the title background on the frame, where it beats the decoration's own color", () => {
    // `boxFrameStyleVars` は枠の値を装飾より先に読む。1 つのフィールドで帯もタブも塗れる。
    const field = colorField("titlebox", "titleBackgroundColor");

    expect(field.patch("#fde68a")).toEqual({ titleBackgroundColor: "#fde68a" });
  });

  it("keeps the border style on the enum the schema allows", () => {
    const field = choiceField("dashedbox", "borderStyle");

    expect(field.value).toBe("dashed");
    expect(field.patch("dotted")).toEqual({ borderStyle: "dotted" });
    expect(field.patch("わからない")).toEqual({ borderStyle: "solid" });
  });

  it("names every field in both languages", () => {
    // 一覧はデータなので、辞書を足し忘れると画面に生キーが出る。全スタイル分を回して塞ぐ。
    const styleIds = ["fancybox", "titlebox", "bandbox", "itembox", "theorembox", "tabbox",
      "tcolorbox", "tcolorbox-note", "doublebox", "shadebox", "leftbar", "dashedbox",
      "ruledbox", "screenbox", "ovalbox", "cornerbox"];
    for (const locale of LOCALES) {
      const t = createTranslator(locale, "settings");
      for (const styleId of styleIds) {
        for (const field of fieldsFor(styleId)) {
          const label = t(`box.field.${field.id}` as never) as string;
          expect(label, `${locale} / ${field.id}`).not.toBe("");
          expect(label, `${locale} / ${field.id}`).not.toContain("box.field.");
          if (field.kind === "choice") {
            for (const option of field.options) {
              const optionLabel = t(`box.fieldOption.${option}` as never) as string;
              expect(optionLabel, `${locale} / ${option}`).not.toContain("box.fieldOption.");
            }
          }
        }
      }
    }
  });
});
