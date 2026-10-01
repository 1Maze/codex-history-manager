const { chromium, browserOptions } = require('./test_support.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');

async function run() {
  const browser = await chromium.launch(browserOptions);
  const groups = ['a', 'b', 'c'].map((key, index) => ({
    key, name: ['Alpha', 'Beta', 'Gamma'][index],
    threads: [{ id: 'thread-' + key, title: 'Chat ' + key }],
  }));
  async function routeSidebar(page) {
    await page.route('**/api/sidebar?*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q').toLowerCase();
      const filtered = groups.filter((group) => group.name.toLowerCase().includes(query));
      await route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ groups: filtered, total: filtered.length }) });
    });
  }
  const keys = (page) => page.locator('.project-group').evaluateAll((nodes) => nodes.map((n) => n.dataset.project));
  const grip = (page, key) => page.locator(`.project-group[data-project="${key}"] .project-grip`);
  const heading = (page, key) => page.locator(`.project-group[data-project="${key}"] .project-heading`);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await routeSidebar(page); await page.goto('http://127.0.0.1:5189');
    await page.waitForSelector('.project-group');
    assert.deepEqual(await keys(page), ['a', 'b', 'c']);
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.click('#expand-all-projects');
    await grip(page, 'c').dragTo(heading(page, 'a'), { targetPosition: { x: 60, y: 3 } });
    assert.deepEqual(await keys(page), ['c', 'a', 'b']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('chat-sync-project-order'))), ['c', 'a', 'b']);
    await page.reload(); await page.waitForSelector('.project-group');
    assert.deepEqual(await keys(page), ['c', 'a', 'b']);
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.click('#expand-all-projects');
    await page.evaluate(() => { state.sync = { id: 'thread-b' }; renderChatTree(); });
    await grip(page, 'c').focus(); await grip(page, 'c').press('ArrowDown');
    assert.deepEqual(await keys(page), ['a', 'c', 'b']);
    assert.equal(await page.locator('.chat-item.selected').getAttribute('data-thread-id'), 'thread-b');
    await grip(page, 'c').press('ArrowUp');
    assert.deepEqual(await keys(page), ['c', 'a', 'b']);
    const start = await grip(page, 'a').boundingBox(), end = await heading(page, 'b').boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down(); await page.mouse.move(end.x + 60, end.y + 3, { steps: 8 });
    assert.equal(await page.evaluate(() => local.projectDrag.active), true);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await keys(page), ['c', 'a', 'b']);
    assert.equal(await page.locator('.dragging, .drop-before, .drop-after').count(), 0);
    await grip(page, 'c').dragTo(heading(page, 'b'), { targetPosition: { x: 60, y: 31 } });
    assert.deepEqual(await keys(page), ['a', 'b', 'c']);
    await page.fill('#chat-search', 'Beta');
    await page.waitForFunction(() => local.sidebarQuery === 'Beta');
    assert.equal(await grip(page, 'b').isDisabled(), true);
    await page.fill('#chat-search', '');
    await page.waitForFunction(() => local.sidebarQuery === '');
    assert.deepEqual(await keys(page), ['a', 'b', 'c']);
    groups.push({ key: 'd', name: 'Delta', threads: [] });
    await page.click('#refresh-chats'); await page.waitForFunction(() => local.groups.length === 4);
    assert.deepEqual(await keys(page), ['a', 'b', 'c', 'd']);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'project-sorting-desktop.png') });
    assert.deepEqual(errors, []);
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const touch = await touchContext.newPage();
    touch.on('pageerror', (e) => errors.push(e.message));
    await routeSidebar(touch); await touch.goto('http://127.0.0.1:5189');
    await touch.waitForSelector('.project-grip');
    const source = await grip(touch, 'a').boundingBox(), target = await heading(touch, 'c').boundingBox();
    const cdp = await touchContext.newCDPSession(touch);
    const x = source.x + source.width / 2, y = source.y + source.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
        touchPoints: [{ x: x + (target.x + 60 - x) * step / 8, y: y + (target.y + 3 - y) * step / 8 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.deepEqual(await keys(touch), ['b', 'a', 'c', 'd']);
    assert.equal(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: mouse/touch drag, before/after insertion, keyboard sorting, Escape cancel, selection retention, reload persistence, search guard, new groups.');
    await touchContext.close();
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
