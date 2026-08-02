import { expect, test, type Page } from '@playwright/test';

/**
 * Automated visual captures.
 *
 * Run with `npx playwright test captures --project=desktop` (and `--project=mobile`).
 * The images land in the repository's `docs/product/screenshots/` and are regenerated rather
 * than hand-curated, so they cannot drift from the real interface.
 */

const OUT = '../docs/product/screenshots';

async function search(page: Page, query: string): Promise<void> {
  const field = page.getByRole('searchbox').or(page.getByRole('textbox').first());
  await field.click();
  await field.fill(query);
  await field.press('Enter');
}

test.describe('captures', () => {
  test('initial screen', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.screenshot({
      path: `${OUT}/${testInfo.project.name}-01-initial.png`,
      fullPage: false,
    });
  });

  test('advanced filters', async ({ page }, testInfo) => {
    await page.goto('/');
    const advanced = page.getByRole('button', { name: /advanced/i }).first();
    if (await advanced.isVisible().catch(() => false)) {
      await advanced.click();
      await page.waitForTimeout(400);
    }
    await page.screenshot({
      path: `${OUT}/${testInfo.project.name}-02-advanced.png`,
      fullPage: false,
    });
  });

  test('active search', async ({ page }, testInfo) => {
    await page.goto('/');
    await search(page, 'tone recording speech archive');
    // Captured while providers are still working, which is the point.
    await page.waitForTimeout(700);
    await page.screenshot({
      path: `${OUT}/${testInfo.project.name}-03-searching.png`,
      fullPage: false,
    });
  });

  test('results', async ({ page }, testInfo) => {
    await page.goto('/');
    await search(page, 'tone');
    await expect(page.getByRole('article').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: `${OUT}/${testInfo.project.name}-04-results.png`,
      fullPage: false,
    });
  });

  test('expanded technical metadata', async ({ page }, testInfo) => {
    await page.goto('/');
    await search(page, 'tone');
    await expect(page.getByRole('article').first()).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole('button', { name: /technical|details/i })
      .first()
      .click();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `${OUT}/${testInfo.project.name}-05-technical.png`,
      fullPage: false,
    });
  });

  test('error state', async ({ page }, testInfo) => {
    await page.goto('/');
    // Restricting the search to a source that is not configured produces the
    // "provider setup required" path rather than an internal error.
    await page.route('**/api/v1/searches', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'provider_unavailable',
            message: 'No sources are available for this search right now.',
            details: {},
            correlationId: '00000000-0000-0000-0000-000000000000',
          },
        }),
      });
    });
    await search(page, 'tone');
    await page.waitForTimeout(900);
    await page.screenshot({
      path: `${OUT}/${testInfo.project.name}-06-error.png`,
      fullPage: false,
    });
  });
});
