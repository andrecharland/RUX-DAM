'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { playwright, startApp, launch, filterBy } = require('./fixture');

describe('browsing and search', { skip: !playwright && 'playwright is not installed' }, () => {
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
  const text = (sel) => page.textContent(sel);

  it('shows shoots newest first, month groups and sized, versioned previews', async () => {
    await fresh();
    assert.strictEqual(await text('#folder-cards h2'), 'Shoots, newest first');
    const cards = await page.locator('.fcard strong').allTextContents();
    assert.deepStrictEqual(cards.slice(0, 2), ['Nested shoot', 'Bralorne Meager 10.26']);
    assert.match(await page.locator('.fcard').first().textContent(), /in 1 - IMAGES/);
    assert.match(await page.locator('.group-head').first().textContent(), /November 2026/);
    const src = await page.locator('#grid .card img').first().getAttribute('src');
    assert.match(src, /\/thumbnail\?size=(256|512|1024|2048)&v=\w+$/);
    assert.deepStrictEqual(page.errors, []);
  });

  it('records tile colors and shows them behind tiles on the next visit', async () => {
    await fresh();
    await page.waitForFunction(() => document.querySelectorAll('#grid img').length > 5);
    const id = await page.locator('#grid .card').first().getAttribute('data-id');
    await page.waitForFunction(() => document.querySelector('#grid img').naturalWidth > 0);
    for (let i = 0; i < 50 && !app.library.colors.get(id); i++) await page.waitForTimeout(200);
    assert.match(app.library.colors.get(id) || '', /^#[0-9a-f]{6}$/);
    await page.reload();
    await page.waitForSelector('#grid .card');
    assert.match(await page.locator('#grid .card').first().getAttribute('style'), /background-color: #[0-9a-f]{6}/);
  });

  it('switches folder cards to the folder tree and remembers it', async () => {
    await fresh();
    await page.click('.fview button:has-text("By folder")');
    assert.strictEqual(await text('#folder-cards h2'), 'Folders in Photo/Video');
    await page.reload();
    await page.waitForSelector('#grid .card');
    assert.strictEqual(await text('.fview [aria-pressed="true"]'), 'By folder');
    await page.click('.fview button:has-text("By date")');
  });

  it('searches the latest text even while a slower search is running, and on Enter', async () => {
    await fresh();
    await page.type('#q', 'sea', { delay: 40 });
    await page.waitForTimeout(450);
    await page.type('#q', ' otter', { delay: 40 });
    await page.waitForFunction(() => document.querySelector('#chips')?.textContent.includes('sea otter'));
    assert.match(new URL(page.url()).search, /q=sea\+otter/);
    await page.fill('#q', 'IMG_7001');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'IMG_7001');
  });

  it('adds photos that look like a description after the text matches', async () => {
    await fresh();
    await page.fill('#q', 'snowy ride');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.group-head:has-text("Looks like")');
    assert.strictEqual(await page.getAttribute('#q', 'placeholder'), 'Search names, tags, or describe a photo…');
  });

  it('shows filters as chips, removes them, and keeps the view in the URL', async () => {
    await fresh();
    await filterBy(page, '#kind', 'video');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.startsWith('2 '));
    await filterBy(page, '#rights', 'cleared');
    await page.waitForSelector('.fchip:has-text("Rights")');
    assert.strictEqual(await page.textContent('#filter-count'), '2', 'active choices on the Filter & sort button');
    assert.ok(await page.isHidden('#folder-cards'), 'folder cards hide while filtering');
    await page.reload();
    await page.waitForSelector('.fchip:has-text("Videos")');
    assert.strictEqual(await page.inputValue('#kind'), 'video');
    await page.click('#chips button:has-text("Clear all")');
    await page.waitForFunction(() => !document.querySelector('.fchip'));
    assert.match(await text('#meta'), /^62 assets/);
  });

  it('folds sidebar sections, finds folders, and narrows long filter lists', async () => {
    // 13 colors, so the Color filter gets a find box.
    await fetch(`${app.base}/api/tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'], add: { color: [
        'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Navy', 'Purple', 'Pink', 'Brown', 'Black', 'White', 'Olive'] } }) });
    await fresh();
    await page.click('.side-sec[data-sec="folders"] .sec-toggle');
    assert.ok(await page.isHidden('#tree'));
    await page.reload();
    await page.waitForSelector('#grid .card');
    assert.ok(await page.isHidden('#tree'), 'remembered');
    await page.click('.side-sec[data-sec="folders"] .sec-toggle');
    await page.fill('#tree-filter', 'nested');
    await page.waitForFunction(() => document.querySelector('#tree').textContent.includes('Nested shoot'));
    assert.match(await page.textContent('#tree'), /1 - IMAGES/, 'with the folders above it');
    assert.doesNotMatch(await page.textContent('#tree'), /Sea Otter/);
    await page.fill('#tree-filter', '');
    const color = page.locator('.facet:has(h3:text-is("Color"))');
    await color.locator('.side-filter').fill('pu');
    assert.deepStrictEqual(await color.locator('label:visible span:first-of-type').allTextContents(), ['Purple']);
  });

  it('has keyboard shortcuts: / to search, ? to list them', async () => {
    await fresh();
    await page.keyboard.press('/');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'q');
    await page.locator('#q').blur();
    await page.keyboard.press('?');
    await page.waitForSelector('#shortcuts[open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#shortcuts').open);
  });

  it('jumps to a year and resizes tiles with the slider', async () => {
    await fresh();
    await page.click('#scrubber button:has-text("2024")');
    await page.waitForSelector('.group[data-key="2024-06"]');
    const before = await page.locator('.card').first().evaluate((c) => c.getBoundingClientRect().height);
    await page.locator('#size').fill('320');
    await page.locator('#size').dispatchEvent('change');
    const after = await page.locator('.card').first().evaluate((c) => c.getBoundingClientRect().height);
    assert.ok(after > before + 50, `${before} -> ${after}`);
  });
});

describe('thumbnails that fail', { skip: !playwright && 'playwright is not installed' }, () => {
  it('retries once, then shows a plain tile instead of a broken image', async () => {
    const app = await startApp({ failThumbnails: new Set(['f5']) });
    const browser = await launch();
    try {
      const page = await browser.page({ viewport: { width: 1440, height: 5000 } });
      await page.goto(app.base);
      await page.waitForFunction(() => document.querySelector('[data-id="f5"] img')?.classList.contains('failed'), null, { timeout: 8000 });
      const loaded = await page.evaluate(() => [...document.querySelectorAll('#grid img')].filter((i) => i.naturalWidth > 0).length);
      assert.ok(loaded >= 55, `${loaded} previews loaded`);
      assert.strictEqual(app.drive.stats.thumbnails.filter((t) => t.id === 'f5').length, 2, 'asked twice, then gave up');
    } finally {
      await browser.close();
      await app.close();
    }
  });
});
