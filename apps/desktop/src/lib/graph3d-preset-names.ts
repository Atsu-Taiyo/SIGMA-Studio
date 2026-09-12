import type { Graph3DPresetNames } from "@/features/drawing";
import type { Translate } from "@/lib/i18n";

export function buildGraph3DPresetNames(t: Translate<"shape">): Graph3DPresetNames {
  return {
    surface: t("graph3dPresetName.surface"),
    surfacePlane: t("graph3dPresetName.surfacePlane"),
    surfaceContour: t("graph3dPresetName.surfaceContour"),
    cutHeight: t("graph3dPresetName.cutHeight"),
    cylinderZ: t("graph3dPresetName.cylinderZ"),
    cylinderX: t("graph3dPresetName.cylinderX"),
    cylinderY: t("graph3dPresetName.cylinderY"),
    cutPlaneH: t("graph3dPresetName.cutPlaneH"),
    tricylinderIntersection: t("graph3dPresetName.tricylinderIntersection"),
    cylinderZPlane: t("graph3dPresetName.cylinderZPlane"),
    cylinderXPlane: t("graph3dPresetName.cylinderXPlane"),
    cylinderYPlane: t("graph3dPresetName.cylinderYPlane"),
    intersectionSection: t("graph3dPresetName.intersectionSection"),
    sphereRadius: t("graph3dPresetName.sphereRadius"),
    tetrahedron: t("graph3dPresetName.tetrahedron"),
    sphere: t("graph3dPresetName.sphere"),
    tetrahedronSphereIntersection: t("graph3dPresetName.tetrahedronSphereIntersection"),
    sectionHeight: t("graph3dPresetName.sectionHeight"),
    revolution: t("graph3dPresetName.revolution"),
    cutPlaneS: t("graph3dPresetName.cutPlaneS"),
    section: t("graph3dPresetName.section"),
  };
}
