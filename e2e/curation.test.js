'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { playwright, startApp, launch } = require('./fixture');

describe('ratings, favorites and collections', { skip: !playwright && 'playwright is not installed' }, () => {
  let app;
  let browser;
  let page;
  before(async () => {
    app = await startApp({ user: { email: 'ana@rux.life', name: 'Ana' } });
    browser = await launch();
    page = await browser.page();
    await page.goto(app.base);
    await page.waitForSelector('#grid .card img');
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });
  const card = (n) => page.locator(`#grid .card >> nth=${n}`);

  it('rates and favorites with the keyboard in the viewer', async () => {
    await card(0).click();
    await page.waitForSelector('#viewer[open]');
    await page.keyboard.press('4');
    await page.waitForFunction(() => document.querySelectorAll('#d-stars button.on').length === 4);
    await page.keyboard.press('f');
    await page.waitForFunction(() => document.querySelector('#d-fav').getAttribute('aria-pressed') === 'true');
    await page.keyboard.press('Escape');
    assert.strictEqual(await card(0).locator('.stars-badge').textContent(), '★★★★');
    assert.match(await card(0).locator('.heart').getAttribute('class'), /\bon\b/);
  });

  it('creates a collection from the viewer and adds a selection to it', async () => {
    await card(0).click();
    await page.click('#d-collect');
    await page.fill('#collect-name', 'Spring launch');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.collect-item:has-text("Spring launch") input:checked');
    await page.click('#collect-close');
    await page.waitForSelector('#d-in .chip:has-text("Spring launch")');
    await page.keyboard.press('Escape');
    for (const n of [3, 1, 2]) await card(n).locator('.pick').click();
    await page.selectOption('#bulk-rate', '5');
    await page.waitForFunction(() => document.querySelectorAll('.stars-badge').length >= 4);
    await page.click('#bulk-collect');
    await page.click('.collect-item:has-text("Spring launch") input');
    await page.waitForFunction(() => document.querySelector('#collect-msg').textContent.startsWith('Added'));
    await page.click('#collect-close');
    await page.click('#bulk-clear');
    assert.match(await page.textContent('#collections'), /Spring launch\s*4/);
  });

  it('opens a collection in the order items were added, and removes from it', async () => {
    const order = await Promise.all([0, 3, 1, 2].map((n) => card(n).getAttribute('data-id')));
    await page.click('#collections button:has-text("Spring launch")');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.startsWith('4 '));
    assert.deepStrictEqual(await page.locator('#grid .card').evaluateAll((cs) => cs.map((c) => c.dataset.id)), order);
    assert.strictEqual(await page.locator('.group-head').count(), 0, 'no month headings in a collection');
    assert.match(await page.textContent('#crumbs'), /Spring launch/);
    assert.match(await page.textContent('#collection-panel'), /made by ana/);
    await card(0).locator('.pick').click();
    await page.click('#bulk-uncollect');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.startsWith('3 '));
  });

  it('lists my favorites and filters and sorts by rating', async () => {
    await page.click('#collections button:has-text("My favorites")');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.startsWith('1 '));
    await page.click('#tree button:has-text("All assets")');
    await page.selectOption('#rating', '5');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.startsWith('3 '));
    assert.match(await page.textContent('#chips'), /★★★★★/);
    await page.selectOption('#rating', '');
    await page.selectOption('#sort', 'rating');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length > 10);
    const stars = await page.locator('#grid .card').evaluateAll((cs) => cs.slice(0, 5).map((c) => c.querySelector('.stars-badge')?.textContent || ''));
    assert.deepStrictEqual(stars, ['★★★★★', '★★★★★', '★★★★★', '★★★★', '']);
  });
});
