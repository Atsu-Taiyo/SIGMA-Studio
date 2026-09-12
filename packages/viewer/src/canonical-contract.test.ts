import { describe, expectTypeOf, it } from "vitest";

import type {
  BoxDecorationSpec as CanonicalBoxDecorationSpec,
  InlineNode as CanonicalInlineNode,
  OverlayArrowhead as CanonicalOverlayArrowhead,
  OverlayShape as CanonicalOverlayShape,
  PageLayout as CanonicalPageLayout,
  PageOverlay as CanonicalPageOverlay,
  ProblemNode as CanonicalProblemNode,
  SigmaDocument as CanonicalSigmaDocument,
} from "@/features/document";

import type {
  BoxDecorationSpec as PublicBoxDecorationSpec,
  InlineNode as PublicInlineNode,
  PageLayout as PublicPageLayout,
  PageOverlay as PublicPageOverlay,
  ProblemNode as PublicProblemNode,
  SigmaDocument as PublicSigmaDocument,
} from "./types";
import type {
  OverlayArrowhead as PublicOverlayArrowhead,
  OverlayShape as PublicOverlayShape,
} from "./overlay-types";

describe("public SigmaDoc contract", () => {
  it("stays mutually assignable with the canonical document feature model", () => {
    expectTypeOf<
      PublicSigmaDocument extends CanonicalSigmaDocument ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CanonicalSigmaDocument extends PublicSigmaDocument ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      PublicPageLayout extends CanonicalPageLayout ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CanonicalPageLayout extends PublicPageLayout ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      PublicProblemNode extends CanonicalProblemNode ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CanonicalProblemNode extends PublicProblemNode ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      PublicInlineNode extends CanonicalInlineNode ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CanonicalInlineNode extends PublicInlineNode ? true : false
    >().toEqualTypeOf<true>();
  });

  /**
   * 箱の装飾は `BoxFrameSpec` の**任意プロパティの配列**の中に居るので、上の文書単位の
   * 突き合わせをすり抜ける (実測: `titleTab` を正典側だけに足しても `SigmaDocument` の
   * 相互代入は通ったまま)。装飾を 1 つ足すたびに写しを忘れる場所なので、ここで直接見る。
   */
  it("stays mutually assignable with the canonical box decorations", () => {
    expectTypeOf<
      PublicBoxDecorationSpec extends CanonicalBoxDecorationSpec ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CanonicalBoxDecorationSpec extends PublicBoxDecorationSpec ? true : false
    >().toEqualTypeOf<true>();
  });

  // The document-level assertions above already break when `overlay-types.ts` drifts, but they
  // break as "SigmaDocument is not assignable" — several layers away from the hand-copied enum
  // that actually moved. Pinning the overlay types directly names the culprit in the failure.
  it("stays mutually assignable with the canonical overlay model", () => {
    expectTypeOf<
      PublicOverlayArrowhead extends CanonicalOverlayArrowhead ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CanonicalOverlayArrowhead extends PublicOverlayArrowhead ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      PublicOverlayShape extends CanonicalOverlayShape ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CanonicalOverlayShape extends PublicOverlayShape ? true : false
    >().toEqualTypeOf<true>();
  });

  // Mutual assignability cannot see a field that exists on only one side when the field is
  // optional (structural subtyping accepts both directions), so removing `previewSvg` from
  // just one package would pass the assertions above. Comparing the key sets names the drift.
  it("exposes exactly the canonical page overlay fields", () => {
    expectTypeOf<keyof PublicPageOverlay>().toEqualTypeOf<keyof CanonicalPageOverlay>();
  });
});
