'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { playwright, startApp, launch } = require('./fixture');

describe('exploring: color, similar trails, the visual map', { skip: !playwright && 'playwright is not installed' }, () => {
  let app;
  let browser;
  let page;
  before(async () => {
    app = await startApp();
    browser = await launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });
  const fresh = async (path = '/') => {
    page = await browser.page();
    await page.goto(app.base + path);
    await page.waitForSelector('#grid .card');
    return page;
  };

  it('browses by color from the sidebar and from a photo’s palette', async () => {
    await fresh();
    await page.click('#swatches [aria-label="Blue"]');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.startsWith('21 assets'));
    assert.strictEqual(await page.locator('.group-head h2').first().textContent(), 'Blue photos');
    assert.match(await page.locator('#chips').textContent(), /Color:Blue/);
    assert.match(page.url(), /color=%232f62b8/);
    assert.strictEqual(await page.getAttribute('#swatches [aria-label="Blue"]', 'aria-pressed'), 'true');

    // In the viewer, a palette color browses by that color.
    await page.locator('#grid .card').first().click();
    await page.waitForSelector('#d-palette .swatch');
    assert.strictEqual(await page.locator('#d-palette .swatch').count(), 2);
    await page.locator('#d-palette .swatch').nth(1).click();
    await page.waitForFunction(() => /Color:Black/.test(document.querySelector('#chips').textContent));
    assert.strictEqual(await page.locator('#viewer').evaluate((d) => d.open), false);
    assert.deepStrictEqual(page.errors, []);
  });

  it('follows a trail of similar photos and steers it with words', async () => {
    await fresh();
    const first = page.locator('#grid .card').first();
    const name = await first.getAttribute('aria-label');
    await first.hover();
    await first.locator('.like-btn').click();
    await page.waitForSelector('#explore:not([hidden]) .trail-step');
    assert.match(await page.locator('.group-head h2').first().textContent(), new RegExp(`Looks like ${name}`));
    assert.strictEqual(await page.locator('.trail-step').count(), 1);

    // A second pick extends the trail; the first step takes you back.
    const next = page.locator('#grid .card').nth(2);
    await next.hover();
    await next.locator('.like-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.trail-step').length === 2);
    assert.match(page.url(), /like=[^&]+%2C/);

    await page.fill('.refine-form input', 'less snow');
    await page.press('.refine-form input', 'Enter');
    await page.waitForSelector('.fchip.word.less');
    assert.match(await page.locator('.group-head h2').first().textContent(), /less snow/);
    assert.match(page.url(), /less=snow/);

    await page.click('.trail-step >> nth=0');
    await page.waitForFunction(() => document.querySelectorAll('.trail-step').length === 1);
    await page.click('#explore .link');
    await page.waitForSelector('#explore', { state: 'hidden' });
    assert.ok(!page.url().includes('like='));
    assert.deepStrictEqual(page.errors, []);
  });

  it('shows the visual map, and a click opens the photo', async () => {
    await fresh();
    await page.waitForSelector('#view-switch:not([hidden])');
    await page.click('#view-switch [data-view="map"]');
    await page.waitForFunction(() => /arranged by look/.test(document.querySelector('#map-status').textContent), null, { timeout: 30000 });
    assert.ok(await page.locator('.grid-wrap').isHidden());
    assert.match(page.url(), /view=map/);
    // Squares are drawn: the canvas isn't blank.
    const painted = await page.evaluate(() => {
      const c = document.querySelector('#map-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
      return false;
    });
    assert.ok(painted);
    // Zoom in until photos load, then open the one in the middle.
    for (let i = 0; i < 4; i++) await page.click('#map-in');
    await page.focus('#map-canvas');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#viewer').open);
    await page.keyboard.press('Escape');

    // Filters apply to the map too; the view survives a reload.
    await page.click('#swatches [aria-label="Blue"]');
    await page.waitForFunction(() => /^21 photos/.test(document.querySelector('#map-status').textContent));
    await page.reload();
    await page.waitForFunction(() => /^21 photos/.test(document.querySelector('#map-status').textContent), null, { timeout: 30000 });
    await page.click('#view-switch [data-view=""]');
    assert.ok(await page.locator('#map-view').isHidden());
    assert.deepStrictEqual(page.errors, []);
  });
});
