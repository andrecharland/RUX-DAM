'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { playwright, startApp, launch, filterBy } = require('./fixture');

describe('design files', { skip: !playwright && 'playwright is not installed' }, () => {
  let app;
  let browser;
  let page;
  before(async () => {
    app = await startApp({ designs: true });
    browser = await launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  it('lists Illustrator and InDesign files, with previews where Drive has them', async () => {
    page = await browser.page();
    await page.goto(app.base);
    await page.waitForSelector('#grid .card');
    await filterBy(page, '#kind', 'design');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.startsWith('2 assets'));
    assert.match(await page.locator('#chips').textContent(), /Type:Design files/);

    const ai = page.locator('.card[data-id="dAi"]');
    assert.strictEqual(await ai.locator('.badge').textContent(), 'AI');
    assert.ok(await ai.evaluate((c) => c.classList.contains('design')));
    assert.strictEqual(await page.locator('.card[data-id="dIndd"] .noprev').textContent(), 'INDD');
    assert.strictEqual(await page.locator('.card[data-id="dIndd"] .badge').count(), 0);

    // The AI file shows Drive's preview in the viewer; the InDesign file Drive's own viewer.
    await ai.click();
    await page.waitForSelector('#stage img.design');
    assert.match(await page.textContent('#v-note'), /AI preview from Google Drive/);
    await page.keyboard.press('Escape');
    await page.click('.card[data-id="dIndd"]');
    await page.waitForSelector('#stage iframe.drive-player');
    assert.match(await page.getAttribute('#stage iframe', 'src'), /drive\.google\.com\/file\/d\/dIndd\/preview/);
    assert.deepStrictEqual(page.errors, []);
  });
});
