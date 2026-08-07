import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Destructive actions are gated by the in-app `ConfirmDialog`, not by the
 * browser's native `confirm()` (#1071).
 *
 * WHY THIS EXISTS: a spec that registers `page.on('dialog', d => d.accept())`
 * and then clicks a Delete button now waits for an event that never fires. The
 * dialog it opens is ordinary DOM, so the click is swallowed silently and the
 * row is still there — the failure surfaces later, as "the thing I deleted is
 * still in the list", with nothing on screen explaining why. That is exactly how
 * `delete-confirm`, `goal-templates`, `goals-archive-sort` and `todos` broke in
 * the scheduled full run.
 *
 * Use these helpers rather than reaching for the test ids directly, so the next
 * change to the dialog is a one-line fix here.
 */
export function confirmDialog(page: Page): Locator {
  return page.getByTestId('confirm-dialog');
}

/** Wait for the confirm dialog and press its confirm button. */
export async function acceptConfirmDialog(page: Page) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('confirm-dialog-confirm').click();
  await expect(dialog).toHaveCount(0);
}

/** Wait for the confirm dialog and press its cancel button. */
export async function cancelConfirmDialog(page: Page) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('confirm-dialog-cancel').click();
  await expect(dialog).toHaveCount(0);
}
