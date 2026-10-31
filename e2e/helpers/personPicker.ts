import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Pick someone in a searchable `<PersonPicker>` (#1437): type part of the name,
 * wait for the server's page to list them, click their option. Typing the name
 * rather than scrolling keeps the step independent of how many people the
 * test database holds.
 */
export async function pickPerson(scope: Page | Locator, testId: string, person: { id: string; fullName: string }) {
  await scope.getByTestId(`${testId}-input`).fill(person.fullName);
  const option = scope.getByTestId(`${testId}-option-${person.id}`);
  await expect(option).toBeVisible({ timeout: 20_000 });
  await option.click();
  await expect(scope.getByTestId(`${testId}-input`)).toHaveValue(person.fullName);
}
