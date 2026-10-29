import { test, expect } from '@playwright/test';
import { gotoSettled } from './helpers/auth';

// The public ROI calculator (#1755): no account, no e-mail, the result computed
// in the browser through computeRoi() (src/lib/roi.ts) with our published price
// on the cost side. The scenario is the one scripts/test/roi.test.mjs pins:
// 50 interns, 10% → 20% conversion, 5 coordinator hours a week at €40.

test('a visitor fills the calculator and gets the total and the price', async ({ page }) => {
  await gotoSettled(page, '/roi-calculator');
  const result = page.getByTestId('roi-calc-result');
  // Nothing we have no evidence for is pre-filled: the result says what is missing.
  await expect(page.getByTestId('roi-calc-missing')).toBeVisible();
  await expect(page.getByTestId('roi-calc-net')).toHaveCount(0);

  await page.getByTestId('roi-calc-input-internsPerYear').fill('50');
  await page.getByTestId('roi-calc-input-currentConversion').fill('10');
  await page.getByTestId('roi-calc-input-targetConversion').fill('20');
  await page.getByTestId('roi-calc-input-coordinatorHoursPerWeek').fill('5');
  await page.getByTestId('roi-calc-input-coordinatorHourCost').fill('40');

  await expect(page.getByTestId('roi-calc-missing')).toHaveCount(0);
  await expect(result.getByTestId('roi-calc-hires')).toHaveText('5');
  await expect(result.getByTestId('roi-calc-hours')).toHaveText('230');
  // 5 x €18,000 + 230 h x €40 − €1,788 (Program, yearly) = €97,412.
  await expect(result.getByTestId('roi-calc-cost')).toContainText('1,788');
  await expect(result.getByTestId('roi-calc-net')).toContainText('97,412');
  await expect(page.getByTestId('roi-calc-plan')).toContainText('Program');
  await expect(page.getByTestId('roi-calc-pricing-link')).toHaveAttribute('href', '/pricing');
  await expect(page.getByTestId('roi-calc-steps')).toContainText('9000000 + 920000 = 9920000');
});
