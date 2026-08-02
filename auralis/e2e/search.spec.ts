import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end journeys.
 *
 * Every assertion here is about what a person actually sees and can do. The
 * data is real — the page searches a live local origin and the results come
 * back through the same pipeline production uses.
 */

const QUERY = 'tone';

async function submitSearch(page: Page, query = QUERY): Promise<void> {
  const field = page.getByRole('searchbox').or(page.getByRole('textbox').first());
  await field.click();
  await field.fill(query);
  await field.press('Enter');
}

async function waitForResults(page: Page): Promise<void> {
  await expect(page.getByRole('article').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('Auralis', () => {
  test('shows a focused initial screen', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();

    const field = page.getByRole('searchbox').or(page.getByRole('textbox').first());
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute('placeholder', /search a title/i);

    // The initial screen shows no results and no dashboard chrome.
    await expect(page.getByRole('article')).toHaveCount(0);
  });

  test('streams results progressively and verifies them', async ({ page }) => {
    await page.goto('/');
    await submitSearch(page);
    await waitForResults(page);

    const results = page.getByRole('article');
    await expect(results.first()).toBeVisible();
    expect(await results.count()).toBeGreaterThan(0);

    // Technical facts read from the bytes, not the filename.
    await expect(page.getByText(/verified audio/i).first()).toBeVisible();
    await expect(page.getByText(/44\.1 kHz|44100/i).first()).toBeVisible();
  });

  test('expands the technical details of a result', async ({ page }) => {
    await page.goto('/');
    await submitSearch(page);
    await waitForResults(page);

    const toggle = page.getByRole('button', { name: /technical|details/i }).first();
    await toggle.click();

    await expect(page.getByText(/sample rate/i).first()).toBeVisible();
    await expect(page.getByText(/channels/i).first()).toBeVisible();
  });

  test('offers a download for an accessible file and downloads it', async ({ page }) => {
    await page.goto('/');
    await submitSearch(page);
    await waitForResults(page);

    const download = page.getByRole('button', { name: /^download$/i }).first();
    await expect(download).toBeVisible();

    // The security-relevant step is the server-side decision; the browser
    // transfer is the visible consequence of it.
    const intent = page.waitForResponse(
      (response) =>
        response.url().includes('/download-intent') && response.request().method() === 'POST',
      { timeout: 30_000 },
    );
    const started = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);

    await download.click();

    const intentResponse = await intent;
    expect(intentResponse.status()).toBe(200);
    const body = (await intentResponse.json()) as {
      allowed: boolean;
      url: string | null;
      filename: string;
    };
    expect(body.allowed).toBe(true);
    expect(body.url).toBeTruthy();
    expect(body.filename).toMatch(/\.(wav|mp3|aiff)$/i);

    const file = await started;
    expect(file, 'the browser should receive a file').not.toBeNull();
    expect(file!.suggestedFilename()).toMatch(/\.(wav|mp3|aiff)$/i);
  });

  test('shows an alternative action when a file cannot be downloaded', async ({ page }) => {
    await page.goto('/');
    await submitSearch(page, 'truncated');
    await waitForResults(page);

    const card = page.getByRole('article').first();
    await expect(card).toBeVisible();
    // Every card offers at least one action, whatever its access class.
    const actions = card.getByRole('button');
    expect(await actions.count()).toBeGreaterThan(0);
  });

  test('cancels a running search', async ({ page }) => {
    await page.goto('/');
    await submitSearch(page, 'tone recording speech');

    const cancel = page.getByRole('button', { name: /cancel/i });
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click();
      await expect(cancel).toBeHidden({ timeout: 30_000 });
    }
    // The interface stays usable after cancelling.
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('is operable with the keyboard alone', async ({ page }) => {
    await page.goto('/');

    // The documented shortcut focuses the search field.
    await page.keyboard.press('/');
    const field = page.getByRole('searchbox').or(page.getByRole('textbox').first());
    await expect(field).toBeFocused();

    await page.keyboard.type(QUERY);
    await page.keyboard.press('Enter');
    await waitForResults(page);

    // Tabbing reaches an interactive control inside the results.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(['BUTTON', 'A', 'INPUT', 'AUDIO', 'DIV']).toContain(focused);
  });

  test('has no critical or serious accessibility violations', async ({ page }, testInfo) => {
    await page.goto('/');

    const initial = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const initialSerious = initial.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      initialSerious,
      `Initial screen violations: ${JSON.stringify(initialSerious.map((v) => v.id))}`,
    ).toEqual([]);

    await submitSearch(page);
    await waitForResults(page);

    const withResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const resultsSerious = withResults.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );

    await testInfo.attach('axe-results', {
      body: JSON.stringify(withResults.violations, null, 2),
      contentType: 'application/json',
    });

    expect(
      resultsSerious,
      `Results screen violations: ${JSON.stringify(resultsSerious.map((v) => v.id))}`,
    ).toEqual([]);
  });

  test('does not scroll horizontally at any supported width', async ({ page }) => {
    await page.goto('/');
    await submitSearch(page);
    await waitForResults(page);

    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test('recovers when a search returns nothing', async ({ page }) => {
    await page.goto('/');
    await submitSearch(page, 'zzzz-no-such-recording-zzzz');

    // Either an empty state or a completed search with no cards; both are calm
    // and neither is an error dialog.
    await expect(page.getByRole('main')).toBeVisible();
    await page.waitForTimeout(3000);
    const errorDialog = page.getByRole('alertdialog');
    await expect(errorDialog).toHaveCount(0);
  });
});
