import { expect, type Locator } from "@playwright/test";

/** 要素の中心が画面の上で実際に押せる (ほかの要素に覆われていない)。 */
export async function expectHittable(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const reached = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  });
  expect(reached).toBe(true);
}
