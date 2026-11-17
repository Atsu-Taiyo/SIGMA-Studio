/** One pending surface may use this budget across asset loading and layout settling. */
export const PRINT_PREPARATION_TIMEOUT_MS = 55_000;
/** Leave time for page loading and the final stable-revision check. */
export const PRINT_PREVIEW_TIMEOUT_MS = 65_000;
/** Must finish before a plugin's 75-second calibration budget expires. */
export const DOCUMENT_MEASUREMENT_TIMEOUT_MS = 70_000;
