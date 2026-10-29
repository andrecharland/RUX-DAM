'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { playwright, startApp, launch } = require('./fixture');

describe('tags, titles and Claude suggestions', { skip: !playwright && 'playwright is not installed' }, () => {
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

  it('folds folder details away, adds folder tags, and gives the folder a title', async () => {
    page = await browser.page();
    await page.goto(`${app.base}/?folder=fB`);
    await page.waitForSelector('#folder-tags:not([hidden])');
    assert.ok(await page.isHidden('#ft-body'), 'collapsed at first');
    await page.click('#folder-add-tag');
    assert.ok(await page.isVisible('#ft-body'), '+ Add tag opens it');
    await page.selectOption('#folder-editor select', 'product');
    await page.fill('#folder-editor .add-row input', 'Gear Box 70L');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#folder-editor .chip:has-text("Gear Box 70L")');
    // A Product alone is an everyday tag: the folder keeps its Drive name.
    assert.match(await page.textContent('#crumbs'), /Roof rack v2/);
    await page.selectOption('#folder-editor select', 'shoot_date');
    assert.strictEqual(await page.getAttribute('#folder-editor .add-row input', 'type'), 'date');
    await page.fill('#folder-editor .add-row input', '2026-09-12');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#folder-editor .chip:has-text("2026-09-12")');
    await page.click('#folder-editor button:has-text("Done")');
    assert.ok(await page.isHidden('#folder-editor .add-row'));
    // A naming-only field (here Shoot date) gives the folder a title and a RUX_ name.
    await page.waitForFunction(() => document.querySelector('#crumbs').textContent.includes('Gear Box 70L · Sep 12, 2026'));
    assert.match(await page.textContent('#folder-label'), /RUX_GearBox70L_2026-09-12/);
    assert.match(await page.textContent('#ft-summary'), /2 tags/);
    // Everything inside inherits the tag.
    await page.click('#grid .card >> nth=0');
    await page.waitForSelector('#d-tags .chip.inherited:has-text("Gear Box 70L")');
  });

  it('fills naming fields from file details', async () => {
    page = await browser.page();
    await page.goto(`${app.base}/?asset=f2`);
    await page.waitForSelector('#d-label button:has-text("Add a RUX file name")');
    const drive = await page.textContent('#d-name');
    await page.click('#d-label button:has-text("Add a RUX file name")');
    await page.waitForFunction((name) => document.querySelector('#d-name').textContent !== name, drive);
    assert.match(await page.textContent('#d-name'), /Photo/);
    assert.match(await page.textContent('#d-label'), /Drive name: IMG_7002\.jpg/);
  });

  it('adds tags in the viewer, keeping the add row open from photo to photo', async () => {
    page = await browser.page();
    await page.goto(`${app.base}/?asset=f10`);
    await page.waitForSelector('#viewer[open]');
    assert.ok(await page.isHidden('#d-tags .add-row'));
    await page.click('#d-add-tag');
    await page.selectOption('#d-tags select', 'color');
    await page.fill('#d-tags .add-row input', 'Blue');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#d-tags .chip:has-text("Blue")');
    const name = await page.textContent('#d-name');
    await page.click('#d-name'); // focus back in the viewer, out of the input
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((n) => document.querySelector('#d-name').textContent !== n, name);
    assert.strictEqual(await page.locator('#d-tags .chip:has-text("Blue")').count(), 0, 'next photo');
    assert.ok(await page.isVisible('#d-tags .add-row'), 'still open');
  });

  it('asks Claude, shows suggestions to review, and accepts them', async () => {
    page = await browser.page();
    await page.goto(`${app.base}/?asset=f20`);
    await page.waitForSelector('#d-ask:not([hidden])');
    assert.strictEqual(await page.textContent('#d-ask'), '✨ Suggest tags');
    assert.strictEqual(await page.locator('#d-suggest > *').count(), 0, 'no box before asking');
    await page.click('#d-ask');
    await page.waitForSelector('#d-suggest .chip.suggested:has-text("Gear Box 70L")');
    await page.click('#d-suggest button:has-text("Accept all")');
    await page.waitForSelector('#d-tags .chip:has-text("Bikepacking")');
    await page.waitForFunction(() => !document.querySelector('#d-suggest').children.length);
    assert.strictEqual(await page.textContent('#d-ask'), '✨ Ask Claude again');
  });
});
