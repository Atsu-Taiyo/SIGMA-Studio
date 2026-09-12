/**
 * HTML escaping for the SVG serializer.
 *
 * This file used to hold a second, string-based projection of overlay rich text beside the React
 * one; both now go through the same components, so what is left is the escaping the serializer
 * needs for the attributes and text it writes itself.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
