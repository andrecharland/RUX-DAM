'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { playwright, startApp, launch } = require('./fixture');

// A one-finger swipe on `selector` by (dx, dy), as touch events.
const swipe = (page, selector, dx, dy) => page.evaluate(({ selector, dx, dy }) => {
  const target = document.querySelector(selector);
  const box = target.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + Math.min(box.height / 2, 60);
  const touch = (cx, cy) => new Touch({ identifier: 1, target, clientX: cx, clientY: cy });
  target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x, y)], changedTouches: [touch(x, y)] }));
  target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(x + dx, y + dy)] }));
}, { selector, dx, dy });

describe('on a phone', { skip: !playwright && 'playwright is not installed' }, () => {
  let app;
  let browser;
  let page;
  before(async () => {
    app = await startApp();
    browser = await launch();
    page = await browser.page({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await page.goto(app.base);
    await page.waitForSelector('#grid .card img');
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });
  const sheetOpen = () => page.getAttribute('#sheet-toggle', 'aria-expanded');

  it('opens the viewer full screen with details peeking from the bottom', async () => {
    await page.locator('#grid .card').nth(0).click();
    await page.waitForSelector('#viewer[open]');
    const box = await page.locator('#viewer').boundingBox();
    assert.deepStrictEqual([box.width, box.height], [390, 844]);
    assert.strictEqual(await sheetOpen(), 'false');
    const details = await page.locator('#details').boundingBox();
    assert.ok(details.y > 844 - 200, 'only the top of the sheet shows');
    assert.ok(await page.isVisible('#d-name'));
  });

  it('swipes between photos', async () => {
    assert.match(await page.textContent('#v-pos'), /^1 of/);
    await swipe(page, '#stage', -120, 5);
    await page.waitForFunction(() => document.querySelector('#v-pos').textContent.startsWith('2 of'));
    await swipe(page, '#stage', 120, 5);
    await page.waitForFunction(() => document.querySelector('#v-pos').textContent.startsWith('1 of'));
  });

  it('opens the details sheet with the handle or a swipe up, closes it with a swipe down', async () => {
    await page.click('#sheet-toggle');
    assert.strictEqual(await sheetOpen(), 'true');
    await swipe(page, '#details', 0, 150);
    await page.waitForFunction(() => document.querySelector('#sheet-toggle').getAttribute('aria-expanded') === 'false');
    await swipe(page, '#stage', 0, -150);
    await page.waitForFunction(() => document.querySelector('#sheet-toggle').getAttribute('aria-expanded') === 'true');
    await page.waitForTimeout(300); // the slide
    const details = await page.locator('#details').boundingBox();
    assert.ok(details.y < 200, 'sheet is up');
    assert.deepStrictEqual(page.errors, []);
  });
});
