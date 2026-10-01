const { chromium, browserOptions } = require('./test_support.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');

async function run() {
  const browser = await chromium.launch(browserOptions);
  const groups = [
    { key: 'large', name: 'Large', threads: Array.from({ length: 12 }, (_, i) => ({ id: `thread-${i}`, title: `对话 ${i + 1}` })) },
    { key: 'small', name: 'Small', threads: [{ id: 'small-one', title: '少量对话' }] },
  ];
  const pageCalls = [];
  let delay = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('chat-sync-expanded-projects', '["large","small"]'));
    await page.route('**/api/sidebar**', async (route) => {
      const url = new URL(route.request().url()), query = url.searchParams.get('q') || '';
      const filtered = groups.map((group) => ({ ...group, threads: group.threads.filter((row) =>
        !query || row.title.includes(query) || group.name.includes(query)) })).filter((group) => group.threads.length);
      if (url.pathname.endsWith('/group')) {
        const group = filtered.find((item) => item.key === url.searchParams.get('key'));
        const offset = Number(url.searchParams.get('offset'));
        pageCalls.push(offset);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const rows = group.threads.slice(offset, offset + 5);
        await route.fulfill({ contentType: 'application/json',
          body: JSON.stringify({ key: group.key, rows, total: group.threads.length, nextOffset: offset + rows.length }) });
      } else {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          total: filtered.reduce((n, group) => n + group.threads.length, 0),
          groups: filtered.map((group) => ({ ...group, total: group.threads.length,
            threads: group.threads.slice(0, 5), nextOffset: Math.min(group.threads.length, 5) })),
        }) });
      }
    });
    await page.goto('http://127.0.0.1:5189'); await page.waitForSelector('.project-toggle');
    assert.equal(await page.locator('.chat-item').count(), 0);
    assert.deepEqual(pageCalls, []);
    await page.click('#expand-all-projects');
    assert.equal(await page.locator('.chat-item').count(), 6);
    assert.deepEqual(pageCalls, []);
    const large = page.locator('.project-group[data-project="large"]');
    delay = 200;
    await large.locator('.project-more').click();
    assert.equal(await large.locator('.project-more').isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('[data-project="large"]').querySelectorAll('.chat-item').length === 10);
    delay = 0;
    await large.locator('.project-more').click();
    await page.waitForFunction(() => document.querySelector('[data-project="large"]').querySelectorAll('.chat-item').length === 12);
    assert.deepEqual(pageCalls, [5, 10]);
    assert.equal(await large.locator('.project-more').count(), 0);
    await large.locator('.project-less').click();
    assert.equal(await large.locator('.chat-item').count(), 5);
    await large.locator('.project-more').click();
    assert.equal(await large.locator('.chat-item').count(), 10);
    assert.deepEqual(pageCalls, [5, 10]);
    await page.click('#collapse-all-projects');
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.click('#expand-all-projects');
    assert.equal(await large.locator('.chat-item').count(), 5);
    await page.reload(); await page.waitForSelector('.project-toggle');
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.click('#expand-all-projects');
    delay = 200;
    await large.locator('.project-more').click();
    await page.click('#collapse-all-projects');
    await page.waitForFunction(() => local.loadingProjects.size === 0);
    await page.click('#expand-all-projects');
    assert.equal(await large.locator('.chat-item').count(), 5);
    await page.fill('#chat-search', '对话 12');
    await page.waitForFunction(() => local.sidebarQuery === '对话 12');
    assert.equal(await page.locator('.chat-item').count(), 1);
    await page.click('#collapse-all-projects');
    assert.equal(await page.locator('.chat-item').count(), 0);
    await page.click('#expand-all-projects');
    assert.equal(await page.locator('.chat-item').count(), 1);
    await page.fill('#chat-search', '');
    await page.waitForFunction(() => local.sidebarQuery === '');
    await page.click('#expand-all-projects');
    await page.screenshot({ path: path.join(__dirname, 'qa', 'sidebar-five-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(__dirname, 'qa', 'sidebar-five-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: default collapsed despite old settings, global controls, first five, lazy batches, cache reuse, collapse reset, in-flight collapse, search, reload, mobile.');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
