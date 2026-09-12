import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Drives the app's own dropdown (`@/components/ui/Select`).
 *
 * The list is not a native `<select>`, so `selectOption` cannot reach it: the options live in a
 * portalled listbox that only exists while the control is open. Options are addressed by value,
 * the same way `selectOption` addressed them.
 */
export async function selectUiOption(trigger: Locator, value: string): Promise<void> {
  await expect(trigger).toBeEnabled();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  const listboxId = await trigger.getAttribute("aria-controls");
  expect(listboxId, "開いた Select が listbox を持っていません").toBeTruthy();
  await trigger.page().locator(`#${listboxId} [role="option"][data-value="${value}"]`).click();
}

/** Opens the dropdown, pins the labels it offers, then closes it again. */
export async function expectUiSelectOptions(trigger: Locator, labels: string[]): Promise<void> {
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  const listboxId = await trigger.getAttribute("aria-controls");
  expect(listboxId, "開いた Select が listbox を持っていません").toBeTruthy();
  await expect(trigger.page().locator(`#${listboxId} [role="option"]`)).toHaveText(labels);
  await trigger.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

/** Asserts the closed control's current value (there is no `toHaveValue` for a non-input). */
export async function expectUiSelectValue(trigger: Locator, value: string): Promise<void> {
  await expect(trigger).toHaveAttribute("data-value", value);
}

/**
 * Applies a value straight through the DOM, skipping Playwright's actionability check. The editor
 * toolbar re-renders continuously, so a click on it can wait forever for the control to hold still.
 */
export async function selectUiOptionInPage(page: Page, ariaLabel: string, value: string): Promise<void> {
  await page.evaluate((label) => {
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    if (!trigger) throw new Error(`${label} の選択コントロールが見つかりません`);
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
  }, ariaLabel);
  // 選択肢は React が描くので、開いた直後の同じ同期ブロックにはまだ存在しない。
  await page.waitForFunction(({ label, optionValue }) => {
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    const listboxId = trigger?.getAttribute("aria-controls");
    return Boolean(listboxId
      && document.querySelector(`#${listboxId} [role="option"][data-value="${optionValue}"]`));
  }, { label: ariaLabel, optionValue: value });
  await page.evaluate(({ label, optionValue }) => {
    const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    const listboxId = trigger?.getAttribute("aria-controls");
    const option = listboxId
      ? document.querySelector<HTMLElement>(`#${listboxId} [role="option"][data-value="${optionValue}"]`)
      : null;
    if (!option) throw new Error(`${label} の選択肢 ${optionValue} が見つかりません`);
    option.click();
  }, { label: ariaLabel, optionValue: value });
}
