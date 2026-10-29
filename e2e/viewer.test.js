'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { playwright, startApp, launch } = require('./fixture');

describe('viewer', { skip: !playwright && 'playwright is not installed' }, () => {
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
  const openAsset = async (id) => {
    page = await browser.page();
    await page.goto(`${app.base}/?asset=${id}`);
    await page.waitForSelector('#viewer[open] #d-name');
    return page;
  };

  it('steps through results with the keyboard, with a filmstrip and position', async () => {
    page = await browser.page();
    await page.goto(app.base);
    await page.click('#grid .card >> nth=1');
    await page.waitForSelector('#viewer[open]');
    assert.match(await page.textContent('#v-pos'), /^2 of 62/);
    const first = await page.textContent('#d-name');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#v-pos').textContent.startsWith('3 of'));
    assert.notStrictEqual(await page.textContent('#d-name'), first);
    assert.ok(await page.locator('#filmstrip button.current').count() === 1);
    assert.match(new URL(page.url()).search, /asset=/, 'open asset is in the URL');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#viewer').open);
    assert.doesNotMatch(new URL(page.url()).search, /asset=/);
  });

  it('fits tall photos on screen, zooms, and keeps the close button in view', async () => {
    await openAsset('f5'); // 9:16
    await page.waitForFunction(() => document.querySelector('#stage img')?.naturalWidth > 0);
    const fit = await page.evaluate(() => {
      const i = document.querySelector('#stage img').getBoundingClientRect();
      const s = document.getElementById('stage').getBoundingClientRect();
      return i.top >= s.top - 1 && i.bottom <= s.bottom + 1;
    });
    assert.ok(fit, 'whole photo visible');
    await page.click('#z-100');
    assert.match(await page.getAttribute('#stage', 'class'), /zoomed/);
    await page.keyboard.press('z');
    assert.doesNotMatch(await page.getAttribute('#stage', 'class'), /zoomed/);
    const before = await page.locator('#close').boundingBox();
    await page.evaluate(() => { document.querySelector('.details').scrollTop = 5000; });
    assert.deepStrictEqual(await page.locator('#close').boundingBox(), before);
    await page.click('#close');
    await page.waitForFunction(() => !document.querySelector('#viewer').open);
  });

  it('opens on the grid preview, then sharpens, and preloads the next photo', async () => {
    page = await browser.page();
    await page.goto(app.base);
    await page.waitForSelector('#grid .card img');
    const next = await page.locator('#grid .card >> nth=1').getAttribute('data-id');
    await page.click('#grid .card >> nth=0');
    await page.waitForFunction(() => new URL(document.querySelector('#stage img').src).searchParams.get('size') === '2048');
    await page.waitForFunction(() => !document.querySelector('#stage img').classList.contains('soft'));
    await page.waitForTimeout(300);
    assert.ok(app.drive.stats.thumbnails.some((t) => t.id === next && t.size === 2048), 'next photo preloaded');
  });

  it('shows more from the shoot and more like this, and opens "looks like" results', async () => {
    await openAsset('f0');
    await page.waitForSelector('#d-shoot button');
    assert.match(await page.textContent('#d-shoot-all'), /See all \d+/);
    await page.waitForSelector('#d-like button');
    await page.click('#d-like-all');
    await page.waitForSelector('.fchip:has-text("Looks like")');
    assert.match(new URL(page.url()).search, /like=f0/);
  });

  it('plays videos the browser can decode, and switches others to Drive\'s player', async () => {
    if (app.drive.hasVideo) {
      await openAsset('vOk');
      await page.waitForFunction(() => document.querySelector('#stage video')?.readyState >= 1);
      assert.ok(await page.isVisible('#v-player'));
      assert.strictEqual(await page.textContent('#v-player [aria-pressed="true"]'), 'Original');
    }
    await openAsset('vBad');
    await page.waitForSelector('#stage iframe.drive-player');
    assert.strictEqual(await page.getAttribute('#stage iframe', 'src'), 'https://drive.google.com/file/d/vBad/preview');
    assert.match(await page.textContent('#v-note'), /can’t play/);
    // Video requests never ask Drive for more than 8 MB at once.
    for (const { range } of app.drive.stats.media.filter((m) => m.range)) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range);
      assert.ok(end - start < 8 * 1024 * 1024, range);
    }
  });
});
