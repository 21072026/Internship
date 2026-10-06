import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('PR CI runs the accessibility scan outside the smoke grep', { tag: '@smoke' }, () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/e2e.yml'), 'utf8');
  const scan = fs.readFileSync(path.join(process.cwd(), 'e2e/a11y-scan.spec.ts'), 'utf8');
  const smokeIndex = workflow.indexOf('- name: Run E2E tests');
  const gateIndex = workflow.indexOf('- name: Accessibility regression gate');
  const uploadIndex = workflow.indexOf('- name: Upload Playwright report');

  expect(smokeIndex).toBeGreaterThan(-1);
  expect(gateIndex).toBeGreaterThan(smokeIndex);
  expect(uploadIndex).toBeGreaterThan(gateIndex);

  const smokeStep = workflow.slice(smokeIndex, gateIndex);
  const gateStep = workflow.slice(gateIndex, uploadIndex);
  expect(smokeStep).toContain('npx playwright test --grep "$E2E_GREP"');
  // The gate is its own matrix row (#2811), so it is skipped on a manual grep
  // AND on every smoke shard — but never on the a11y row of a normal run.
  expect(gateStep).toContain("if: ${{ matrix.suite == 'a11y' && !inputs.grep }}");
  expect(workflow).toMatch(/- \{ label: 'a11y', suite: a11y/);
  // The required check is the aggregator over the matrix, and it must wait
  // for the a11y row like any shard.
  expect(workflow).toMatch(/\n    name: Playwright smoke\n    needs: \[changes, e2e\]/);
  expect(gateStep).toContain('npx playwright test e2e/a11y-scan.spec.ts');
  expect(gateStep).not.toContain('A11Y_UPDATE_BASELINE');
  expect(scan).toMatch(/console\.warn\([\s\S]*WIDENS/);
  expect(scan).toContain('renderReport(collected, widened)');
});
